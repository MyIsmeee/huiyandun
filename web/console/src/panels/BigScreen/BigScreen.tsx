import { Bell, Expand, Shrink } from "lucide-react";
import { lazy, type RefObject, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Site } from "../../lib/api";
import { Boundary, supportsWebGL2 } from "../../scene/SceneViewport";
import { useLive } from "../../store/live";
import { alertText } from "../AlertList/AlertList";
import { formatTime } from "../ConnectionStatus/ConnectionStatus";
import { EXPLODE_MS, PATROL_MS, patrolList, stamp } from "./data";
import { AreaPanel, DeviceDetailPanel, DevicesPanel, EventsPanel, FlowPanel, MetricsPanel, TrendPanel, useNow } from "./panels";
import "./bigscreen.css";

// three 与场景单独分包，只在打开大屏时加载
const ScreenScene = lazy(() => import("./ScreenScene"));

/** 设计稿高度（原项目按 1920×1080 设计，以 autofit 等比缩放）；宽度随容器，最窄按 1440 */
const DESIGN_H = 1080;
const MIN_W = 1440;

/** 浮层按高度等比缩放：设计稿高度固定 1080，宽度铺满容器（不足 1440 时按宽度缩放并留出上下边） */
function useFit(ref: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ scale: 1, width: 1920, height: DESIGN_H });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (!width || !height) return;
      const scale = Math.min(height / DESIGN_H, width / MIN_W);
      setFit({ scale, width: width / scale, height: height / scale });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return fit;
}

/**
 * 态势大屏（移植自 MF-TurbineMonitor「大型风力发电机监控平台」）：
 * 顶部标题栏（滚动通知、时钟）、左右各三块面板、中央 3D、底部操作按钮与加载遮罩的布局与交互照原项目，
 * 风机与写死的演示数据换成本系统的场景区域、摄像头与实时推送。大屏固定深色，不随控制台主题切换
 */
export function BigScreen(props: { site: Site; stale: boolean; lastFrameAt: number | null }) {
  const { site, stale, lastFrameAt } = props;
  const root = useRef<HTMLDivElement>(null);
  const fit = useFit(root);
  const pushed = useLive((s) => s.devices);
  const targets = useLive((s) => s.targets);
  const devices = useMemo(() => site.devices.map((d) => pushed[d.id] ?? d), [site.devices, pushed]);

  const [webgl2] = useState(supportsWebGL2);
  const hasScene = webgl2 && site.areas.length > 0;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const onReady = useCallback(() => setReady(true), []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = devices.find((d) => d.id === selectedId) ?? null;

  // 区域展开 / 收拢（原"设备拆解 / 组装"）：动画期间按钮不可用
  const [exploded, setExploded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setBusy(false), EXPLODE_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  // 告警巡检（原"设备告警"）：依次飞向告警中的摄像头，没有告警时巡检全部摄像头
  const [patrol, setPatrol] = useState(false);
  const [step, setStep] = useState(0);
  const [homeToken, setHomeToken] = useState(0);
  const list = useMemo(() => patrolList(devices), [devices]);
  useEffect(() => {
    if (!patrol) return;
    const timer = setInterval(() => setStep((s) => s + 1), PATROL_MS);
    return () => clearInterval(timer);
  }, [patrol]);
  const focusId = patrol ? (list.ids[step % Math.max(list.ids.length, 1)] ?? null) : null;
  const focusName = devices.find((d) => d.id === focusId)?.name;
  const togglePatrol = () => {
    if (patrol) setHomeToken((t) => t + 1);
    setStep(0);
    setPatrol(!patrol);
  };

  const [full, setFull] = useState(false);
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  const toggleFull = () => (full ? void document.exitFullscreen() : void root.current?.requestFullscreen().catch(() => undefined));

  return (
    <div ref={root} className="bs-root" data-scene={ready ? "ready" : "loading"}>
      <div role="region" aria-label="大屏场景" className={stale ? "bs-stage stale" : "bs-stage"}>
        {hasScene && !failed && (
          <Boundary onError={() => setFailed(true)}>
            <Suspense fallback={null}>
              <ScreenScene
                site={site}
                devices={devices}
                targets={targets}
                exploded={exploded}
                focusId={focusId}
                selectedId={selectedId}
                homeToken={homeToken}
                onPick={setSelectedId}
                onReady={onReady}
              />
            </Suspense>
          </Boundary>
        )}
        {!hasScene && (
          <p className="bs-stage-note">{webgl2 ? "尚未搭建场景区域 · 请在「管理 → 场景」中添加" : "浏览器不支持 WebGL2，大屏 3D 不可用"}</p>
        )}
        {failed && <p className="bs-stage-note">场景加载失败</p>}
      </div>
      <div className="bs-vignette" aria-hidden />

      <div
        className="bs-surface"
        style={{
          width: fit.width,
          height: fit.height,
          transform: `scale(${fit.scale})`,
        }}
      >
        <Header site={site} stale={stale} lastFrameAt={lastFrameAt} full={full} onFull={toggleFull} />
        <div className="bs-col left">
          <MetricsPanel devices={devices} stale={stale} />
          <TrendPanel />
          <FlowPanel />
        </div>
        <div className="bs-col right">
          {selected ? (
            <DeviceDetailPanel device={selected} site={site} onClose={() => setSelectedId(null)} />
          ) : (
            <DevicesPanel devices={devices} />
          )}
          <AreaPanel site={site} devices={devices} />
          <EventsPanel devices={devices} />
        </div>
        <footer className="bs-footer">
          {patrol && (
            <p className="bs-footer-hint" role="status">
              {focusName
                ? `巡检中：${focusName}（${(step % list.ids.length) + 1}/${list.ids.length}）${list.alerting ? "" : " · 当前无告警，巡检全部摄像头"}`
                : "没有可巡检的摄像头"}
            </p>
          )}
          <div className="bs-footer-bar">
            <button type="button" aria-pressed={patrol} disabled={!hasScene} onClick={togglePatrol}>
              {patrol ? "停止巡检" : "告警巡检"}
            </button>
            <button
              type="button"
              aria-pressed={exploded}
              disabled={!hasScene || busy}
              onClick={() => {
                setExploded(!exploded);
                setBusy(true);
              }}
            >
              {exploded ? "区域收拢" : "区域展开"}
            </button>
            <button type="button" disabled={!hasScene} onClick={() => setHomeToken((t) => t + 1)}>
              视角复位
            </button>
          </div>
        </footer>
      </div>

      {hasScene && !failed && !ready && (
        <div className="bs-loading" role="status">
          <span className="bs-spinner" aria-hidden />
          场景正在加载中…
        </div>
      )}
    </div>
  );
}

const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** 标题栏（原 LayoutHeader）：左侧滚动最新告警，中间标题，右侧时钟、站点与全屏 */
function Header(props: { site: Site; stale: boolean; lastFrameAt: number | null; full: boolean; onFull: () => void }) {
  const { site, stale, lastFrameAt, full, onFull } = props;
  const now = useNow(1000);
  const latest = useLive((s) => s.alerts[0]);
  const names = useMemo(() => new Map(site.devices.map((d) => [d.id, d.name])), [site.devices]);
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  let message = "【系统通知】系统运行正常，暂无告警";
  if (latest) {
    const { title, device } = alertText(latest);
    message = `【最新告警】${stamp(Date.parse(latest.ts))} · ${(device && names.get(device)) ?? device ?? "未登记设备"} · ${title}`;
  }
  return (
    <header className="bs-header">
      <div className="bs-header-left">
        <Bell aria-hidden />
        <div className="bs-marquee" aria-live="polite">
          <span key={message}>{message}</span>
        </div>
      </div>
      <div className="bs-title">
        <h1>慧眼盾 · 安全态势大屏</h1>
        <p>HUIYANDUN SECURITY SITUATION MONITORING PLATFORM</p>
      </div>
      <div className="bs-header-right">
        {stale && <span className="bs-stale">连接中断 · 最后更新 {formatTime(lastFrameAt)}</span>}
        <span className="mono">
          {p(d.getHours())}:{p(d.getMinutes())}:{p(d.getSeconds())}
        </span>
        <span className="mono">
          {d.getFullYear()}/{p(d.getMonth() + 1)}/{p(d.getDate())}
        </span>
        <span>{WEEK[d.getDay()]}</span>
        <span>{site.name}</span>
        <button type="button" className="bs-icon-btn" aria-label={full ? "退出全屏" : "全屏显示"} onClick={onFull}>
          {full ? <Shrink aria-hidden /> : <Expand aria-hidden />}
        </button>
      </div>
    </header>
  );
}
