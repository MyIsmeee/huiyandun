import { type MouseEvent, useEffect, useRef, useState } from "react";
import { release, retain, smoothed } from "../../scene/smoothing";
import { ACCENT, CLASS_LABEL } from "../../scene/targets";
import { useConnection } from "../../store/connection";
import { type Device, type Mark, type Target, useLive } from "../../store/live";
import { selectTarget, useSelection } from "../../store/selection";
import { blink, contentRect, hitTarget, isFresh, markText, type Rect, SKELETON, toPixel } from "./overlay";
import { type Zone, zones } from "./zones";

const BOX = "rgb(255 255 255 / 0.8)";
const BONE = "rgb(255 255 255 / 0.6)";
/** 选中的目标：线宽加倍，与 3D 选中括框同为强调色 */
const SELECTED = ACCENT;
const LABEL_BG = "rgb(19 19 22 / 0.8)";
const LABEL_TEXT = "#FFFFFF";
/** 告警标记：确认的为红色闪烁，疑似的为琥珀色常亮（与物理告警状态色一致） */
const ALERT = "#D03B3B";
const SUSPECT = "#FAB219";
/** 警戒线与区域：琥珀色虚线；区域内有人触发告警时转为红色闪烁 */
const ZONE = "rgb(250 178 25 / 0.9)";
const ZONE_FILL = "rgb(250 178 25 / 0.08)";

/**
 * 实时画面上的检测框与骨骼（FR-107、04 V-W5）：取与 3D 人形同一份滤波后的检测框与关键点（V-A8），
 * 直接画最近一次实测：不加 3D 的渲染延迟（V-A7 的 150～400 ms），否则叠加会比画面更晚。
 * 某目标最近一次实测超过 300 ms 即不画。只画可见关节，不补全（画面上看得见）。
 * 以 canvas 逐帧绘制、不经 React 重渲染；单击检测框选中该目标（D-054），其余点击交给瓦片。
 */
export function DetectionOverlay({ cameraId, video }: { cameraId: string; video: () => HTMLVideoElement | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const rect = useRef<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  // 设备离线或推送断开（V-U3）时不画：没有实时的跟踪数据
  const offline = useLive((s) => s.devices[cameraId]?.state === "offline");
  const disconnected = useConnection((s) => !s.open);
  // 平滑状态与 3D 场景、其他叠加共用（smoothing.ts）：本叠加只声明本路的目标，卸载时撤销
  const [owner] = useState(() => ({}));
  useEffect(() => () => release(owner), [owner]);

  useEffect(() => {
    let frame = 0;
    // 上次静态重画时的画布与画面尺寸；逐帧重画期间为空串（下一帧必然重画）
    let painted = "";
    let drawn: Zone[] | null = null;
    let layout: { camera: Device["camera"] | null; size: string; zones: Zone[] } = { camera: null, size: "", zones: [] };
    let claimed: object | null = null;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      // 目标集合变化时重新声明本路仍在跟踪的目标：已离开画面的随即释放，监控墙常开时不累积
      const { targets } = useLive.getState();
      if (targets !== claimed) {
        claimed = targets;
        retain(owner, new Set(mine(cameraId).map(([key]) => key)));
      }
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      const { clientWidth: w, clientHeight: h } = el;
      const ratio = devicePixelRatio || 1;
      if (el.width !== Math.round(w * ratio)) el.width = Math.round(w * ratio);
      if (el.height !== Math.round(h * ratio)) el.height = Math.round(h * ratio);
      const v = video();
      const ready = v !== null && v.videoWidth > 0;
      const aspect = ready ? v.videoWidth / v.videoHeight : 16 / 9;
      rect.current = contentRect(w, h, aspect);
      const now = Date.now();
      const fresh = offline || disconnected ? [] : mine(cameraId).filter(([, t]) => isFresh(t, now));
      // 警戒线与区域按画面像素尺寸投影，视频未就绪时不画；登记信息或画面尺寸变化时才重算
      const { devices, marks } = useLive.getState();
      const camera = devices[cameraId]?.camera ?? null;
      const size = ready ? `${v.videoWidth}x${v.videoHeight}` : "";
      if (camera !== layout.camera || size !== layout.size) layout = { camera, size, zones: camera && ready ? zones(camera, [v.videoWidth, v.videoHeight]) : [] };
      // 区域内有人触发确认告警时该区域闪烁
      const active = new Set(Object.values(marks).flatMap((m) => (m.camera_id === cameraId && m.name && m.level === "confirmed" ? [m.name] : [])));
      // 有目标或有闪烁的区域时逐帧重画；否则只在画面尺寸或区域变化后画一次
      const animate = fresh.length > 0 || active.size > 0;
      const signature = `${w}x${h}/${size}`;
      if (!animate && painted === signature && layout.zones === drawn) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      painted = animate ? "" : signature;
      drawn = layout.zones;
      for (const zone of layout.zones) outline(ctx, zone, rect.current, active.has(zone.name) ? blink(now) : null);
      const selected = useSelection.getState().targetKey;
      for (const [key, target] of fresh) {
        const shape = smoothed(key, target).pose(Number.POSITIVE_INFINITY);
        if (shape) paint(ctx, target, shape, rect.current, key === selected, marks[key], now);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [cameraId, video, offline, disconnected, owner]);

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

/**
 * 画一个目标的检测框、骨骼与标签；组件展示页也直接调用（V-G3）。
 * 带告警标记（mark）的人：框加粗改为告警色，确认的闪烁、框内淡淡铺色，标签换成"行为 · 已持续秒数"
 */
export function paint(
  ctx: CanvasRenderingContext2D,
  target: Target,
  shape: { bbox: number[]; keypoints: Target["keypoints"] },
  rect: Rect,
  selected: boolean,
  mark?: Mark,
  now = Date.now(),
) {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = shape.bbox;
  const [left, top] = toPixel(x1, y1, rect);
  const [right, bottom] = toPixel(x2, y2, rect);
  const color = mark ? (mark.level === "confirmed" ? ALERT : SUSPECT) : null;
  const width = color ? 3 : selected ? 3 : 1.5;
  ctx.save();
  if (color) {
    ctx.globalAlpha = mark?.level === "confirmed" ? blink(now) : 1;
    ctx.fillStyle = color;
    ctx.globalAlpha *= 0.15;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.globalAlpha /= 0.15;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
  }
  ctx.strokeStyle = color ?? (selected ? SELECTED : BOX);
  ctx.lineWidth = width;
  ctx.strokeRect(left, top, right - left, bottom - top);
  corners(ctx, left, top, right, bottom, width * 2);
  ctx.restore();

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

  // 标签胶囊"类别 #跟踪号"，贴在框的左上方；框贴近画面顶边时放进框内。告警标记的标签为告警色底、加粗
  const text = mark ? `${markText(mark, now)}  #${target.track_id}` : `${CLASS_LABEL[target.object_class]} #${target.track_id}`;
  ctx.font = mark ? "600 13px system-ui, sans-serif" : "12px system-ui, sans-serif";
  const lh = mark ? 20 : 18;
  const tw = ctx.measureText(text).width + 12;
  const ty = top - lh - 2 >= rect.y ? top - lh - 2 : top + 2;
  ctx.fillStyle = color ?? LABEL_BG;
  ctx.beginPath();
  ctx.roundRect(left, ty, tw, lh, lh / 2);
  ctx.fill();
  ctx.fillStyle = mark?.level === "suspected" ? "#131316" : LABEL_TEXT;
  ctx.fillText(text, left + 6, ty + lh - 5);
}

/** 画一条警戒线或一个规则区域：琥珀色虚线与名称；alpha 非空时为告警中，改为红色按 alpha 闪烁 */
function outline(ctx: CanvasRenderingContext2D, zone: Zone, rect: Rect, alpha: number | null) {
  const [stroke, fill] = alpha === null ? [ZONE, ZONE_FILL] : [ALERT, "rgb(208 59 59 / 0.18)"];
  ctx.save();
  ctx.globalAlpha = alpha ?? 1;
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;
  ctx.lineWidth = 2;
  ctx.setLineDash(zone.kind === "line_crossing" ? [] : [8, 5]);
  for (const path of zone.paths) {
    ctx.beginPath();
    path.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(...toPixel(u, v, rect)) : ctx.lineTo(...toPixel(u, v, rect))));
    if (zone.kind === "intrusion") {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (zone.arrow) {
    const [[u1, v1], [u2, v2]] = zone.arrow;
    const [a, b] = [toPixel(u1, v1, rect), toPixel(u2, v2, rect)];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    for (const side of [-1, 1]) {
      ctx.moveTo(...b);
      ctx.lineTo(b[0] - 8 * Math.cos(angle + side * 0.5), b[1] - 8 * Math.sin(angle + side * 0.5));
    }
    ctx.stroke();
  }
  // 名称贴在第一段的起点旁，超出画面的不画
  const [u, v] = zone.paths[0]?.[0] ?? [Number.NaN, Number.NaN];
  const [px, py] = toPixel(u, v, rect);
  if (px >= rect.x && px <= rect.x + rect.w - 20 && py >= rect.y + 14 && py <= rect.y + rect.h) {
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = stroke;
    ctx.fillText(zone.name, px + 4, py - 4);
  }
  ctx.restore();
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
