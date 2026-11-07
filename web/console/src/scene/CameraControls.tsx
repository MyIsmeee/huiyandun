import { House, type LucideIcon, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useConnection } from "../store/connection";
import { prefersReducedMotion } from "../theme/store";
import { focusOn, moveCamera, overview, preset, presetOf, useCamera, zoomed } from "./camera";
import { type Pose, VIEW_PRESETS, type ViewPreset, ZOOM_MAX, ZOOM_MIN } from "./layout";

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
 * 相机控件组（V-I1、V-I5）：缩小、放大、命名视角（轴测东南 / 轴测西南 / 俯视）、返回总览，位于场景左下角。
 * 2D 降级说明并入同一浮层，场景内同时可见的浮层不超过 4 个（V-L3）。
 */
export function CameraControls({ notice }: { notice?: { text: string; title: string } }) {
  const goal = useCamera((s) => s.goal);
  // 跟随视角下机位由目标或摄像头决定，只有"返回总览"可用（D-058）
  const focused = useCamera((s) => s.focus !== null);
  const animate = useAnimate();
  const buttons: [string, LucideIcon, (pose: Pose) => Pose, boolean][] = [
    ["缩小", Minus, (p) => zoomed(p, -1), focused || goal.zoom <= ZOOM_MIN],
    ["放大", Plus, (p) => zoomed(p, 1), focused || goal.zoom >= ZOOM_MAX],
  ];
  const current = presetOf(goal);
  const presets = Object.entries(VIEW_PRESETS) as [ViewPreset, (typeof VIEW_PRESETS)[ViewPreset]][];
  return (
    <div
      role="toolbar"
      aria-label="视角"
      className="absolute bottom-3 left-3 flex items-center rounded-lg border bg-card/90 p-1 text-meta text-muted-foreground backdrop-blur-sm"
    >
      {notice && (
        <span title={notice.title} className="border-r px-3 whitespace-nowrap">
          {notice.text}
        </span>
      )}
      {buttons.map(([label, Icon, next, disabled]) => (
        <ControlButton key={label} label={label} disabled={disabled} onClick={() => moveCamera(next(goal), animate())}>
          <Icon aria-hidden className="size-4" />
        </ControlButton>
      ))}
      <span aria-hidden className="mx-1 h-5 w-px bg-border" />
      {presets.map(([name, { label }]) => (
        <button
          key={name}
          aria-label={label}
          aria-pressed={!focused && current === name}
          disabled={focused}
          onClick={() => moveCamera(preset(goal, name), animate())}
          className="h-8 rounded-md px-2 whitespace-nowrap transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent aria-pressed:bg-accent aria-pressed:text-foreground"
        >
          {label}
        </button>
      ))}
      <span aria-hidden className="mx-1 h-5 w-px bg-border" />
      {/* 跟随视角下机位由目标或摄像头决定，只有"返回总览"可用（D-058） */}
      <ControlButton label="返回总览" disabled={false} onClick={() => (focused ? focusOn(null, animate()) : moveCamera(overview(goal), animate()))}>
        <House aria-hidden className="size-4" />
      </ControlButton>
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
      className="grid size-8 place-items-center rounded-md transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  );
}
