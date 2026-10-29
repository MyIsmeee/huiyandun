import { Clock, X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { deviceLook } from "../../scene/devices";
import { CLASS_LABEL, kmh } from "../../scene/targets";
import type { Device, Target } from "../../store/live";
import { LiveVideo, LiveVideoView } from "../LiveVideo/LiveVideo";

const TYPE: Record<Device["type"], string> = { camera: "摄像头", nvr: "录像机", switch: "交换机" };

/**
 * D 详情面板（HYD-UIX-004 §4.1、§8）：选中设备时展开，Esc 或关闭按钮收起（V-I2）。
 * stale 为推送连接已断开：状态是断开前的最后值，弱化显示并标注（UP-3、V-U3）。
 * 事实区、AI 分析区、处置操作由后续任务接入。
 */
export function DetailPanel(props: { device: Device; stale: boolean; onClose: () => void }) {
  const { device, stale, onClose } = props;
  const tags = deviceLook(device.state).tags.map((t) => t.text);
  return (
    <Frame title={device.id} onClose={onClose}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-3">类型</dt>
        <dd>{TYPE[device.type]}</dd>
        <dt className="text-fg-3">地址</dt>
        <dd className="tabular-nums">{device.ip}</dd>
        <dt className="text-fg-3">状态</dt>
        <dd className={stale ? "text-fg-3" : undefined}>
          {tags.length > 0 ? tags.join(" · ") : "正常"}
          {stale && <Stale />}
        </dd>
      </dl>
      <h3 className="text-sm font-semibold">实时画面</h3>
      {/* key：切换设备时重建连接与状态 */}
      {device.camera ? <LiveVideo key={device.id} deviceId={device.id} /> : <LiveVideoView status={{ kind: "none" }} />}
    </Frame>
  );
}

/** 选中的人员或车辆（D-054）：类别、跟踪号、速度、所属摄像头、定位误差，下方播放所属摄像头的实时画面 */
export function TargetPanel(props: { target: Target; stale: boolean; onClose: () => void }) {
  const { target, stale, onClose } = props;
  const speed = kmh(target.speed_mps);
  return (
    <Frame title={`${CLASS_LABEL[target.object_class]} #${target.track_id}`} onClose={onClose}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-fg-3">类别</dt>
        <dd>{CLASS_LABEL[target.object_class]}</dd>
        <dt className="text-fg-3">跟踪号</dt>
        <dd className="tabular-nums">{target.track_id}</dd>
        <dt className="text-fg-3">速度</dt>
        <dd className={stale ? "text-fg-3 tabular-nums" : "tabular-nums"}>
          {speed === null ? "—" : `${speed} km/h`}
          {stale && <Stale />}
        </dd>
        <dt className="text-fg-3">摄像头</dt>
        <dd>{target.camera_id}</dd>
        <dt className="text-fg-3">定位误差</dt>
        <dd className="tabular-nums">±{target.uncertainty_m.toFixed(1)} m</dd>
      </dl>
      <h3 className="text-sm font-semibold">实时画面</h3>
      <LiveVideo key={target.camera_id} deviceId={target.camera_id} />
    </Frame>
  );
}

function Stale() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-uncertain">
      <Clock aria-hidden className="size-3.5" />
      数据非实时
    </span>
  );
}

function Frame(props: { title: string; onClose: () => void; children: ReactNode }) {
  const { title, onClose, children } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section aria-label="详情" className="flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="truncate font-semibold">{title}</h2>
        <button
          onClick={onClose}
          aria-label="关闭详情"
          className="grid size-8 shrink-0 place-items-center rounded-full text-fg-2 transition-colors hover:bg-raised hover:text-fg"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>
      {children}
    </section>
  );
}
