import { CircleAlert, Clock, LogOut, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { Site } from "../../lib/api";
import { SceneViewport } from "../../scene/SceneViewport";
import { connect, useConnection } from "../../store/connection";
import { useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { AlertList } from "../AlertList/AlertList";
import { ConnectionStatus, formatTime } from "../ConnectionStatus/ConnectionStatus";
import { DetailPanel, TargetPanel } from "../DetailPanel/DetailPanel";
import { type KpiData, KpiTile } from "../KpiTile/KpiTile";
import { ThemeToggle } from "../ThemeToggle/ThemeToggle";

// 指标尚无数据来源，由后续任务接入
const NO_DATA: KpiData = { status: "ready", value: null, delta: null };
const deselect = () => select(null);
const KPIS = [
  { label: "在线设备", unit: "台" },
  { label: "活跃告警", unit: "条" },
  { label: "今日已处置", unit: "起" },
  { label: "检测时延 P95", unit: "ms" },
];

/**
 * 主界面分区（HYD-UIX-004 §4.1）：位置固定、不可拖拽（V-L1）；场景视口面积占比 ≥ 50%（V-L2）。
 * D 详情面板在选中对象时展开，未选中时收起，由 F 列表占满右栏。
 * onLogout 完成后若仍渲染本页，说明会话仍有效、退出未成功。
 * 进入即连接 WS；连接被拒时调用 onRejected 核对会话。
 */
export function Shell(props: { site: Site; onLogout: () => Promise<void>; onRejected: () => void }) {
  const { site, onLogout, onRejected } = props;
  const [logout, setLogout] = useState<"idle" | "pending" | "failed">("idle");
  const { open, connecting, lastFrameAt } = useConnection();
  const offline = !open && !connecting;
  useEffect(() => connect(onRejected), [onRejected]);
  // 设备状态以推送为准，未推送过的取 GET /api/site 的初始值
  const selectedId = useSelection((s) => s.deviceId);
  const pushed = useLive((s) => (selectedId ? s.devices[selectedId] : undefined));
  const selected = pushed ?? site.devices.find((d) => d.id === selectedId);
  const targetKey = useSelection((s) => s.targetKey);
  const target = useLive((s) => (targetKey ? s.targets[targetKey] : undefined));
  // 选中的目标离开画面（2 s 无更新被移除，V-U4）即取消选中、收起详情（D-054）
  useEffect(() => {
    if (targetKey && !target) deselect();
  }, [targetKey, target]);

  async function handleLogout() {
    setLogout("pending");
    await onLogout();
    setLogout("failed");
  }

  return (
    <div
      data-live={!offline}
      className="grid h-full grid-cols-[minmax(0,1fr)_320px] grid-rows-[48px_minmax(0,1fr)_104px] gap-2 bg-page p-2 2xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-rows-[48px_minmax(0,1fr)_120px]"
    >
      <header className="col-span-2 flex items-center gap-3 px-2">
        <span className="flex items-center gap-2 font-black">
          <span className="grid size-8 place-items-center rounded-lg bg-fg text-page">
            <ShieldCheck aria-hidden className="size-4" />
          </span>
          慧眼盾
        </span>
        <span className="rounded-full border border-line px-3 py-1 text-sm text-fg-2">{site.name}</span>
        <div className="ml-auto flex items-center gap-2">
          <ConnectionStatus />
          {logout === "failed" && (
            <p role="alert" className="flex items-center gap-1 text-sm">
              <CircleAlert aria-hidden className="size-4" />
              退出失败，请重试
            </p>
          )}
          <ThemeToggle />
          <button
            onClick={handleLogout}
            disabled={logout === "pending"}
            aria-label="退出登录"
            className="flex h-9 items-center gap-2 rounded-full border border-line px-3 text-sm text-fg-2 transition-colors hover:bg-raised hover:text-fg disabled:opacity-40"
          >
            <LogOut aria-hidden className="size-4" />
            {logout === "pending" ? "退出中…" : "退出"}
          </button>
        </div>
      </header>

      {/* 断线时场景饱和度降至 50%（V-U3） */}
      <section
        aria-label="场景"
        className={`relative overflow-hidden rounded-2xl border border-line ${offline ? "saturate-50" : ""}`}
      >
        <SceneViewport site={site} />
        {/* 4 张卡共用一块半透明底板，计为一个浮层（V-L3） */}
        <ul
          aria-label="关键指标"
          className="absolute top-3 left-3 flex divide-x divide-line rounded-2xl border border-line bg-panel/80 backdrop-blur"
        >
          {KPIS.map((kpi) => (
            <li key={kpi.label}>
              <KpiTile {...kpi} data={NO_DATA} />
            </li>
          ))}
        </ul>
        {offline && (
          <p className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-dashed border-uncertain bg-panel/80 px-4 py-1.5 text-sm text-uncertain backdrop-blur">
            <Clock aria-hidden className="size-4" />
            数据非实时 · 最后更新 {formatTime(lastFrameAt)}
          </p>
        )}
      </section>

      <div className="row-span-2 flex min-h-0 flex-col gap-2">
        {selected && <DetailPanel device={selected} stale={offline} onClose={deselect} />}
        {target && <TargetPanel target={target} stale={offline} onClose={deselect} />}
        <aside aria-label="告警" className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-panel">
          <h2 className="border-b border-line px-4 py-3 font-semibold">告警</h2>
          <AlertList lastFrameAt={lastFrameAt} />
        </aside>
      </div>

      <section aria-label="攻击链" className="flex flex-col rounded-2xl border border-line bg-panel px-4 py-3">
        <h2 className="font-semibold">攻击链</h2>
        <p className="m-auto text-sm text-fg-3">无活跃攻击链</p>
      </section>
    </div>
  );
}
