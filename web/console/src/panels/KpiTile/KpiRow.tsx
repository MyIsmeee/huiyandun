import { useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { api } from "../../lib/api";
import { type KpiData, KpiTile } from "./KpiTile";

type Kpis = components["schemas"]["Kpis"];

const POLL_MS = 5_000;
/** 毫秒按秒显示，保留 1 位小数 */
const seconds = (ms: number) => (ms / 1000).toFixed(1);

const KPIS: { key: keyof Kpis; label: string; unit: string; since?: string; format?: (v: number) => string }[] = [
  { key: "online_devices", label: "在线设备", unit: "台" },
  { key: "active_alerts", label: "活跃告警", unit: "条" },
  { key: "contained_today", label: "今日已处置", unit: "起" },
  // 从首条攻击告警到处置通过校验（D-106）
  { key: "last_contain_ms", label: "最近处置用时", unit: "秒", since: "较上一次", format: seconds },
];

/** 浏览器本地当天 0 点，"今日已处置"由此起算（D-100） */
function dayStart(): string {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}

/**
 * 关键指标（ui.md §4）：监控墙工具条中的一行，或态势页左上的一排浮动卡片（cards）。每 5 s 拉取一次，上一次返回后再计时，请求不会叠加。
 * 拉取失败或断线时保留上次数值并标为陈旧，无上次数值显示 —（§8 KpiTile）。
 */
export function KpiRow({ stale, cards = false }: { stale: boolean; cards?: boolean }) {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    async function poll() {
      const next = await api.getKpis(dayStart()).catch(() => null);
      if (!active) return;
      if (next) setKpis(next);
      setFailed(!next);
      timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  const data = (key: keyof Kpis): KpiData =>
    kpis === null && !failed && !stale
      ? { status: "loading" }
      : { status: failed || stale ? "stale" : "ready", value: kpis?.[key].value ?? null, delta: kpis?.[key].delta ?? null };
  return (
    <ul aria-label="关键指标" className={cards ? "flex gap-3" : "flex items-center divide-x"}>
      {KPIS.map(({ key, label, unit, since, format }) => (
        <li key={key}>
          <KpiTile label={label} unit={unit} since={since} format={format} data={data(key)} card={cards} />
        </li>
      ))}
    </ul>
  );
}
