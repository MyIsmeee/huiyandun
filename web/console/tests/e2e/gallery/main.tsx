import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { KpiTile } from "../../../src/panels/KpiTile/KpiTile";
import "../../../src/theme/store";
import "../../../src/theme/theme.css";

// 组件各状态的展示页：/tests/e2e/gallery/?component=<组件>，每个状态一个 [data-state]
const GALLERY: Record<string, Record<string, ReactNode>> = {
  KpiTile: {
    normal: <KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: 3, delta: 2 }} />,
    empty: <KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: null, delta: null }} />,
    loading: <KpiTile label="活跃告警" unit="条" data={{ status: "loading" }} />,
    stale: <KpiTile label="活跃告警" unit="条" data={{ status: "stale", value: 3, delta: -1 }} />,
  },
};

const states = GALLERY[new URLSearchParams(location.search).get("component") ?? ""] ?? {};
const root = document.getElementById("root");
if (!root) throw new Error("index.html 缺少 #root");

createRoot(root).render(
  <main className="flex flex-wrap items-start gap-4 p-6">
    {Object.entries(states).map(([state, node]) => (
      <figure key={state} data-state={state} className="rounded-2xl bg-panel">
        {node}
      </figure>
    ))}
  </main>,
);
