import { Car, Cctv, ShieldCheck, Siren, Timer, TriangleAlert, Users, Waypoints, WifiOff, X, type LucideIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Device, Site } from "../../store/live";
import { useLive } from "../../store/live";
import { mappingText } from "../../scene/devices";
import { DEVICE_STATE } from "../RelationGraph/model";
import { SEVERITY } from "../AlertList/AlertList";
import { useKpis } from "../KpiTile/KpiRow";
import { BarChart, LineChart } from "./charts";
import { areaDistribution, deviceRows, eventRows, hourlyTrend, stamp, targetCounts, TONE_COLOR, type Tone } from "./data";

/** 两个系列的固定颜色（深色底上经配色校验：亮度、色觉障碍区分与对比度均通过） */
export const SERIES = {
  cyber: { name: "网络告警", color: "#10a87d" },
  physical: { name: "物理告警", color: "#4f8fd0" },
} as const;

/** 面板：标题条 + 内容（原项目 LayoutPanel 的背景图改为渐变与描边绘制） */
export function Panel({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="bs-panel" aria-label={title}>
      <header className="bs-panel-head">
        <h2>{title}</h2>
        {extra}
      </header>
      <div className="bs-panel-body">{children}</div>
    </section>
  );
}

/** 每 ms 刷新一次的当前时刻 */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** 行高与行距（px），与样式一致 */
const ROW = 34;
const ROW_GAP = 8;

/**
 * 自动滚动列表（原项目运行监测、偏航角度监测）：放不下时每 3 s 上移一行并把首行移到末尾；
 * 指针停在列表上时暂停，减少动态效果时直接换行不做位移动画
 */
export function ScrollList<T extends { key: string; tone: Tone }>(props: { rows: T[]; render: (row: T) => ReactNode; empty: string }) {
  const { rows, render, empty } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [moving, setMoving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(
      ([entry]) => entry && setVisible(Math.floor((entry.contentRect.height + ROW_GAP) / (ROW + ROW_GAP))),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scrolls = rows.length > visible && visible > 0;
  useEffect(() => {
    if (!scrolls || paused) return;
    const timer = setInterval(() => (reducedMotion() ? setOffset((o) => o + 1) : setMoving(true)), 3000);
    return () => clearInterval(timer);
  }, [scrolls, paused]);
  const n = rows.length;
  const start = scrolls ? offset % n : 0;
  const list = [...rows.slice(start), ...rows.slice(0, start)];
  return (
    <div ref={ref} className="bs-scroll" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      {n === 0 ? (
        <p className="bs-empty">{empty}</p>
      ) : (
        <ul
          className={moving ? "bs-scroll-track moving" : "bs-scroll-track"}
          onAnimationEnd={() => {
            setMoving(false);
            setOffset((o) => o + 1);
          }}
        >
          {list.map((row) => (
            <li key={row.key} className="bs-row" style={{ "--tone": TONE_COLOR[row.tone] } as CSSProperties}>
              <i className="bs-row-bar" />
              {render(row)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 左一 · 运行指标（原"参数监测"九宫格）：数值异常时整格高亮并显示角标 */
export function MetricsPanel({ devices, stale }: { devices: Device[]; stale: boolean }) {
  const { kpis, failed } = useKpis();
  const targets = useLive((s) => s.targets);
  const incidents = useLive((s) => s.incidents);
  const { person, vehicle } = useMemo(() => targetCounts(targets), [targets]);
  const kpi = (key: keyof NonNullable<typeof kpis>) => kpis?.[key].value ?? null;
  const contain = kpi("last_contain_ms");
  const offline = devices.filter((d) => d.state === "offline").length;
  const openIncidents = incidents.filter((i) => i.status === "open" || i.status === "containing").length;
  const tiles: {
    icon: LucideIcon;
    label: string;
    value: number | string | null;
    unit: string;
    warn?: boolean;
  }[] = [
    { icon: Cctv, label: "在线设备", value: kpi("online_devices"), unit: "台" },
    {
      icon: Siren,
      label: "活跃告警",
      value: kpi("active_alerts"),
      unit: "条",
      warn: (kpi("active_alerts") ?? 0) > 0,
    },
    {
      icon: ShieldCheck,
      label: "今日已处置",
      value: kpi("contained_today"),
      unit: "起",
    },
    {
      icon: Timer,
      label: "最近处置用时",
      value: contain === null ? null : (contain / 1000).toFixed(1),
      unit: "秒",
    },
    {
      icon: Cctv,
      label: "接入摄像头",
      value: devices.filter((d) => d.type === "camera").length,
      unit: "路",
    },
    {
      icon: WifiOff,
      label: "离线设备",
      value: offline,
      unit: "台",
      warn: offline > 0,
    },
    { icon: Users, label: "当前人员", value: person, unit: "人" },
    { icon: Car, label: "当前车辆", value: vehicle, unit: "辆" },
    {
      icon: Waypoints,
      label: "未结关联事件",
      value: openIncidents,
      unit: "起",
      warn: openIncidents > 0,
    },
  ];
  const old = stale || failed;
  return (
    <Panel title="运行指标" extra={old ? <span className="bs-stale">数据未更新</span> : undefined}>
      <ul className="bs-metrics">
        {tiles.map(({ icon: Icon, label, value, unit, warn }) => (
          <li key={label} className={warn ? "warn" : undefined}>
            <span className="bs-metric-icon">
              <Icon aria-hidden />
            </span>
            <span className="bs-metric-label">{label}</span>
            <span className="bs-metric-value">
              <b>{value ?? "—"}</b>
              {value !== null && <small>{unit}</small>}
            </span>
            {warn && <TriangleAlert aria-label="需关注" className="bs-metric-alert" />}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** 左二 · 告警趋势（原"历史功率"）：近 24 小时每小时的网络与物理告警数 */
export function TrendPanel() {
  const alerts = useLive((s) => s.alerts);
  const now = useNow(60_000);
  const trend = useMemo(() => hourlyTrend(alerts, now), [alerts, now]);
  return (
    <Panel title="告警趋势 · 近 24 小时">
      <LineChart
        label="近 24 小时每小时告警数"
        labels={trend.labels}
        series={[
          { ...SERIES.cyber, values: trend.cyber },
          { ...SERIES.physical, values: trend.physical },
        ]}
      />
    </Panel>
  );
}

/** 目标流量的采样间隔与保留个数：每 5 s 一个点，保留 3 分钟 */
const SAMPLE_MS = 5_000;
const SAMPLES = 36;

/** 左三 · 目标流量（原"日发电量监测"）：画面中人员与车辆总数，每 5 s 采样 */
export function FlowPanel() {
  const [samples, setSamples] = useState<{ at: number; count: number }[]>([]);
  useEffect(() => {
    const take = () => {
      const count = Object.keys(useLive.getState().targets).length;
      setSamples((s) => [...s, { at: Date.now(), count }].slice(-SAMPLES));
    };
    take();
    const timer = setInterval(take, SAMPLE_MS);
    return () => clearInterval(timer);
  }, []);
  const labels = samples.map(({ at }) =>
    new Date(at).toLocaleTimeString("zh-CN", {
      hour12: false,
      minute: "2-digit",
      second: "2-digit",
    }),
  );
  return (
    <Panel title="目标流量 · 每 5 秒">
      <BarChart
        label="画面中目标数"
        unit=" 个"
        labels={labels}
        series={[
          {
            name: "目标数",
            color: SERIES.cyber.color,
            values: samples.map((s) => s.count),
          },
        ]}
      />
    </Panel>
  );
}

/** 右一 · 设备运行（原"运行监测"）：告警中的设备排在前面 */
export function DevicesPanel({ devices }: { devices: Device[] }) {
  const rows = useMemo(() => deviceRows(devices).map((r) => ({ ...r, key: r.id })), [devices]);
  const alerting = rows.filter((r) => r.tone === "cyber" || r.tone === "physical").length;
  return (
    <Panel title="设备运行" extra={<span className="bs-count">{alerting > 0 ? `${alerting} 台告警` : `${rows.length} 台正常运行`}</span>}>
      <ScrollList
        rows={rows}
        empty="尚未接入设备"
        render={(r) => (
          <>
            <span className="bs-cell grow">{r.name}</span>
            <span className="bs-cell mono dim">{r.ip}</span>
            <span className="bs-cell state">{r.state}</span>
          </>
        )}
      />
    </Panel>
  );
}

const MODE: Record<Device["mode"], string> = {
  bypass: "旁路监测",
  host_probe: "主机探针",
};
const TYPE: Record<Device["type"], string> = {
  camera: "摄像头",
  nvr: "录像机",
  switch: "交换机",
};

/** 右一（选中设备时）· 设备详情（原 WidgetPanel07 部件详情的 4×4 参数格） */
export function DeviceDetailPanel({ device, site, onClose }: { device: Device; site: Site; onClose: () => void }) {
  const targets = useLive((s) => s.targets);
  const alerts = useLive((s) => s.alerts);
  const cam = device.camera;
  const pose = cam?.pose;
  const area = site.areas.find((a) => a.id === cam?.area_id)?.name;
  const live = Object.values(targets).filter((t) => t.camera_id === device.id).length;
  const last = alerts.find((a) => ("camera_id" in a ? a.camera_id : a.device_id) === device.id);
  const deg = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v)}°`);
  const meter = (v: number | undefined) => (v === undefined ? "—" : `${v.toFixed(1)} 米`);
  const items: [string, string][] = [
    ["设备编号", device.id],
    ["设备类型", TYPE[device.type]],
    ["IP 地址", device.ip],
    ["接入方式", MODE[device.mode]],
    ["运行状态", DEVICE_STATE[device.state]],
    ["告警等级", device.alert_severity ? SEVERITY[device.alert_severity] : "—"],
    ["所在区域", area ?? "未放置"],
    ["当前目标", `${live} 个`],
    ["安装高度", meter(pose?.height_m)],
    ["朝向", deg(pose?.yaw_deg)],
    ["俯角", deg(pose?.pitch_deg)],
    ["水平视场", deg(pose?.hfov_deg)],
    ["可视距离", meter(pose?.range_m)],
    ["地面映射", cam ? (cam.mapping === "none" ? "未标定" : mappingText(cam.calibration, cam.reproj_error_m)) : "—"],
    ["坐标", pose ? `${pose.x.toFixed(1)}, ${pose.y.toFixed(1)}` : "—"],
    ["最近告警", last ? stamp(Date.parse(last.ts)) : "无"],
  ];
  return (
    <Panel
      title={`${device.name} · 详情`}
      extra={
        <button type="button" className="bs-close" aria-label="关闭详情" onClick={onClose}>
          <X aria-hidden />
        </button>
      }
    >
      <dl className="bs-detail">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd title={v}>{v}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/** 右二 · 区域告警分布（原"故障对比"分组柱）：各区域的网络与物理告警数 */
export function AreaPanel({ site, devices }: { site: Site; devices: Device[] }) {
  const alerts = useLive((s) => s.alerts);
  const rows = useMemo(() => areaDistribution(alerts, devices, site.areas), [alerts, devices, site.areas]);
  return (
    <Panel title="区域告警分布">
      {rows.length === 0 ? (
        <p className="bs-empty">尚未搭建场景区域</p>
      ) : (
        <BarChart
          label="各区域告警数"
          unit=" 条"
          labels={rows.map((r) => r.name)}
          series={[
            { ...SERIES.cyber, values: rows.map((r) => r.cyber) },
            { ...SERIES.physical, values: rows.map((r) => r.physical) },
          ]}
        />
      )}
    </Panel>
  );
}

/** 右三 · 实时事件（原"偏航角度监测"滚动列表）：最近的告警 */
export function EventsPanel({ devices }: { devices: Device[] }) {
  const alerts = useLive((s) => s.alerts);
  const rows = useMemo(() => eventRows(alerts, devices).map((r) => ({ ...r, key: r.id })), [alerts, devices]);
  return (
    <Panel title="实时事件" extra={<span className="bs-count">{alerts.length} 条</span>}>
      <ScrollList
        rows={rows}
        empty="暂无告警"
        render={(r) => (
          <>
            <span className="bs-cell grow" title={r.title}>
              {r.title}
            </span>
            <span className="bs-cell dim" title={r.device}>
              {r.device}
            </span>
            <span className="bs-cell state">{r.level}</span>
            <span className="bs-cell mono">{stamp(r.at)}</span>
          </>
        )}
      />
    </Panel>
  );
}
