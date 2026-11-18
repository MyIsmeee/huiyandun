import { ArrowLeft, Clock, Waypoints } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { deviceLook, mappingText } from "../../scene/devices";
import { CLASS_LABEL, kmh } from "../../scene/targets";
import { type Device, type Target, useLive } from "../../store/live";
import { useNav } from "../../store/nav";
import { ActionBar } from "../ActionBar/ActionBar";
import { AiInvestigation } from "../AiInvestigation/AiInvestigation";
import { IncidentTimeline } from "../IncidentTimeline/IncidentTimeline";
import { LiveVideo } from "../LiveVideo/LiveVideo";
import { openRelation } from "../RelationGraph/RelationDialog";
import { ReportBar } from "../ReportBar/ReportBar";

const TYPE: Record<Device["type"], string> = { camera: "摄像头", nvr: "录像机", switch: "交换机" };

/**
 * 检查栏详情（ui.md §4、§8，D-115）：选中设备时取代告警栏，Esc 或"返回告警"回到告警栏（V-I2）。
 * 自上而下为概要、实时画面（摄像头）、处置时间线（FR-304）、规则结论与 AI 研判（AiInvestigation，TK-117）、
 * 报告（ReportBar，TK-070）；处置操作（ActionBar，TK-052）固定在底部。
 * stale 为推送连接已断开：状态是断开前的最后值，弱化显示并标注（UP-3、V-U3）。
 */
export function DetailPanel(props: { device: Device; stale: boolean; onClose: () => void; timeline?: boolean }) {
  return <Details {...props} target={undefined} />;
}

/** 选中的人员或车辆（D-054）：类别、跟踪号、速度、所属摄像头、定位误差，下方播放所属摄像头的实时画面 */
export function TargetPanel(props: { target: Target; stale: boolean; onClose: () => void }) {
  return <Details {...props} device={undefined} />;
}

/**
 * 设备详情与目标详情共用同一个组件：在设备详情的画面上点检测框选中目标时，组件类型不变、实时画面以同一 key
 * 留在原处，同一路画面不断开重连
 */
export function Details(props: {
  device: Device | undefined;
  target: Target | undefined;
  stale: boolean;
  onClose: () => void;
  timeline?: boolean;
  /** 是否播放实时画面：监控墙上选中的摄像头已在墙上播放（选中即翻到所在页），详情不再另开一路连接 */
  video?: boolean;
}) {
  const { device, target, stale, onClose, timeline, video: withVideo = true } = props;
  const camera = device ? (device.camera ? device.id : null) : (target?.camera_id ?? null);
  // 交换机、录像机没有画面：不留一块"没有视频流"的空框
  const video = withVideo && camera && (
    <Section key="video" title="实时画面">
      {/* key：切换摄像头时重建连接与状态 */}
      <LiveVideo key={camera} deviceId={camera} />
    </Section>
  );
  if (device)
    return (
      <Drawer title={device.id} onClose={onClose} footer={<ActionBar deviceId={device.id} />}>
        {/* 画面紧跟概要：1366×768 下不必滚到底才看得到；时间线、研判与报告在其后 */}
        {[<DeviceSummary key="device" device={device} stale={stale} />, video, <DeviceSections key="sections" device={device} stale={stale} timeline={timeline} />]}
      </Drawer>
    );
  if (!target) return null;
  return (
    <Drawer title={`${CLASS_LABEL[target.object_class]} #${target.track_id}`} onClose={onClose}>
      {[<TargetInfo key="target" target={target} stale={stale} />, video]}
    </Drawer>
  );
}

function DeviceSummary(props: { device: Device; stale: boolean }) {
  const { device, stale } = props;
  const tags = deviceLook(device.state).tags.map((t) => t.text);
  return (
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
        {device.camera && (
          <>
            <dt className="text-subtle-foreground">地面映射</dt>
            <dd>{mappingText(device.camera.calibration, device.camera.reproj_error_m)}</dd>
          </>
        )}
        <dt className="text-subtle-foreground">关联</dt>
        <dd>
          <Button variant="outline" size="xs" onClick={() => openRelation(device.id)}>
            <Waypoints aria-hidden />
            查看关系图
          </Button>
        </dd>
      </dl>
  );
}

function DeviceSections(props: { device: Device; stale: boolean; timeline?: boolean }) {
  // 态势页由底部处置进度条显示五个节点，详情中不再重复（产品负责人 2026-11-09 选定）
  const { device, stale, timeline = true } = props;
  return (
    <>
      {timeline && (
        <Section title="处置时间线">
          <IncidentTimeline />
        </Section>
      )}
      <AiInvestigation deviceId={device.id} stale={stale} />
      <ReportBar deviceId={device.id} />
    </>
  );
}

function TargetInfo(props: { target: Target; stale: boolean }) {
  const { target, stale } = props;
  const speed = kmh(target.speed_mps);
  // 所属摄像头按安装参数估算时，误差含随距离增加的估算部分（D-102），如实注明（FR-902）
  const estimated = useLive((s) => (s.devices[target.camera_id] ?? s.site?.devices.find((d) => d.id === target.camera_id))?.camera?.mapping === "estimated");
  return (
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
      <dd className="tabular-nums">
        ±{target.uncertainty_m.toFixed(1)} m{estimated && " · 按安装参数估算"}
      </dd>
    </dl>
  );
}

function Stale() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Clock aria-hidden className="size-3.5" />
      数据非实时
    </span>
  );
}

/** 详情中的分区：分区标题 + 内容（面板内层级 ≤ 3，V-L4） */
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
    // 跟随视角下的 Esc 先由场景用于回到总览（已 preventDefault），详情保留（D-048）。详情被盖住时不处理：
    // 报告页或对话框打开（Esc 归它们）、管理页盖在态势或监控墙之上（Esc 用于编辑器等）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const { page } = useNav.getState();
      if (page !== "overview" && page !== "wall") return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // 占满检查栏（D-115）：内容一栏在栏内滚动，页面不随之撑高（V-L2）；底部操作区无内容时不占位
    <section aria-label="详情" className="flex min-h-0 flex-1 flex-col animate-in fade-in">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b pr-4 pl-2">
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="返回告警" className="text-muted-foreground">
          <ArrowLeft aria-hidden />
          告警
        </Button>
        <h2 className="ml-auto truncate text-base font-medium">{title}</h2>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">{children}</div>
      </ScrollArea>
      {footer && <div className="shrink-0 border-t p-3 empty:hidden">{footer}</div>}
    </section>
  );
}
