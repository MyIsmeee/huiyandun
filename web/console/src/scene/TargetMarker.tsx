import { useLive } from "../store/live";
import { useSelection } from "../store/selection";
import { STATUS } from "./devices";
import { ACCENT, targetLabel } from "./targets";

/**
 * 选中目标的屏幕外框：由 TargetModels 每帧按模型的投影范围写入左上角位置与尺寸（--w、--h），随插值移动，不经 React 重渲染；
 * 目标不在场景中时隐藏。外层只作定位锚点、自身无尺寸，括框与标签各自绝对定位
 */
export const marker: { el: HTMLDivElement | null } = { el: null };
/** 悬停目标的屏幕外框，同样由 TargetModels 每帧写入 */
export const hoverMarker: { el: HTMLDivElement | null } = { el: null };

/** 四角括框的位置：每个角两条边 */
const CORNERS = ["left-0 top-0 border-t-2 border-l-2", "right-0 top-0 border-t-2 border-r-2", "left-0 bottom-0 border-b-2 border-l-2", "right-0 bottom-0 border-b-2 border-r-2"];

/** 选中目标的四角括框与浮动胶囊标签（§5.1 L5、WareTrack）：始终朝向屏幕，点缀蓝纯色（V-S5） */
export function TargetMarker() {
  const key = useSelection((s) => s.targetKey);
  const target = useLive((s) => (key ? s.targets[key] : undefined));
  if (!target) return null;
  return (
    <div
      ref={(el) => {
        marker.el = el;
      }}
      hidden
      data-target={key}
      className="pointer-events-none absolute top-0 left-0"
    >
      <Corners color={ACCENT} />
      <span
        style={{ backgroundColor: ACCENT, color: "#FFFFFF" }}
        className="absolute bottom-1.5 left-[calc(var(--w)/2)] -translate-x-1/2 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap tabular-nums"
      >
        {targetLabel(target)}
      </span>
    </div>
  );
}

/** 悬停目标的四角括框（V-I4）：中性灰、无标签，与选中的点缀蓝区分；已选中的目标不再显示 */
export function HoverMarker() {
  const key = useSelection((s) => (s.hoveredKey !== s.targetKey ? s.hoveredKey : null));
  const present = useLive((s) => (key ? key in s.targets : false));
  if (!key || !present) return null;
  return (
    <div
      ref={(el) => {
        hoverMarker.el = el;
      }}
      hidden
      data-hover={key}
      className="pointer-events-none absolute top-0 left-0"
    >
      <Corners color={STATUS.neutral} />
    </div>
  );
}

function Corners({ color }: { color: string }) {
  return (
    <span className="absolute top-0 left-0 h-(--h) w-(--w)">
      {CORNERS.map((corner) => (
        <span key={corner} style={{ borderColor: color }} className={`absolute size-2.5 ${corner}`} />
      ))}
    </span>
  );
}
