import { House, type LucideIcon, Minus, Plus, RotateCw } from "lucide-react";
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
 * 视角控件（V-I1、V-I5，设计 150 §3）：放大、缩小、旋转 90°、返回总览，竖排浮在场景右下、告警与详情卡左侧
 * （1366 宽下顶部一行已被指标卡与区域切换占满）
 */
export function CameraControls() {
  const goal = useCamera((s) => s.goal);
  // 跟随视角下机位由目标或摄像头决定，只有"返回总览"可用（D-058）
  const focused = useCamera((s) => s.focus !== null);
  const animate = useAnimate();
  const buttons: [string, LucideIcon, (pose: Pose) => Pose, boolean][] = [
    ["放大", Plus, (p) => zoomed(p, 1), focused || goal.zoom >= ZOOM_MAX],
    ["缩小", Minus, (p) => zoomed(p, -1), focused || goal.zoom <= ZOOM_MIN],
    ["旋转 90°", RotateCw, rotated, focused],
  ];
  return (
    <div
      role="toolbar"
      aria-label="视角"
      aria-orientation="vertical"
      className="floating-card absolute right-[372px] bottom-4 flex flex-col p-1 text-muted-foreground min-[1600px]:right-[412px]"
    >
      {buttons.map(([label, Icon, next, disabled]) => (
        <ControlButton key={label} label={label} disabled={disabled} onClick={() => moveCamera(next(goal), animate())}>
          <Icon aria-hidden className="size-4" />
        </ControlButton>
      ))}
      <span aria-hidden className="mx-1 my-1 h-px bg-border" />
      <ControlButton label="返回总览" disabled={false} onClick={() => (focused ? focusOn(null, animate()) : moveCamera(overview(goal), animate()))}>
        <House aria-hidden className="size-4" />
      </ControlButton>
    </div>
  );
}

export function ControlButton(props: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid size-8 place-items-center rounded-md transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}
