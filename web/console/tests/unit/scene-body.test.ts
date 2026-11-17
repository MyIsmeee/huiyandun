import { describe, expect, it } from "vitest";
import { body, isUpright, seatedByScale } from "../../src/scene/body";
import { cameraShot, sceneView } from "../../src/scene/layout";
import { facing, figure, type Figure, type Vec3 } from "../../src/scene/pose";

type Pose = { x: number; y: number; height_m: number; yaw_deg: number; pitch_deg: number; hfov_deg: number; range_m: number };
const ASPECT = 16 / 9;

/**
 * 1.70 m 人员的三维关节（米）：人体坐标 [向左, 向上, 向前]，COCO 17 点顺序；骨长与 body.ts 的标准骨长一致
 * （髋半宽 0.10、大小腿各 0.42、躯干 0.50、肩半宽 0.19、上臂 0.30、前臂 0.26、肩中到鼻 0.22）
 */
const STANDING: Vec3[] = [
  [0, 1.64, 0.05],
  [0.03, 1.68, 0.04],
  [-0.03, 1.68, 0.04],
  [0.07, 1.66, 0],
  [-0.07, 1.66, 0],
  [0.19, 1.42, 0],
  [-0.19, 1.42, 0],
  [0.19, 1.12, 0],
  [-0.19, 1.12, 0],
  [0.19, 0.86, 0],
  [-0.19, 0.86, 0],
  [0.1, 0.92, 0],
  [-0.1, 0.92, 0],
  [0.1, 0.5, 0],
  [-0.1, 0.5, 0],
  [0.1, 0.08, 0],
  [-0.1, 0.08, 0],
];

/** 人体坐标转场景坐标：脚点 at，面向 front（平面方向，弧度）；lying 时绕左右轴向后放倒、贴地 */
function place(points: Vec3[], at: [number, number], front: number, lying = false): Vec3[] {
  const [fx, fz] = [Math.cos(front), Math.sin(front)];
  const leftDir: [number, number] = [fz, -fx]; // 人体左侧：平面 (sin, −cos)，俯视 x 向右、y 向下（与 body.ts 一致）
  return points.map(([l, u, f]) => {
    // 躺倒：头朝前方，原来的"向上"变为"向前"，贴地高度取原来的"向前"分量 + 0.1
    const [up, forward] = lying ? [0.1 + f, u] : [u, f];
    return [at[0] + leftDir[0] * l + fx * forward, up, at[1] + leftDir[1] * l + fz * forward];
  });
}

/** 与 body.ts 相同的针孔模型（画面右方为平面 (−sin yaw, cos yaw)）把场景点投影到画面归一化坐标 */
function project(pose: Pose, p: Vec3): [number, number] {
  const [yaw, pitch] = [(pose.yaw_deg * Math.PI) / 180, (pose.pitch_deg * Math.PI) / 180];
  const f: Vec3 = [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
  const r: Vec3 = [-Math.sin(yaw), 0, Math.cos(yaw)];
  const up: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const d: Vec3 = [p[0] - pose.x, p[1] - pose.height_m, p[2] - pose.y];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = dot(d, f);
  const tanH = Math.tan((pose.hfov_deg * Math.PI) / 360);
  return [(dot(d, r) / z / tanH + 1) / 2, (1 - dot(d, up) / z / (tanH / ASPECT)) / 2];
}

function view(pose: Pose, joints: Vec3[], hidden: number[] = []) {
  const keypoints = joints.map((p, i) => [...project(pose, p), hidden.includes(i) ? 0 : 0.9]);
  const us = keypoints.map(([u = 0]) => u);
  const vs = keypoints.map(([, v = 0]) => v);
  return { keypoints, bbox: [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)] };
}

const length = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const heights = (f: Figure | null) => f?.bones.flatMap((b) => [b.from[1], b.to[1]]) ?? [];
/** 骨段次序同 pose.ts：躯干、颈部、双肩、双髋、左上臂、左前臂、右上臂、右前臂、左大腿、左小腿、右大腿、右小腿 */
const [SHOULDERS, LEFT_THIGH] = [2, 8];

/** 摄像头在原点、高 3 m、看向 +x、俯角 30° */
const WALL: Pose = { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
/** 高位俯拍：高 6 m、俯角 70° */
const HIGH: Pose = { x: 0, y: 0, height_m: 6, yaw_deg: 0, pitch_deg: -70, hfov_deg: 90, range_m: 15 };
const AT: [number, number] = [5, 0];
/** 高位摄像头近处：视线俯角约 65° */
const NEAR: [number, number] = [2.5, 0];
const TOWARD_CAMERA = Math.PI;

describe("body", () => {
  it("正对摄像头站立：骨长为标准值，脚踝落地，头部约 1.6 m", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA));
    const f = body(keypoints, bbox, WALL, AT, null, null);

    expect(f).not.toBeNull();
    expect(Math.min(...heights(f))).toBeCloseTo(0, 5);
    expect(f?.head.at[1]).toBeCloseTo(1.64 - 0.08, 1);
    const torso = f?.bones[0];
    expect(torso && length(torso.from, torso.to)).toBeCloseTo(0.5, 2);
    const thigh = f?.bones[LEFT_THIGH];
    expect(thigh && length(thigh.from, thigh.to)).toBeCloseTo(0.42, 2);
  });

  it("侧身走过：双肩沿视线方向前后分开（有深度），不再挤在一个平面上", () => {
    // 沿 +y 走（垂直于视线），肩线与视线（+x）平行
    const front = Math.PI / 2;
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, front));
    const f = body(keypoints, bbox, WALL, AT, front, 1.2);
    const line = f?.bones[SHOULDERS];
    const depth = Math.abs((line?.to[0] ?? 0) - (line?.from[0] ?? 0));

    expect(depth).toBeGreaterThan(0.3); // 肩宽 0.38 m 主要落在视线方向（场景 x）
    // COCO 左肩在人体左侧：俯视 x 向右、y 向下，朝 +y 走时左侧为 +x
    expect((line?.from[0] ?? 0) - (line?.to[0] ?? 0)).toBeGreaterThan(0);
  });

  it("背对摄像头：按双肩左右次序判断，左肩在人体左侧", () => {
    const away = 0;
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, away));
    const f = body(keypoints, bbox, WALL, AT, null, null);
    const line = f?.bones[SHOULDERS];

    // 朝 +x 时人体左侧为平面 −y（俯视 y 向下）：COCO 左肩（from）的平面 y 小于右肩
    expect((line?.to[2] ?? 0) - (line?.from[2] ?? 0)).toBeGreaterThan(0.3);
  });

  for (const [name, pose, at, front] of [
    ["正对摄像头倒地", WALL, AT, TOWARD_CAMERA],
    ["陡峭俯视下头朝远处躺倒（画面中肩在髋上方）", HIGH, NEAR, 0],
    ["俯拍下横向躺倒", HIGH, AT, Math.PI / 2],
  ] as const) {
    it(`${name}：有跌倒判定时人形贴地，不被竖起来；没有跌倒判定时按直立`, () => {
      const { keypoints, bbox } = view(pose, place(STANDING, at, front, true));
      const f = body(keypoints, bbox, pose, at, null, null, true);

      expect(f).not.toBeNull();
      expect(Math.max(...heights(f))).toBeLessThan(0.5);
      // 躺倒只跟随视觉引擎的跌倒判定：没有判定时不用三维重建，由调用方按画面绘制（关键点残缺时按误差取躺倒，
      // 会把站着的人画倒，cam-05 实测）
      expect(body(keypoints, bbox, pose, at, null, null)).toBeNull();
    });
  }

  it("视线俯角约 41° 时头朝远处躺倒与站立在画面中重合：按跌倒告警取躺倒", () => {
    const { keypoints, bbox } = view(HIGH, place(STANDING, AT, 0, true));

    expect(Math.max(...heights(body(keypoints, bbox, HIGH, AT, null, null)))).toBeGreaterThan(1); // 单帧无法区分
    expect(Math.max(...heights(body(keypoints, bbox, HIGH, AT, null, null, true)))).toBeLessThan(0.5);
  });

  for (const at of [AT, NEAR]) {
    it(`俯拍站立（距摄像头 ${at[0]} m）：仍为直立人形，跌倒告警的提示不把站着的人放倒`, () => {
      const { keypoints, bbox } = view(HIGH, place(STANDING, at, TOWARD_CAMERA));

      expect(body(keypoints, bbox, HIGH, at, null, null)?.head.at[1]).toBeGreaterThan(1.3);
      if (at === NEAR) expect(body(keypoints, bbox, HIGH, at, null, null, true)?.head.at[1]).toBeGreaterThan(1.3);
    });
  }

  it("俯拍站立：仍为直立人形", () => {
    const { keypoints, bbox } = view(HIGH, place(STANDING, AT, TOWARD_CAMERA));
    const f = body(keypoints, bbox, HIGH, AT, null, null);

    expect(f?.head.at[1]).toBeGreaterThan(1.3);
  });

  for (const [name, pose, at] of [
    ["平视", WALL, AT],
    ["陡峭俯视", HIGH, NEAR],
  ] as const) {
    it(`${name}下蹲：不被放倒，髋部低于站立`, () => {
      // 膝前移、髋后坐，大小腿各约 0.42 m，躯干前倾
      const squat = STANDING.map(([l, u, f], i): Vec3 => {
        if (i === 13 || i === 14) return [l, 0.4, 0.27];
        if (i === 11 || i === 12) return [l, 0.45, -0.15];
        if (i >= 5 && i <= 10) return [l, u - 0.5, f + 0.1];
        if (i <= 4) return [l, u - 0.5, f + 0.15];
        return [l, u, f];
      });
      const { keypoints, bbox } = view(pose, place(squat, at, TOWARD_CAMERA));
      const f = body(keypoints, bbox, pose, at, null, null);
      const hip = f?.bones[0]?.to;

      // 膝的前后两个解在画面中重合，先验取偏高者：髋部高度只能近似（平视约 0.7 m，真值约 0.37 m），但明显低于站立的 0.84 m
      expect(hip?.[1]).toBeLessThan(0.8);
      expect(f?.head.at[1]).toBeGreaterThan(0.9);
      expect(f?.head.at[1]).toBeLessThan(1.35);
    });
  }

  it("摄像头位姿有偏差：以脚点为准，人形仍直立、骨长不变", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA));
    const off = { ...WALL, yaw_deg: 8, pitch_deg: -24 };
    const f = body(keypoints, bbox, off, AT, null, null);

    expect(f?.head.at[1]).toBeCloseTo(1.56, 0);
    const torso = f?.bones[0];
    expect(torso && length(torso.from, torso.to)).toBeCloseTo(0.5, 2);
  });

  it("举手：手腕高过头顶（画面中举起即三维中举起，不被当成向前伸）", () => {
    const raised = STANDING.map(([l, u, f], i): Vec3 => (i === 7 || i === 8 ? [l, 1.72, f] : i === 9 || i === 10 ? [l, 1.98, f] : [l, u, f]));
    const { keypoints, bbox } = view(WALL, place(raised, AT, TOWARD_CAMERA));
    const f = body(keypoints, bbox, WALL, AT, null, null);
    const wrist = f?.bones[5]?.to;

    expect(wrist?.[1]).toBeGreaterThan((f?.head.at[1] ?? Number.POSITIVE_INFINITY) + 0.1);
  });

  describe("手臂前后（视线上两个解按人体结构取舍）", () => {
    const arms = (edit: Record<number, Vec3>) => STANDING.map((p, i): Vec3 => edit[i] ?? p);
    const REACH = arms({ 7: [0.19, 1.42, 0.3], 8: [-0.19, 1.42, 0.3], 9: [0.19, 1.42, 0.56], 10: [-0.19, 1.42, 0.56] });
    const PHONE = arms({ 9: [0.19, 1.12, 0.26], 10: [-0.19, 1.12, 0.26] });
    const SWING = arms({ 7: [0.19, 1.14, -0.1], 8: [-0.19, 1.14, -0.1], 9: [0.19, 0.9, -0.19], 10: [-0.19, 0.9, -0.19] });
    /** 左手腕（第 5 段终点）相对左肩沿身体朝向 front 的前后距离与高低 */
    const wrist = (joints: Vec3[], front: number, heading: number | null = null) => {
      const { keypoints, bbox } = view(WALL, place(joints, AT, front));
      const f = body(keypoints, bbox, WALL, AT, heading, heading === null ? null : 1.2);
      const [shoulder, hand]: [Vec3, Vec3] = [f?.bones[2]?.from ?? [0, 0, 0], f?.bones[5]?.to ?? [0, 0, 0]];
      return { ahead: (hand[0] - shoulder[0]) * Math.cos(front) + (hand[2] - shoulder[2]) * Math.sin(front), height: hand[1] - shoulder[1] };
    };

    it("正对镜头向前平伸：手在身前、与肩同高（原先取离镜头更远的解，画成向身后下方）", () => {
      const { ahead, height } = wrist(REACH, TOWARD_CAMERA);
      expect(ahead).toBeCloseTo(0.56, 1);
      expect(height).toBeCloseTo(0, 1);
    });

    it("背对镜头向前平伸、正对镜头端着手机：手都在身前", () => {
      expect(wrist(REACH, 0).ahead).toBeCloseTo(0.56, 1);
      expect(wrist(PHONE, TOWARD_CAMERA).ahead).toBeCloseTo(0.26, 1);
      expect(wrist(PHONE, TOWARD_CAMERA, TOWARD_CAMERA).ahead).toBeCloseTo(0.26, 1); // 走动中看手机
    });

    it("走动时手臂向后摆：仍在身后，不被翻到身前", () => {
      const { ahead, height } = wrist(SWING, TOWARD_CAMERA, TOWARD_CAMERA);
      expect(ahead).toBeCloseTo(-0.19, 1);
      expect(height).toBeCloseTo(0.9 - 1.42, 1);
    });
  });

  it("双脚：自脚踝沿身体朝向伸出 0.19 m，贴地；走动时随运动方向", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA));
    const facing = body(keypoints, bbox, WALL, AT, null, null);
    const walking = body(keypoints, bbox, WALL, AT, Math.PI / 2, 1.2); // 朝平面 +y 走

    for (const [f, dx, dz] of [
      [facing, -0.19, 0], // 正对摄像头：朝 −x
      [walking, 0, 0.19],
    ] as const) {
      const feet = f?.bones.filter((b) => b.part === "foot") ?? [];
      expect(feet).toHaveLength(2);
      for (const foot of feet) {
        expect(length(foot.from, foot.to)).toBeCloseTo(0.19, 2);
        expect(foot.to[0] - foot.from[0]).toBeCloseTo(dx, 1);
        expect(foot.to[2] - foot.from[2]).toBeCloseTo(dz, 1);
        expect(foot.to[1]).toBeCloseTo(0, 1);
        // 零件的 +z（side × 脚尖方向）朝上：脚底贴地、脚背朝上
        const d: Vec3 = [foot.to[0] - foot.from[0], foot.to[1] - foot.from[1], foot.to[2] - foot.from[2]];
        const side = foot.side ?? [0, 0, 0];
        expect(side[2] * d[0] - side[0] * d[2]).toBeGreaterThan(0);
      }
    }
  });

  it("手腕看不清：按标准骨长推测，只有该段半透明", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA), [9]);
    const f = body(keypoints, bbox, WALL, AT, null, null);

    expect(f?.bones.flatMap((b, i) => (b.inferred ? [i] : []))).toEqual([5]);
  });

  it("下半身被挡：髋在脚点正上方，腿按标准骨长补到地面", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    const f = body(keypoints, bbox, WALL, AT, null, null);

    expect(Math.min(...heights(f))).toBeCloseTo(0, 5);
    expect(f?.bones.flatMap((b, i) => (b.inferred ? [i] : []))).toEqual([8, 9, 10, 11, 12, 13]); // 脚随所在小腿
  });

  it("坐在桌后只见上半身：按直立呈现，腿推测补到地面（D-057）", () => {
    // 坐姿：髋高约 0.5 m，躯干直立，腿被桌子挡住
    const seated = STANDING.map(([l, u, f]): Vec3 => [l, u - 0.42, f]);
    const { keypoints, bbox } = view(WALL, place(seated, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    const f = body(keypoints, bbox, WALL, AT, null, null);
    const torso = f?.bones[0];
    const tilt = torso ? Math.abs(torso.from[1] - torso.to[1]) / length(torso.from, torso.to) : 0;

    expect(tilt).toBeGreaterThan(Math.cos((20 * Math.PI) / 180));
    expect(f?.head.at[1]).toBeGreaterThan(1);
  });

  it("坐在桌后、腿被挡：按视觉引擎推算的脚点（按站立髋高）判为坐姿，髋高约 0.45 m、大腿水平，人形落在实际位置", () => {
    // 实际：坐在 AT 处，髋高 0.45 m，上半身直立；视觉引擎按站立髋高 0.92 m 推算脚点，落在更靠近镜头处
    const seated = STANDING.map(([l, u, f]): Vec3 => [l, u - 0.47, f]);
    const { keypoints, bbox } = view(WALL, place(seated, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    const t = (0.92 - WALL.height_m) / (0.45 - WALL.height_m);
    const reported: [number, number] = [AT[0] * t, 0];
    const f = body(keypoints, bbox, WALL, reported, null, null);
    if (!f) throw new Error("没有重建");

    const hip = f.bones[0]?.to ?? [0, 0, 0];
    expect(hip[1]).toBeCloseTo(0.45, 1);
    expect(f.head.at[1]).toBeLessThan(1.4); // 坐着：头约 1.2 m
    const thigh = f.bones[LEFT_THIGH];
    expect(thigh && Math.abs(thigh.from[1] - thigh.to[1])).toBeLessThan(0.05); // 大腿水平
    expect(thigh?.inferred).toBe(true);
    // 人形相对脚点向远离镜头一侧偏移：髋部落在实际的 AT 处
    expect(reported[0] + hip[0]).toBeCloseTo(AT[0], 0);
  });

  it("坐、站判定有回差：尺度在两个门限之间时沿用上一帧的姿态", () => {
    // 髋高 0.75 m（介于坐、站之间）：没有上一帧时按站姿；上一帧是坐姿时仍按坐姿
    const between = STANDING.map(([l, u, f]): Vec3 => [l, u - 0.17, f]);
    const { keypoints, bbox } = view(WALL, place(between, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    const t = (0.92 - WALL.height_m) / (0.75 - WALL.height_m);
    const reported: [number, number] = [AT[0] * t, 0];
    expect(body(keypoints, bbox, WALL, reported, null, null)?.seated).toBeFalsy();
    expect(body(keypoints, bbox, WALL, reported, null, null, false, true)?.seated).toBe(true);
  });

  it("4 m 高的摄像头下坐在桌后：两种假设的尺度比较仍判为坐姿（固定门限 0.82 判不出）", () => {
    const TALL: Pose = { ...WALL, height_m: 4, pitch_deg: -35 };
    const seated = STANDING.map(([l, u, f]): Vec3 => [l, u - 0.47, f]);
    const { keypoints, bbox } = view(TALL, place(seated, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    const t = (0.92 - TALL.height_m) / (0.45 - TALL.height_m);
    const f = body(keypoints, bbox, TALL, [AT[0] * t, 0], null, null);

    expect(f?.seated).toBe(true);
    expect(f?.bones[0]?.to[1]).toBeCloseTo(0.45, 1);
  });

  it("坐姿、膝部可见：大腿方向按膝部视线求得（不再按猜测的朝向折出），并给出身体朝向", () => {
    // 背对镜头坐着（朝 +x），脸被挡、耳朵可见，膝部在髋前方 0.42 m 同高处，脚踝被挡
    const seated: Vec3[] = STANDING.map(([l, u, f], i): Vec3 =>
      i === 13 || i === 14 ? [l, 0.45, 0.42] : i === 15 || i === 16 ? [l, 0.03, 0.42] : [l, u - 0.47, f],
    );
    const { keypoints, bbox } = view(WALL, place(seated, AT, 0), [0, 1, 2, 15, 16]);
    const t = (0.92 - WALL.height_m) / (0.45 - WALL.height_m);
    const f = body(keypoints, bbox, WALL, [AT[0] * t, 0], null, null);
    const thigh = f?.bones[LEFT_THIGH];
    if (!f || !thigh) throw new Error("没有重建");

    expect(f.seated).toBe(true);
    expect(thigh.inferred).toBe(false);
    expect(thigh.to[0] - thigh.from[0]).toBeGreaterThan(0.3); // 大腿朝远离镜头的 +x
    expect(Math.abs(thigh.to[1] - thigh.from[1])).toBeLessThan(0.1);
    expect(Math.cos(f.front ?? Math.PI)).toBeGreaterThan(0.9);
  });

  it("坐姿、腿被挡：沿用上一帧的朝向，不随关键点左右次序逐帧翻转", () => {
    const seated = STANDING.map(([l, u, f]): Vec3 => [l, u - 0.47, f]);
    const { keypoints, bbox } = view(WALL, place(seated, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    const t = (0.92 - WALL.height_m) / (0.45 - WALL.height_m);
    const reported: [number, number] = [AT[0] * t, 0];
    const fresh = body(keypoints, bbox, WALL, reported, null, null);
    const kept = body(keypoints, bbox, WALL, reported, null, null, false, true, 0);
    const dx = (f: Figure | null) => (f?.bones[LEFT_THIGH]?.to[0] ?? 0) - (f?.bones[LEFT_THIGH]?.from[0] ?? 0);

    expect(dx(fresh)).toBeLessThan(-0.3); // 正对镜头：大腿朝镜头（−x）
    expect(dx(kept)).toBeGreaterThan(0.3); // 上一帧朝 +x：沿用
    expect(kept?.front).toBeCloseTo(0, 5);
  });

  it("背面：脸部看不见而耳朵看得见，关键点左右次序给反也判为背对镜头", () => {
    const seated = STANDING.map(([l, u, f]): Vec3 => [l, u - 0.47, f]);
    const { keypoints, bbox } = view(WALL, place(seated, AT, 0), [0, 1, 2, 13, 14, 15, 16]);
    // 左右互换：模拟关键点模型对背面给出正面的左右次序
    const swapped = keypoints.map((_, i) => keypoints[i === 0 ? 0 : i % 2 === 1 ? i + 1 : i - 1] ?? [0, 0, 0]);
    const t = (0.92 - WALL.height_m) / (0.45 - WALL.height_m);
    const f = body(swapped, bbox, WALL, [AT[0] * t, 0], null, null);

    expect(f?.seated).toBe(true);
    expect(Math.cos(f?.front ?? Math.PI)).toBeGreaterThan(0.9);
  });

  it("seatedByScale：取更接近标准体型的假设，带回差；两者分不开时沿用上一帧", () => {
    expect(seatedByScale(0.8, 1.0, false)).toBe(true);
    expect(seatedByScale(1.0, 1.25, true)).toBe(false);
    expect(seatedByScale(0.92, 1.13, false)).toBe(false); // 介于两者之间：没有上一帧按站姿
    expect(seatedByScale(0.92, 1.13, true)).toBe(true); // 上一帧坐着：仍坐着
    expect(seatedByScale(0.95, 1.02, true)).toBe(true); // 分不开（高位摄像头）
    expect(seatedByScale(0.95, 1.02, false)).toBe(false);
  });

  it("站在矮墙后、腿被挡：画面尺度与站立相符，仍按站姿", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA), [13, 14, 15, 16]);
    expect(body(keypoints, bbox, WALL, AT, null, null)?.head.at[1]).toBeGreaterThan(1.5);
  });

  it("正对镜头站立（3 m 高、俯角 30°、5 m 外）：没有跌倒判定时按直立，不按误差取成躺倒（cam-05 实测的倒着站）", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA));
    const f = body(keypoints, bbox, WALL, AT, null, null);

    expect(f !== null && isUpright(f)).toBe(true);
    expect(Math.max(...heights(f))).toBeGreaterThan(1);
  });

  it("贴近镜头、画面中显得过宽：肩宽不超过 1.5 倍标准", () => {
    const wide = STANDING.map(([l, u, f], i): Vec3 => (i === 5 || i === 6 ? [l * 4, u, f] : [l, u, f]));
    const { keypoints, bbox } = view(WALL, place(wide, AT, TOWARD_CAMERA));
    // 肩宽失真到 4 倍的画面在直立假设下重建不出直立人形：没有跌倒判定时不用三维重建（由画面平面人形兜底），
    // 有跌倒判定时按误差取舍，肩宽同样截到 1.5 倍标准
    const plain = body(keypoints, bbox, WALL, AT, null, null);
    expect(plain === null || isUpright(plain)).toBe(true);
    const line = body(keypoints, bbox, WALL, AT, null, null, true)?.bones[2];

    expect(line && length(line.from, line.to)).toBeLessThanOrEqual(0.38 * 1.5 + 1e-6);
  });

  it("肩或髋全看不清、车辆没有关键点：返回 null，由画面平面人形兜底", () => {
    const { keypoints, bbox } = view(WALL, place(STANDING, AT, TOWARD_CAMERA), [11, 12]);
    expect(body(keypoints, bbox, WALL, AT, null, null)).toBeNull();
    expect(body(null, [0, 0, 1, 1], WALL, AT, null, null)).toBeNull();
  });
});

describe("人形与摄像头视角的左右一致", () => {
  // 只用画面事实构造：正对镜头站立，把画面右侧的那只手平举到更右处；与测试自己的投影约定无关
  const size = { width: 1600, height: 900 };
  const screen = sceneView(cameraShot(WALL, size), size);
  const base = view(WALL, place(STANDING, AT, TOWARD_CAMERA));
  const [l = [], r = []] = [base.keypoints[9], base.keypoints[10]];
  const wrist = (l[0] ?? 0) > (r[0] ?? 0) ? 9 : 10;
  const shoulder = wrist === 9 ? 5 : 6;
  const keypoints = base.keypoints.map((p, i) => (i === wrist ? [(base.keypoints[shoulder]?.[0] ?? 0) + 0.12, base.keypoints[shoulder]?.[1] ?? 0, 0.9] : p));
  const bbox = [base.bbox[0] ?? 0, base.bbox[1] ?? 0, Math.max(base.bbox[2] ?? 0, keypoints[wrist]?.[0] ?? 0), base.bbox[3] ?? 0];
  /** 人形关节在摄像头视角（与 Scene3D 同一投影）中的横坐标 */
  const x = (f: Figure | null, end: "from" | "to", bone: number) => {
    const p = f?.bones[bone]?.[end];
    return p ? (screen.project([AT[0] + p[0], p[1], AT[1] + p[2]])?.[0] ?? Number.NaN) : Number.NaN;
  };
  // 前臂骨段：左前臂为第 5 段（7→9），右前臂为第 7 段（8→10）
  const forearm = wrist === 9 ? 5 : 7;

  it("body：画面右侧平举的手画在摄像头视角的右侧", () => {
    const f = body(keypoints, bbox, WALL, AT, null, null);
    expect(x(f, "to", forearm)).toBeGreaterThan(screen.project([AT[0], 1, AT[1]])?.[0] ?? Number.POSITIVE_INFINITY);
  });

  it("figure：画面平面人形同样画在右侧", () => {
    const f = figure(keypoints, bbox, facing(WALL, AT[0], AT[1]));
    expect(x(f, "to", forearm)).toBeGreaterThan(screen.project([AT[0], 1, AT[1]])?.[0] ?? Number.POSITIVE_INFINITY);
  });
});
