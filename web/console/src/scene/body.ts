import type { Target } from "../store/live";
import type { Camera } from "./devices";
import { type Bone, feet, type Figure, KEYPOINT_MIN, LIMBS, type Vec3 } from "./pose";

/**
 * 按摄像头位姿重建三维人形（人员三维建模优化调研 P0）：每个可见关键点是一条从镜头出发的视线，
 * 自脚点起沿骨骼链逐段求关节——子关节在其视线上、与父关节相距标准骨长（1.70 m 人员）乘画面尺度倍数（见 scaleOf），
 * 结果再缩回标准体型，所有人同一体型（G-04）。
 * 视线与以父关节为心的球面一般有前后两个交点，从镜头看去两者重合在同一像素上，按先验取其一：
 * 直立时躯干、腿向上，手臂取深度变化最小的解；躺倒时骨段贴近水平；地面以下的解不取。双肩、双髋不按骨长求，
 * 按画面中肩宽与躯干之比估计侧转角，深度前后按身体朝向分左右（见 across）。
 * 直立与躺倒两种假设各重建一次，取误差小的一种：误差为视线与骨长不吻合的距离、关节低于地面的深度，
 * 以及躯干偏离假设姿态（直立为竖直、躺倒为水平）的程度。陡峭俯视（视线俯角约 50° 以上）时，
 * 头朝远处躺倒的人画面中肩在髋上方，按画面平面会被竖起来，按视线只有贴地的解合乎姿态。
 * 视线俯角约 40°～45° 时，直立 1.5 m 与贴地 1.7 m 在画面中重合，单帧几何无法区分：此时按 down
 * （该轨迹正处于跌倒告警）取躺倒，否则按画面中躯干是否直立取舍。跌倒告警在站起后仍保持约 60 s，
 * 这段时间里落在这一视角的站立者仍会画成躺倒。
 *
 * 坐姿：腿被挡而躯干直立时，视觉引擎按站立髋高推算脚点（footing.py）。人若坐着，髋部其实低得多、离镜头更远，
 * 按这个脚点估出的画面尺度倍数明显小于 1（髋高 0.45 m 对 0.92 m，约 0.65 倍），站着则接近 1：倍数低于 SEATED_SCALE
 * 即按坐姿重建——髋部沿视线落到 SEATED_HIP_M 高处，大腿沿身体朝向水平伸出、小腿垂到地面。这一判据依赖安装高度大致正确
 * （未标定的摄像头由自动标定写回，auto_pose.py）。
 *
 * 摄像头位姿是人工摆放的近似值，与地面标定得到的脚点可能不一致：先把脚点像素的视线转到恰好指向脚点，
 * 其余视线一并旋转，局部抵消朝向与俯角误差。结果以脚点为原点，与 figure 相同的场景坐标（x、高度、平面 y）。
 * 肩或髋全看不清、镜头在地面以下或脚点视线朝上时返回 null，由调用方退回画面平面人形。
 */

/** 画面宽高比：与 pose.ts 一致，按常见监控码流 16:9 */
const ASPECT = 16 / 9;
/** 标准骨长（米）：髋半宽、大腿、小腿、躯干（髋中到肩中）、肩半宽、上臂、前臂、肩中到头部 */
const L = { hip: 0.1, thigh: 0.42, shin: 0.42, torso: 0.5, shoulder: 0.19, upper: 0.3, fore: 0.26, head: 0.22 };
/** 正对镜头时双肩、双髋的画面间距与躯干画面长度之比（肩宽 0.38、髋宽 0.20、躯干 0.50）：见 across */
const FRONT_RATIO = { shoulder: 0.76, hip: 0.4 };
/** 双肩、双髋离中点不超过半宽的此倍数：见 across */
const WIDE = 1.5;
/** 画面尺度倍数的范围：见 scaleOf */
const SCALE_RANGE = [0.5, 2] as const;
/** 脚踝离地高度（米）：脚踝视线与此高度的水平面求交 */
const ANKLE_M = 0.08;
/** 标准人员站立时髋中离地高度（米） */
const HIP_M = 0.92;
/** 躺倒假设下髋部离地高度（米）：脚踝看不见时髋部视线与此高度求交 */
const LYING_HIP_M = 0.15;
/** 以运动方向为身体朝向的最低速度（米每秒）：慢于此多为原地转身，按画面判断 */
const WALK_MPS = 0.5;
/** 判断正反面的双肩画面间距下限：占躯干画面长度的比例，侧身时两肩重叠不足以判断 */
const FRONTAL_RATIO = 0.35;
/** 两种假设的误差（米）相差不到此值时，按画面中躯干是否直立取舍：免得近似相等时来回翻转 */
const TIE_M = 0.15;
/** 两种假设几乎同样吻合（米）：单帧几何无法区分，跌倒告警中的轨迹取躺倒；只比 TIE_M 严，免得站起的人被放倒 */
const DEGENERATE_M = 0.05;
/** 躯干相对假设姿态的自由倾角（弧度）：弯腰、侧卧撑起在此内不计误差 */
const TILT_FREE = (35 * Math.PI) / 180;
/** 直立时髋部偏离双脚上方的自由距离（米）：迈步、下蹲时髋部前后移动在此内 */
const OVER_FEET_M = 0.25;
/** 躺倒时肩中离双脚的最小水平距离（米）：屈膝侧卧约 1 m，伸直约 1.3 m */
const LYING_SPAN_M = 0.9;
/** 坐姿髋部离地高度（米）：常见办公椅座高 0.42～0.48 */
const SEATED_HIP_M = 0.45;
/** 腿被挡、躯干直立时，画面尺度倍数低于此值按坐姿：站立约 1，坐姿约 0.65（见 body 的说明），取两者之间 */
const SEATED_SCALE = 0.82;
/** 回差：上一帧已是坐姿时，尺度倍数要超过此值才改回站姿；关键点逐帧抖动不至于让人形在坐、站之间来回翻 */
const STAND_SCALE = 0.95;
/** 腿可见时判定坐姿：大腿在画面中的竖直落差不到躯干画面长度的此比例（大腿接近水平） */
const SEATED_THIGH_RATIO = 0.35;
/** 躯干与颈部半径（米）：与 pose.ts 一致 */
const R = { torso: 0.13, neck: 0.045 };
const HEAD = [0, 1, 2, 3, 4];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addk = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n === 0 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
};
const UP: Vec3 = [0, 1, 0];

/** 把 a 转到 b 的旋转（罗德里格斯公式），作用于向量 */
function rotation(a: Vec3, b: Vec3): (v: Vec3) => Vec3 {
  const axis = cross(a, b);
  const s = norm(axis);
  const c = dot(a, b);
  if (s < 1e-9) return (v) => v;
  const k = unit(axis);
  const angle = Math.atan2(s, c);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return (v) => addk(addk(addk([0, 0, 0], v, cos), cross(k, v), sin), k, dot(k, v) * (1 - cos));
}

/**
 * 摄像头：镜头位置与画面归一化坐标到视线方向（场景坐标 x、高度、平面 y）。画面右方取平面 (−sin yaw, cos yaw)：
 * 场景按俯视 x 向右、y 向下呈现（平面 (x, y) → 场景 (x, 0, y)），与摄像头视角（layout.ts cameraShot）、facing、
 * 视觉引擎按安装参数估算地面映射（geometry.py from_pose：朝向 90° 时画面右侧为 −x）一致；取反则人形左右颠倒
 */
function lens(pose: Camera["pose"]) {
  const [yaw, pitch] = [(pose.yaw_deg * Math.PI) / 180, (pose.pitch_deg * Math.PI) / 180];
  const forward: Vec3 = [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
  const right: Vec3 = [-Math.sin(yaw), 0, Math.cos(yaw)];
  const up = cross(right, forward);
  const tanH = Math.tan((pose.hfov_deg * Math.PI) / 360);
  const tanV = tanH / ASPECT;
  return {
    eye: [pose.x, pose.height_m, pose.y] as Vec3,
    right,
    ray: (u: number, v: number): Vec3 => unit(addk(addk(forward, right, (2 * u - 1) * tanH), up, (1 - 2 * v) * tanV)),
  };
}

type Prior = (from: Vec3, a: Vec3, b: Vec3) => Vec3;

/** 一种假设的重建：误差（已除以尺度倍数，两种假设可比）见 body 的说明；scale 为求解所用的画面尺度倍数 */
interface Build {
  joints: (Vec3 | null)[];
  inferred: boolean[];
  error: number;
  scale: number;
}

/**
 * 由画面关键点重建三维人形；at 为脚点（平面坐标，米）。heading 为平滑后的运动方向（弧度，平面 (cos, sin)），
 * speed 为平面速度，均可为 null。down 为该轨迹正处于跌倒告警（视觉引擎的判定）。
 */
export function body(
  keypoints: Target["keypoints"],
  bbox: Target["bbox"],
  pose: Camera["pose"],
  at: [number, number],
  heading: number | null,
  speed: number | null,
  down = false,
  wasSeated = false,
): Figure | null {
  if (!keypoints || pose.height_m <= 0) return null;
  const seen = keypoints.map(([, , score = 0]) => score >= KEYPOINT_MIN);
  const px = (indices: number[]): [number, number] | null => {
    const shown = indices.filter((i) => seen[i]);
    if (shown.length === 0) return null;
    const pick = (k: 0 | 1) => shown.reduce((sum, i) => sum + (keypoints[i]?.[k] ?? 0), 0) / shown.length;
    return [pick(0), pick(1)];
  };
  const [shoulderPx, hipPx] = [px([5, 6]), px([11, 12])];
  if (!shoulderPx || !hipPx) return null;

  // 对准脚点的像素与其场景位置，与视觉引擎取脚点的方式一致（footing.py）：脚踝可见时为脚踝中点（离地 ANKLE_M）；
  // 脚踝被挡而躯干直立时由髋向下推算，髋中对准脚点正上方 HIP_M（桌后只见上半身）；否则为检测框底边中点（地面）
  const cam = lens(pose);
  const anklePx = px([15, 16]);
  const looksUpright = hipPx[1] - shoulderPx[1] > Math.abs(shoulderPx[0] - hipPx[0]) * ASPECT;
  const [footPx, footHeight]: [[number, number], number] = anklePx
    ? [anklePx, ANKLE_M]
    : looksUpright
      ? [hipPx, HIP_M]
      : [[((bbox[0] ?? 0) + (bbox[2] ?? 0)) / 2, bbox[3] ?? 0], 0];
  const aim: Vec3 = [at[0], footHeight, at[1]];
  const foot: Vec3 = [at[0], anklePx ? ANKLE_M : 0, at[1]];
  const toFoot = sub(aim, cam.eye);
  const footRay = cam.ray(...footPx);
  if (footRay[1] >= 0 || toFoot[1] >= 0) return null;
  const fix = rotation(footRay, unit(toFoot));
  const ray = (p: [number, number]) => fix(cam.ray(p[0], p[1]));
  const rays = keypoints.map(([u = 0, v = 0], i) => (seen[i] ? ray([u, v]) : null));

  // 身体朝向：走动时为运动方向；否则按双肩左右次序判断正对或背对镜头，侧身时按鼻子在肩中的哪一侧
  const toCamera = unit([cam.eye[0] - at[0], 0, cam.eye[2] - at[1]]);
  const torsoPx = Math.hypot((shoulderPx[0] - hipPx[0]) * ASPECT, shoulderPx[1] - hipPx[1]);
  let front: Vec3 = toCamera;
  if (heading !== null && (speed ?? 0) >= WALK_MPS) front = [Math.cos(heading), 0, Math.sin(heading)];
  else if (seen[5] && seen[6] && Math.abs(((keypoints[5]?.[0] ?? 0) - (keypoints[6]?.[0] ?? 0)) * ASPECT) > FRONTAL_RATIO * torsoPx)
    front = (keypoints[5]?.[0] ?? 0) > (keypoints[6]?.[0] ?? 0) ? toCamera : addk([0, 0, 0], toCamera, -1);
  else if (seen[0]) {
    const side = unit([cam.right[0], 0, cam.right[2]]);
    front = (keypoints[0]?.[0] ?? 0) > shoulderPx[0] ? side : addk([0, 0, 0], side, -1);
  }
  const left: Vec3 = cross(UP, front); // 朝向 front 时人体的左侧：平面 (sin, −cos)；正对镜头时即 lens 的画面右方
  // 侧转角：双肩（看不清时双髋）画面间距与躯干画面长度之比，相对正对镜头时的比值；与画面尺度、人员高矮无关
  const spread = (a: number, b: number) =>
    seen[a] && seen[b] ? Math.hypot(((keypoints[a]?.[0] ?? 0) - (keypoints[b]?.[0] ?? 0)) * ASPECT, (keypoints[a]?.[1] ?? 0) - (keypoints[b]?.[1] ?? 0)) : null;
  const shoulderSpread = spread(5, 6);
  const hipSpread = spread(11, 12);
  const ratio =
    shoulderSpread !== null ? shoulderSpread / FRONT_RATIO.shoulder : hipSpread !== null ? hipSpread / FRONT_RATIO.hip : torsoPx;
  const turn = torsoPx > 0 ? Math.acos(Math.min(1, ratio / torsoPx)) : 0;

  // 坐姿：腿被挡时按画面尺度判断（见 body 的说明）；大腿可见且接近水平、脚踝看不见时同样按坐姿
  const legsHidden = ![13, 14, 15, 16].some((i) => seen[i]);
  const kneePx = px([13, 14]);
  const thighFlat = kneePx !== null && !anklePx && Math.abs(kneePx[1] - hipPx[1]) < SEATED_THIGH_RATIO * (hipPx[1] - shoulderPx[1]);
  if (looksUpright && !down && !anklePx && (thighFlat || (legsHidden && scaleOf(rays, cam.eye, foot, true) < (wasSeated ? STAND_SCALE : SEATED_SCALE)))) {
    const hipRay = ray(hipPx);
    if (hipRay[1] < 0 && cam.eye[1] > SEATED_HIP_M) {
      const hip = addk(cam.eye, hipRay, (SEATED_HIP_M - cam.eye[1]) / hipRay[1]);
      const ground: Vec3 = [hip[0], 0, hip[2]];
      const seat = build(rays, ray, cam.eye, ground, hipPx, shoulderPx, left, turn, scaleOf(rays, cam.eye, ground, true), true);
      fold(seat, front);
      return { ...toFigure(seat, false, front, foot), seated: true };
    }
  }

  const upright = build(rays, ray, cam.eye, foot, hipPx, shoulderPx, left, turn, scaleOf(rays, cam.eye, foot, true), true);
  const lying = build(rays, ray, cam.eye, foot, hipPx, shoulderPx, left, turn, scaleOf(rays, cam.eye, foot, false), false);
  // 画面中躯干直立（竖直分量大于水平分量）用于两种假设误差相近时取舍
  const gap = Math.abs(upright.error - lying.error);
  // 腿全看不清而画面中躯干直立、画面尺度又不像坐着：多是矮墙、柜台后站着的人，按直立呈现（D-057）
  const chosen =
    legsHidden && looksUpright && !down
      ? upright
      : down && gap < DEGENERATE_M
      ? lying
      : gap < TIE_M
        ? looksUpright
          ? upright
          : lying
        : upright.error < lying.error
          ? upright
          : lying;
  return toFigure(chosen, anklePx !== null, front);
}

function build(
  rays: (Vec3 | null)[],
  ray: (p: [number, number]) => Vec3,
  eye: Vec3,
  foot: Vec3,
  hipPx: [number, number],
  shoulderPx: [number, number],
  left: Vec3,
  turn: number,
  scale: number,
  upright: boolean,
): Build {
  const joints: (Vec3 | null)[] = rays.map(() => null);
  const inferred = rays.map(() => false);
  let error = 0;
  const len = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v * scale])) as typeof L;
  const [OVER_FEET, LYING_SPAN, LYING_HIP] = [OVER_FEET_M, LYING_SPAN_M, LYING_HIP_M].map((v) => v * scale) as [number, number, number];
  // 先验：在两个交点中取骨段方向与之更接近的一个；躺倒时取更水平的一个
  const toward =
    (direction: Vec3): Prior =>
    (from, a, b) =>
      dot(unit(sub(a, from)), direction) >= dot(unit(sub(b, from)), direction) ? a : b;
  const flat: Prior = (from, a, b) => (Math.abs(unit(sub(a, from))[1]) <= Math.abs(unit(sub(b, from))[1]) ? a : b);
  const [rise, hang] = upright ? [toward(UP), toward([0, -1, 0])] : [flat, flat];
  // 手臂：直立时活动范围大，取深度变化最小的解（画面中举手即举手）；躺倒时贴地
  const side = (k: number): Prior => toward(addk([0, 0, 0], left, k));
  const level: Prior = (from, a, b) => {
    const depth = norm(sub(from, eye));
    return Math.abs(norm(sub(a, eye)) - depth) <= Math.abs(norm(sub(b, eye)) - depth) ? a : b;
  };

  /** 视线 d 上与 from 相距 length 的点；视线够不着时取视线上最近点方向上的 length 处，差距计入误差 */
  const reach = (from: Vec3, d: Vec3, length: number, prior: Prior): Vec3 => {
    const rel = sub(from, eye);
    const b = dot(d, rel);
    const disc = b * b - (dot(rel, rel) - length * length);
    if (disc < 0) {
      const closest = addk(eye, d, b);
      error += norm(sub(closest, from)) - length;
      return addk(from, unit(sub(closest, from)), length);
    }
    const root = Math.sqrt(disc);
    const [near, far] = [addk(eye, d, b - root), addk(eye, d, b + root)];
    if (b - root <= 0) return far; // 镜头后方的解不可能
    if ((near[1] < 0) !== (far[1] < 0)) return near[1] < 0 ? far : near; // 地面以下的解不可能
    return prior(from, near, far);
  };
  /**
   * 双肩、双髋 i：与中点相距半宽 width，其中沿视线方向（深度）的分量按侧转角 turn 取 width·sin(turn)，
   * 前后两种取法按身体左右（k 为 1 取人体左侧）择一；画面内分量照画面，不按骨长强求，画面尺度与标准体型不符时不会被"转"进深度
   */
  const across = (i: number, center: Vec3, width: number, k: number) => {
    const d = rays[i];
    inferred[i] = !d;
    if (!d) return (joints[i] = addk(center, left, k * width));
    const view = unit(sub(center, eye));
    const depth = dot(sub(center, eye), view);
    const facing = dot(d, view);
    const at = (s: number) => addk(eye, d, (depth + s * width * Math.sin(turn)) / facing);
    const picked = side(k)(center, at(1), at(-1));
    // 画面中显得过宽（人员贴近镜头只入镜一部分、尺度倍数到了限定边界）时按 WIDE 倍半宽截断，方向不变
    const offset = sub(picked, center);
    const wide = WIDE * width;
    joints[i] = norm(offset) > wide ? addk(center, unit(offset), wide) : picked;
    return joints[i];
  };
  /** 关节 i：可见时在其视线上求解，否则沿先验方向按骨长推测 */
  const joint = (i: number, from: Vec3, length: number, prior: Prior, fallback: Vec3) => {
    const d = rays[i];
    joints[i] = d ? reach(from, d, length, prior) : addk(from, unit(fallback), length);
    inferred[i] = !d;
    return joints[i] as Vec3;
  };
  // 躺倒时头朝前方（front），腿朝后：front = left × UP，故后方为 UP × left
  const down: Vec3 = upright ? [0, -1, 0] : unit(cross(UP, left));

  // 髋中：脚踝可见时自脚点（脚踝中点）沿腿向上两段求得；否则直立时取髋部视线上与脚点同一水平距离处，躺倒时取贴地处
  const hipRay = ray(hipPx);
  let hip: Vec3;
  if (foot[1] > 0) {
    const kneeRay = rays[13] && rays[14] ? unit(addk(rays[13], rays[14])) : (rays[13] ?? rays[14]);
    const knee = kneeRay ? reach(foot, kneeRay, len.shin, rise) : null;
    hip = knee ? reach(knee, hipRay, len.thigh, rise) : reach(foot, hipRay, len.thigh + len.shin, rise);
  } else if (upright) {
    const range = Math.hypot(foot[0] - eye[0], foot[2] - eye[2]);
    const horizontal = Math.hypot(hipRay[0], hipRay[2]);
    hip = addk(eye, hipRay, horizontal > 1e-6 ? range / horizontal : 0);
  } else {
    hip = hipRay[1] < 0 ? addk(eye, hipRay, (LYING_HIP - eye[1]) / hipRay[1]) : addk(foot, UP, LYING_HIP);
  }

  // 双髋与双腿
  for (const [h, k, a, s] of [
    [11, 13, 15, 1],
    [12, 14, 16, -1],
  ] as const) {
    const hipJoint = across(h, hip, len.hip, s);
    const knee = joint(k, hipJoint, len.thigh, upright ? hang : flat, down);
    joint(a, knee, len.shin, upright ? hang : flat, down);
  }
  // 躯干、双肩与双臂
  const shoulders = reach(hip, ray(shoulderPx), len.torso, rise);
  const torsoDir = unit(sub(shoulders, hip));
  // 姿态是否合乎假设：直立时躯干偏离竖直、躺倒时偏离水平超过 TILT_FREE 的部分按弧度乘躯干长计入误差。
  // 两个交点都满足骨长时（俯拍下常见），只有这一项区分"贴地躺着"与"朝镜头斜着立起"
  const tilt = Math.acos(Math.min(1, Math.abs(torsoDir[1])));
  error += len.torso * Math.max(0, (upright ? tilt : Math.PI / 2 - tilt) - TILT_FREE);
  // 直立时髋部应大致在双脚上方（站、走、蹲）；脚踝可见而髋部水平偏出 OVER_FEET_M 以上，多是把贴地的腿误当成斜立
  if (upright && foot[1] > 0) error += 2 * Math.max(0, Math.hypot(hip[0] - foot[0], hip[2] - foot[2]) - OVER_FEET);
  // 躺倒时肩部应离双脚有一段水平距离；肩在脚边多是把站立者折叠成贴地
  if (!upright && foot[1] > 0)
    error += 2 * Math.max(0, LYING_SPAN - Math.hypot(shoulders[0] - foot[0], shoulders[2] - foot[2]));
  for (const [sh, el, wr, s] of [
    [5, 7, 9, 1],
    [6, 8, 10, -1],
  ] as const) {
    const shoulder = across(sh, shoulders, len.shoulder, s);
    const elbow = joint(el, shoulder, len.upper, upright ? level : flat, addk([0, 0, 0], torsoDir, -1));
    joint(wr, elbow, len.fore, upright ? level : flat, addk([0, 0, 0], torsoDir, -1));
  }
  // 头部：可见的头部关键点合成一条视线；否则沿躯干方向在肩中上方
  const headRays = HEAD.flatMap((i) => (rays[i] ? [rays[i]] : []));
  const headRay = headRays.length ? unit(headRays.reduce((sum, d) => addk(sum, d), [0, 0, 0] as Vec3)) : null;
  joints[0] = headRay ? reach(shoulders, headRay, len.head, toward(torsoDir)) : addk(shoulders, torsoDir, len.head);
  inferred[0] = !headRay;
  joints[17] = shoulders;
  joints[18] = hip;
  // 低于地面的关节计入误差：躺倒在地的人只有贴地的解，直立假设会把腿压到地下
  for (const p of joints) if (p && p[1] < 0) error += -p[1];
  return { joints, inferred, error: error / scale, scale };
}

/** 估计画面尺度用的骨段：两端关键点与标准长度（米）。只取躯干与腿：手臂活动范围大、关键点抖动也大，会把倍数估高 */
const SPANS: (readonly [number, number, number])[] = [
  [5, 6, 0.38],
  [11, 12, 0.2],
  [5, 11, 0.5],
  [6, 12, 0.5],
  [11, 13, 0.42],
  [12, 14, 0.42],
  [13, 15, 0.42],
  [14, 16, 0.42],
];

/**
 * 画面尺度相对标准体型的倍数：各可见骨段的视角乘以该段离镜头的距离，与标准长度之比取最大，限定在 SCALE_RANGE。
 * 透视缩短只会让骨段显短，只要有一段大致垂直于视线，最大值就接近真实倍数。离镜头的距离按假设取：直立时为骨段中点视线
 * 在脚点正上方处，躺倒时为其与离地 LYING_HIP_M 的水平面的交点（近处的人头部比脚近得多，不能都按脚点的距离）。
 * 人员高矮、摄像头高度与位置的误差都体现为这一倍数：按它缩放骨长求解，否则画面中显小的人会被"转"进深度方向。
 * 结果再缩回标准体型，不呈现个人身高（G-04）
 */
function scaleOf(rays: (Vec3 | null)[], eye: Vec3, foot: Vec3, upright: boolean): number {
  const range = Math.hypot(foot[0] - eye[0], foot[2] - eye[2]);
  const distance = (d: Vec3) => {
    if (upright) {
      const horizontal = Math.hypot(d[0], d[2]);
      return horizontal > 1e-6 ? range / horizontal : range;
    }
    return d[1] < 0 ? (LYING_HIP_M - eye[1]) / d[1] : range;
  };
  let best = 0;
  for (const [a, b, length] of SPANS) {
    const [p, q] = [rays[a], rays[b]];
    if (!p || !q) continue;
    best = Math.max(best, (Math.acos(Math.min(1, dot(p, q))) * distance(unit(addk(p, q)))) / length);
  }
  return best > 0 ? Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], best)) : 1;
}

/** 坐姿的腿：自双髋沿身体朝向水平伸出大腿，小腿垂直落地；都是推测（画面中被挡或只见大腿） */
function fold(seat: Build, front: Vec3) {
  const forward = unit([front[0], 0, front[2]]);
  for (const [h, k, a] of [
    [11, 13, 15],
    [12, 14, 16],
  ] as const) {
    const hip = seat.joints[h];
    if (!hip) continue;
    const knee = addk(hip, forward, L.thigh * seat.scale);
    seat.joints[k] = knee;
    seat.joints[a] = addk(knee, [0, -1, 0], L.shin * seat.scale);
    seat.inferred[k] = seat.inferred[a] = true;
  }
}

/**
 * 平移到脚点为原点（脚踝可见时为脚踝中点，否则为髋中正下方）并落地：最低关节贴地；front 为身体朝向，定脚尖方向。
 * origin 给出时以它为原点：坐姿的髋部比视觉引擎推算的脚点更远，人形按实际位置相对脚点偏移
 */
function toFigure({ joints, inferred, scale }: Build, ankles: boolean, front: Vec3, origin?: Vec3): Figure {
  const get = (i: number) => joints[i] as Vec3;
  const anchor = origin ?? (ankles ? addk(get(15), sub(get(16), get(15)), 0.5) : get(18));
  const lowest = Math.min(...joints.flatMap((p) => (p ? [p[1]] : [])));
  const shift: Vec3 = [-anchor[0], -lowest, -anchor[2]];
  // 缩回标准体型；按 origin 平移的人形，水平偏移保持实际距离（不随体型缩放）
  const place = (p: Vec3): Vec3 => {
    const q = addk(p, shift);
    if (!origin) return addk([0, 0, 0], q, 1 / scale);
    const center: Vec3 = [get(18)[0] + shift[0], 0, get(18)[2] + shift[2]];
    return addk(center, sub(q, center), 1 / scale);
  };
  const shoulders = place(get(17));
  const head = place(get(0));
  const bones: Bone[] = [
    // 躯干零件的左右：右肩 → 左肩
    { from: shoulders, to: place(get(18)), radius: R.torso, inferred: false, part: "torso", side: sub(get(5), get(6)) },
    { from: shoulders, to: head, radius: R.neck, inferred: Boolean(inferred[0]), part: "neck" },
    ...LIMBS.map(([a, b, radius, part]) => ({
      from: place(get(a)),
      to: place(get(b)),
      radius,
      inferred: Boolean(inferred[a] || inferred[b]),
      part,
    })),
  ];
  bones.push(...feet(bones, front));
  return { bones, head: { at: head, inferred: Boolean(inferred[0]) } };
}
