import { CircleAlert, LogOut, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { Site } from "../../lib/api";
import { type KpiData, KpiTile } from "../KpiTile/KpiTile";
import { ThemeToggle } from "../ThemeToggle/ThemeToggle";

// 指标尚无数据来源，由后续任务接入
const NO_DATA: KpiData = { status: "ready", value: null, delta: null };
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
 */
export function Shell({ site, onLogout }: { site: Site; onLogout: () => Promise<void> }) {
  const [logout, setLogout] = useState<"idle" | "pending" | "failed">("idle");

  async function handleLogout() {
    setLogout("pending");
    await onLogout();
    setLogout("failed");
  }

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_320px] grid-rows-[48px_minmax(0,1fr)_104px] gap-2 bg-page p-2 2xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-rows-[48px_minmax(0,1fr)_120px]">
      <header className="col-span-2 flex items-center gap-3 px-2">
        <span className="flex items-center gap-2 font-black">
          <span className="grid size-8 place-items-center rounded-lg bg-fg text-page">
            <ShieldCheck aria-hidden className="size-4" />
          </span>
          慧眼盾
        </span>
        <span className="rounded-full border border-line px-3 py-1 text-sm text-fg-2">{site.name}</span>
        <div className="ml-auto flex items-center gap-2">
          {/* TODO(#33): 连接状态 */}
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

      <section aria-label="场景" className="relative overflow-hidden rounded-2xl border border-line">
        {/* TODO(#33): 由平面图生成场景 */}
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
      </section>

      <aside aria-label="告警" className="row-span-2 flex flex-col rounded-2xl border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-3 font-semibold">告警</h2>
        {/* TODO(#33): 空态补"最后更新时间"（§4.1 F 区），随连接状态接入 */}
        <p className="m-auto text-sm text-fg-3">暂无告警</p>
      </aside>

      <section aria-label="攻击链" className="flex flex-col rounded-2xl border border-line bg-panel px-4 py-3">
        <h2 className="font-semibold">攻击链</h2>
        <p className="m-auto text-sm text-fg-3">无活跃攻击链</p>
      </section>
    </div>
  );
}
