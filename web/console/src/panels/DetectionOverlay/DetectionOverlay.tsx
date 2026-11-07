import { type MouseEvent, useEffect, useRef } from "react";
import { prefersReducedMotion } from "../../theme/store";
import { renderTime, smoothed, smoothers } from "../../scene/smoothing";
import { CLASS_LABEL } from "../../scene/targets";
import { useConnection } from "../../store/connection";
import { type Target, useLive } from "../../store/live";
import { selectTarget, useSelection } from "../../store/selection";
import { contentRect, hitTarget, isFresh, type Rect, SKELETON, toPixel } from "./overlay";

const BOX = "rgb(255 255 255 / 0.8)";
const BONE = "rgb(255 255 255 / 0.6)";
/** 选中的目标：线宽加倍，与 3D 选中括框同为白色 */
const SELECTED = "#FFFFFF";
const LABEL_BG = "rgb(19 19 22 / 0.8)";

/**
 * 实时画面上的检测框与骨骼（FR-107、04 V-W5）：取与 3D 人形同一份滤波后的检测框与关键点（V-A8），
 * 在相邻实测之间插值；某目标最近一次实测超过 300 ms 即不画。只画可见关节，不补全（画面上看得见）。
 * 以 canvas 逐帧绘制、不经 React 重渲染；单击检测框选中该目标（D-054），其余点击交给瓦片。
 */
export function DetectionOverlay({ cameraId, video }: { cameraId: string; video: () => HTMLVideoElement | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const rect = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  // 设备离线或推送断开（V-U3）时不画：没有实时的跟踪数据
  const offline = useLive((s) => s.devices[cameraId]?.state === "offline");
  const disconnected = useConnection((s) => !s.open);

  useEffect(() => {
    let frame = 0;
    let painted = true;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      const { clientWidth: w, clientHeight: h } = el;
      const ratio = devicePixelRatio || 1;
      if (el.width !== Math.round(w * ratio)) el.width = Math.round(w * ratio);
      if (el.height !== Math.round(h * ratio)) el.height = Math.round(h * ratio);
      const v = video();
      const aspect = v && v.videoWidth > 0 ? v.videoWidth / v.videoHeight : 16 / 9;
      rect.current = contentRect(w, h, aspect);
      const now = Date.now();
      const fresh = offline || disconnected ? [] : mine(cameraId).filter(([, t]) => isFresh(t, now));
      // 上一帧与这一帧都没有可画的目标：不必清屏重画
      if (!painted && fresh.length === 0) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      painted = fresh.length > 0;
      const motion = !prefersReducedMotion();
      const selected = useSelection.getState().targetKey;
      for (const [key, target] of fresh) {
        const shape = smoothed(key, target).pose(renderTime(target, now, motion));
        if (shape) paint(ctx, target, shape, rect.current, key === selected);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      // 释放本路已离开画面的目标的平滑状态；其他摄像头的由各自叠加或 3D 场景管理
      const alive = new Set(mine(cameraId).map(([key]) => key));
      for (const key of smoothers.keys()) if (key.startsWith(`${cameraId}/`) && !alive.has(key)) smoothers.delete(key);
    };
  }, [cameraId, video, offline, disconnected]);

  const onClick = (e: MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const now = Date.now();
    const boxes = mine(cameraId)
      .filter(([, t]) => isFresh(t, now))
      .map(([key, t]) => ({ key, bbox: t.bbox }));
    const hit = hitTarget([e.clientX - box.left, e.clientY - box.top], boxes, rect.current);
    if (!hit) return;
    e.stopPropagation();
    selectTarget(hit);
  };

  return <canvas ref={canvas} aria-hidden data-overlay={cameraId} onClick={onClick} className="absolute inset-0 size-full" />;
}

const mine = (cameraId: string) => Object.entries(useLive.getState().targets).filter(([, t]) => t.camera_id === cameraId);

/** 画一个目标的检测框、骨骼与标签；组件展示页也直接调用（V-G3） */
export function paint(ctx: CanvasRenderingContext2D, target: Target, shape: { bbox: number[]; keypoints: Target["keypoints"] }, rect: Rect, selected: boolean) {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = shape.bbox;
  const [left, top] = toPixel(x1, y1, rect);
  const [right, bottom] = toPixel(x2, y2, rect);
  const width = selected ? 3 : 1.5;
  ctx.strokeStyle = selected ? SELECTED : BOX;
  ctx.lineWidth = width;
  ctx.strokeRect(left, top, right - left, bottom - top);
  corners(ctx, left, top, right, bottom, width * 2);

  // 骨骼：只连两端都可见的关节（滤波后的分数已按滞回化为 0 / 1）
  const points = shape.keypoints;
  if (points) {
    ctx.strokeStyle = BONE;
    ctx.fillStyle = BONE;
    ctx.lineWidth = 1.5;
    for (const [a, b] of SKELETON) {
      const p = points[a];
      const q = points[b];
      if (!p || !q || !p[2] || !q[2]) continue;
      ctx.beginPath();
      ctx.moveTo(...toPixel(p[0] ?? 0, p[1] ?? 0, rect));
      ctx.lineTo(...toPixel(q[0] ?? 0, q[1] ?? 0, rect));
      ctx.stroke();
    }
    for (const [u = 0, v = 0, seen = 0] of points) {
      if (!seen) continue;
      const [px, py] = toPixel(u, v, rect);
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 标签胶囊"类别 #跟踪号"，贴在框的左上方；框贴近画面顶边时放进框内
  const text = `${CLASS_LABEL[target.object_class]} #${target.track_id}`;
  ctx.font = "12px system-ui, sans-serif";
  const tw = ctx.measureText(text).width + 12;
  const ty = top - 20 >= rect.y ? top - 20 : top + 2;
  ctx.fillStyle = LABEL_BG;
  ctx.beginPath();
  ctx.roundRect(left, ty, tw, 18, 9);
  ctx.fill();
  ctx.fillStyle = SELECTED;
  ctx.fillText(text, left + 6, ty + 13);
}

/** 四角加粗（与 3D 选中括框同一语言） */
function corners(ctx: CanvasRenderingContext2D, l: number, t: number, r: number, b: number, width: number) {
  const len = Math.min(10, (r - l) / 3, (b - t) / 3);
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [l, t, 1, 1],
    [r, t, -1, 1],
    [l, b, 1, -1],
    [r, b, -1, -1],
  ] as const) {
    ctx.moveTo(x + dx * len, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * len);
  }
  ctx.stroke();
}
