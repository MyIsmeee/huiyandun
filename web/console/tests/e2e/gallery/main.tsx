import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Site } from "../../../src/lib/api";
import { KpiTile } from "../../../src/panels/KpiTile/KpiTile";
import { FloorPlan2D } from "../../../src/scene/FloorPlan2D";
import { planView } from "../../../src/scene/layout";
import "../../../src/theme/store";
import "../../../src/theme/theme.css";

const SITE: Site = {
  id: "demo-office",
  name: "演示办公区",
  width_m: 40,
  height_m: 24,
  walls: [
    [0, 0, 40, 0],
    [40, 0, 40, 24],
    [40, 24, 0, 24],
    [0, 24, 0, 0],
  ],
  zones: [{ id: "z-01", name: "设备间外墙", polygon: [[30, 0], [40, 0], [40, 6], [30, 6]], no_climb: true }],
  devices: [],
};
const PLAN_SIZE = { width: 640, height: 400 };
const plan = (site: Site) => (
  <div className="relative" style={PLAN_SIZE}>
    <FloorPlan2D site={site} view={planView(site, PLAN_SIZE)} />
  </div>
);

// 组件各状态的展示页：/tests/e2e/gallery/?component=<组件>，每个状态一个 [data-state]
const GALLERY: Record<string, Record<string, ReactNode>> = {
  KpiTile: {
    normal: <KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: 3, delta: 2 }} />,
    empty: <KpiTile label="活跃告警" unit="条" data={{ status: "ready", value: null, delta: null }} />,
    loading: <KpiTile label="活跃告警" unit="条" data={{ status: "loading" }} />,
    stale: <KpiTile label="活跃告警" unit="条" data={{ status: "stale", value: 3, delta: -1 }} />,
  },
  FloorPlan2D: {
    normal: plan(SITE),
    empty: plan({ ...SITE, walls: [], zones: [] }),
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
