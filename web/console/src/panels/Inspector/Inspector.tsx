import { type Device, useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { AlertList } from "../AlertList/AlertList";
import { DetailPanel, TargetPanel } from "../DetailPanel/DetailPanel";

const deselect = () => select(null);

/**
 * 告警 ⇄ 详情（ui.md §4）：未选中时为告警列表，选中设备或目标时换成详情；态势页的右侧浮动卡片与监控墙页的检查栏共用。
 * 告警列表只隐藏不卸载，返回时筛选、展开与滚动位置不丢失。stale 为推送连接已断开（V-U3）
 */
export function Inspector(props: { devices: Device[]; stale: boolean; lastFrameAt: number | null }) {
  const { devices, stale, lastFrameAt } = props;
  // 设备状态以推送为准，未推送过的取 GET /api/site 的初始值
  const selectedId = useSelection((s) => s.deviceId);
  const pushed = useLive((s) => (selectedId ? s.devices[selectedId] : undefined));
  const selected = pushed ?? devices.find((d) => d.id === selectedId);
  const targetKey = useSelection((s) => s.targetKey);
  const target = useLive((s) => (targetKey ? s.targets[targetKey] : undefined));
  const detail = selected !== undefined || target !== undefined;
  return (
    <>
      <div hidden={detail} className="flex min-h-0 flex-1 flex-col">
        <AlertList stale={stale} lastFrameAt={lastFrameAt} />
      </div>
      {selected && <DetailPanel device={selected} stale={stale} onClose={deselect} />}
      {target && <TargetPanel target={target} stale={stale} onClose={deselect} />}
    </>
  );
}
