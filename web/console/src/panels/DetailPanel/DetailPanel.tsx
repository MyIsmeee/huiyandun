import { Clock, X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { deviceLook } from "../../scene/devices";
import { CLASS_LABEL, kmh } from "../../scene/targets";
import type { Device, Target } from "../../store/live";
import { ActionBar } from "../ActionBar/ActionBar";
import { AiInvestigation } from "../AiInvestigation/AiInvestigation";
import { IncidentTimeline } from "../IncidentTimeline/IncidentTimeline";
import { LiveVideo, LiveVideoView } from "../LiveVideo/LiveVideo";
import { ReportBar } from "../ReportBar/ReportBar";

const TYPE: Record<Device["type"], string> = { camera: "摄像头", nvr: "录像机", switch: "交换机" };

/**
 * D 详情抽屉（HYD-UIX-004 §4.1、§8，D-112）：选中设备时从右侧盖在场景上，Esc 或关闭按钮收起（V-I2）。
 * 自上而下为概要、处置时间线（FR-304）、规则结论与 AI 研判（AiInvestigation，TK-117）、报告（ReportBar，TK-070）、
 * 实时画面；处置操作（ActionBar，TK-052）固定在抽屉底部。
 * stale 为推送连接已断开：状态是断开前的最后值，弱化显示并标注（UP-3、V-U3）。
 */
export function DetailPanel(props: { device: Device; stale: boolean; onClose: () => void }) {
  const { device, stale, onClose } = props;
  const tags = deviceLook(device.state).tags.map((t) => t.text);
  return (
    <Drawer title={device.id} onClose={onClose} footer={<ActionBar deviceId={device.id} />}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-subtle-foreground">类型</dt>
        <dd>{TYPE[device.type]}</dd>
        <dt className="text-subtle-foreground">地址</dt>
        <dd className="font-mono tabular-nums">{device.ip}</dd>
        <dt className="text-subtle-foreground">状态</dt>
        <dd className={stale ? "text-subtle-foreground" : undefined}>
          {tags.length > 0 ? tags.join(" · ") : "正常"}
          {stale && <Stale />}
        </dd>
      </dl>
      <Section title="处置时间线">
        <IncidentTimeline />
      </Section>
      <AiInvestigation deviceId={device.id} stale={stale} />
      <ReportBar deviceId={device.id} />
      <Section title="实时画面">
        {/* key：切换设备时重建连接与状态 */}
        {device.camera ? <LiveVideo key={device.id} deviceId={device.id} /> : <LiveVideoView status={{ kind: "none" }} />}
      </Section>
    </Drawer>
  );
}

/** 选中的人员或车辆（D-054）：类别、跟踪号、速度、所属摄像头、定位误差，下方播放所属摄像头的实时画面 */
export function TargetPanel(props: { target: Target; stale: boolean; onClose: () => void }) {
  const { target, stale, onClose } = props;
  const speed = kmh(target.speed_mps);
  return (
    <Drawer title={`${CLASS_LABEL[target.object_class]} #${target.track_id}`} onClose={onClose}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-subtle-foreground">类别</dt>
        <dd>{CLASS_LABEL[target.object_class]}</dd>
        <dt className="text-subtle-foreground">跟踪号</dt>
        <dd className="font-mono tabular-nums">{target.track_id}</dd>
        <dt className="text-subtle-foreground">速度</dt>
        <dd className={stale ? "text-subtle-foreground tabular-nums" : "tabular-nums"}>
          {speed === null ? "—" : `${speed} km/h`}
          {stale && <Stale />}
        </dd>
        <dt className="text-subtle-foreground">摄像头</dt>
        <dd className="font-mono">{target.camera_id}</dd>
        <dt className="text-subtle-foreground">定位误差</dt>
        <dd className="tabular-nums">±{target.uncertainty_m.toFixed(1)} m</dd>
      </dl>
      <Section title="实时画面">
        <LiveVideo key={target.camera_id} deviceId={target.camera_id} />
      </Section>
    </Drawer>
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

/** 抽屉中的分区：分区标题 + 内容（面板内层级 ≤ 3，V-L4） */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 border-t pt-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Drawer(props: { title: string; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  const { title, onClose, footer, children } = props;
  useEffect(() => {
    // 跟随视角下的 Esc 先由场景用于回到总览（已 preventDefault），详情保留（D-048）
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // 内容一栏在抽屉内滚动，页面不随之撑高（V-L2）；底部操作区无内容时不占位
    <section
      aria-label="详情"
      className="absolute inset-y-3 right-3 z-10 flex w-[min(440px,40vw)] min-w-80 flex-col rounded-lg border bg-card shadow-[0_8px_24px_rgb(0_0_0/0.45)] animate-in fade-in slide-in-from-right-4"
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b pr-2 pl-4">
        <h2 className="truncate text-base font-medium">{title}</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭详情" className="size-8 text-muted-foreground">
          <X aria-hidden />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
      {footer && <div className="shrink-0 border-t p-3 empty:hidden">{footer}</div>}
    </section>
  );
}
