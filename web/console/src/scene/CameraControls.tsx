import { House, type LucideIcon, Minus, Plus, RotateCcw, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { useConnection } from "../store/connection";
import { prefersReducedMotion } from "../theme/store";
import { focusOn, moveCamera, overview, rotated, useCamera, zoomed } from "./camera";
import { type Pose, ZOOM_MAX, ZOOM_MIN } from "./layout";

/** 转场是否播放：降低动效或断线时瞬时切换（V-A4、C-FE-05）；取调用时的状态 */
function canAnimate(): boolean {
  const { open, connecting } = useConnection.getState();
  return (open || connecting) && !prefersReducedMotion();
}

/** 订阅连接状态：断线与恢复时调用方重新渲染；返回的判断函数引用不变，可放进副作用的依赖 */
export function useAnimate(): () => boolean {
  useConnection((s) => s.open || s.connecting);
  return canAnimate;
}

/**
 * 相机控件组（V-I1、V-I5）：缩小、放大、左转、右转、返回总览，位于场景右上角。
 * 2D 降级说明并入同一浮层，场景内同时可见的浮层不超过 3 个（V-L3）。
 */
export function CameraControls({ notice }: { notice?: { text: string; title: string } }) {
  const goal = useCamera((s) => s.goal);
  // 跟随视角下机位由目标或摄像头决定，只有"返回总览"可用（D-058）
  const focused = useCamera((s) => s.focus !== null);
  const animate = useAnimate();
  const buttons: [string, LucideIcon, (pose: Pose) => Pose, boolean][] = [
    ["缩小", Minus, (p) => zoomed(p, -1), focused || goal.zoom <= ZOOM_MIN],
    ["放大", Plus, (p) => zoomed(p, 1), focused || goal.zoom >= ZOOM_MAX],
    ["向左旋转 90°", RotateCcw, (p) => rotated(p, -1), focused],
    ["向右旋转 90°", RotateCw, (p) => rotated(p, 1), focused],
    ["返回总览", House, overview, false],
  ];
  return (
    <div
      role="toolbar"
      aria-label="视角"
      className="absolute top-3 right-3 flex items-center rounded-full border border-line bg-panel/80 p-0.5 text-sm text-fg-2 backdrop-blur"
    >
      {notice && (
        <span title={notice.title} className="border-r border-line px-3 whitespace-nowrap">
          {notice.text}
        </span>
      )}
      {buttons.map(([label, Icon, next, disabled]) => (
        <ControlButton key={label} label={label} disabled={disabled} onClick={() => (focused ? focusOn(null, animate()) : moveCamera(next(goal), animate()))}>
          <Icon aria-hidden className="size-4" />
        </ControlButton>
      ))}
    </div>
  );
}

function ControlButton(props: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid size-8 place-items-center rounded-full transition-colors hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}
