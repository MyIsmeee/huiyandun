import { Clock, X } from "lucide-react";
import { useEffect } from "react";
import { deviceLook } from "../../scene/devices";
import type { Device } from "../../store/live";
import { LiveVideo, LiveVideoView } from "../LiveVideo/LiveVideo";

const TYPE: Record<Device["type"], string> = { camera: "摄像头", nvr: "录像机", switch: "交换机" };

/**
 * D 详情面板（HYD-UIX-004 §4.1、§8）：选中设备时展开，Esc 或关闭按钮收起（V-I2）。
 * stale 为推送连接已断开：状态是断开前的最后值，弱化显示并标注（UP-3、V-U3）。
 * 事实区、AI 分析区、处置操作由后续任务接入。
 */
export function DetailPanel(props: { device: Device; stale: boolean; onClose: () => void }) {
  const { device, stale, onClose } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const tags = deviceLook(device.state).tags.map((t) => t.text);
  return (
    <section aria-label="详情" className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="truncate font-semibold">{device.id}</h2>
        <button
          onClick={onClose}
          aria-label="关闭详情"
          className="grid size-8 shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-raised hover:text-fg"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-3">类型</dt>
        <dd>{TYPE[device.type]}</dd>
        <dt className="text-fg-3">地址</dt>
        <dd className="tabular-nums">{device.ip}</dd>
        <dt className="text-fg-3">状态</dt>
        <dd className={stale ? "text-fg-3" : undefined}>
          {tags.length > 0 ? tags.join(" · ") : "正常"}
          {stale && (
            <span className="ml-2 inline-flex items-center gap-1 text-xs text-uncertain">
              <Clock aria-hidden className="size-3.5" />
              数据非实时
            </span>
          )}
        </dd>
      </dl>
      <h3 className="text-sm font-semibold">实时画面</h3>
      {/* key：切换设备时重建连接与状态 */}
      {device.camera ? <LiveVideo key={device.id} deviceId={device.id} /> : <LiveVideoView status={{ kind: "none" }} />}
    </section>
  );
}
