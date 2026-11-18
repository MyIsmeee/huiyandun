import { Bot, Check, Loader2, Radar, ShieldCheck, Siren, Waypoints, X, type LucideIcon } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Site, useLive } from "../../store/live";
import { select } from "../../store/selection";
import { openInvestigation } from "../InvestigationSheet/sheet";
import { openRelation } from "../RelationGraph/RelationDialog";
import { durationText, type Phase, type Threat, threatOf } from "./threat";

/** 横幅底色：攻击为告警红，已阻断为加深的处置绿（白字对比度 ≥ 4.5:1），处置中由红过渡到绿 */
const BACKGROUND: Record<Phase, string> = {
  attack: "var(--color-cyber)",
  confirm: "var(--color-cyber)",
  notified: "var(--color-cyber)",
  defending: "linear-gradient(90deg, var(--color-cyber), color-mix(in srgb, var(--color-contained) 70%, black))",
  contained: "color-mix(in srgb, var(--color-contained) 70%, black)",
};
const ICON: Record<Phase, LucideIcon> = { attack: Siren, confirm: Siren, notified: Siren, defending: Radar, contained: ShieldCheck };

/**
 * 攻防态势横幅（顶栏下方，评委与值班员一眼可见）：有设备被网络攻击时整条变红并在屏幕边缘呼吸红光；
 * AI 防护处置中转为红到绿渐变；阻断后变绿并给出"从发现到阻断"的用时。右侧四步进程：发现攻击 → AI 研判 →
 * 自动处置 → 攻击已阻断。状态色同时配图标与文字（V-S3），降低动效或断线时动效停止（V-A4、V-U3）。
 */
export function ThreatBanner({ site }: { site: Site }) {
  const devices = useLive((s) => s.devices);
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents);
  const executions = useLive((s) => s.executions);
  const aiSeq = useLive((s) => s.aiSeq);
  const aiDone = useLive((s) => s.aiDone);
  const threat = useMemo(
    () => threatOf({ devices, alerts, incidents, executions, aiSeq, aiDone }, site.devices),
    [devices, alerts, incidents, executions, aiSeq, aiDone, site.devices],
  );
  const [dismissed, setDismissed] = useState<string | null>(null);
  const flash = useContainedFlash(threat?.phase ?? null);
  const now = useTicker(threat !== null && threat.phase !== "contained");

  // 已阻断的横幅可以收起；之后再有攻击（阶段或执行变化）重新出现
  const key = threat ? `${threat.phase}:${threat.execution?.id ?? threat.devices[0]?.id}` : null;
  const shown = threat && !(threat.phase === "contained" && dismissed === key);

  return (
    <>
      {threat?.phase === "attack" || threat?.phase === "confirm" ? (
        <div aria-hidden data-attack-glow className="pointer-events-none fixed inset-0 z-30 animate-alarm-glow" />
      ) : null}
      {flash > 0 && <div key={flash} aria-hidden data-contained-flash className="pointer-events-none fixed inset-0 z-30 animate-fade-out shadow-[inset_0_0_0_4px_var(--color-contained),inset_0_0_120px_color-mix(in_srgb,var(--color-contained)_55%,transparent)]" />}
      {shown && <Banner threat={threat} now={now} onDismiss={() => setDismissed(key)} />}
    </>
  );
}

function Banner({ threat, now, onDismiss }: { threat: Threat; now: number; onDismiss: () => void }) {
  const { phase, devices, incident, execution, source, title, startedAt, containedAt } = threat;
  const lead = devices[0];
  const Icon = ICON[phase];
  const who = !lead ? "设备" : lead.name && lead.name !== lead.id ? `${lead.name}（${lead.id}）` : lead.id;
  const more = devices.length > 1 ? ` 等 ${devices.length} 台设备` : "";
  const target = execution?.target ?? source;
  const elapsed = startedAt !== null ? durationText(now - startedAt) : null;
  const used = startedAt !== null && containedAt !== null ? durationText(containedAt - startedAt) : null;

  const headline = {
    attack: `${who}${more} 正在遭受网络攻击`,
    confirm: `${who}${more} 正在遭受网络攻击 · 处置待值班员确认`,
    defending: `AI 防护正在处置 · 封禁攻击源 ${target ?? ""}`,
    notified: `${who}${more} 遭受网络攻击 · 已通知，待联动处置`,
    contained: `AI 防护已阻断攻击${target ? ` · 攻击源 ${target} 已封禁` : ""}`,
  }[phase];
  const detail = [
    phase === "contained" || phase === "defending" ? who : null,
    title,
    phase !== "contained" && source ? `攻击源 ${source}` : null,
    phase === "contained" ? (used ? `从发现到阻断用时 ${used}` : "设备已恢复安全") : elapsed ? `已持续 ${elapsed}` : null,
  ].filter(Boolean);

  return (
    <section
      role={phase === "contained" ? "status" : "alert"}
      aria-label="攻防态势"
      data-threat={phase}
      style={{ background: BACKGROUND[phase] }}
      className="relative z-10 flex shrink-0 items-center gap-4 px-4 py-2.5 text-white shadow-md"
    >
      <span className="relative grid size-12 shrink-0 place-items-center">
        {phase !== "contained" && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-white/40" />}
        <span className="relative grid size-12 place-items-center rounded-full bg-white/20 ring-2 ring-white/70">
          <Icon aria-hidden className={cn("size-6", phase === "defending" && "animate-spin [animation-duration:2.5s]")} />
        </span>
      </span>
      {/* 防护进程放在文字下方、靠左：研判面板自动打开盖住右侧时仍完整可见 */}
      <div className="min-w-0 flex-1">
        <button type="button" className="block max-w-full text-left" onClick={() => lead && select(lead.id)} aria-label={`${headline}，查看设备`}>
          <p className="truncate text-lg leading-tight font-semibold">{headline}</p>
          <p className="mt-0.5 truncate text-xs text-white/85 tabular-nums">{detail.join(" · ")}</p>
        </button>
        <Steps threat={threat} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {incident && (
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/15 hover:text-white" onClick={() => openInvestigation(incident.id)}>
            <Bot aria-hidden />
            AI 研判
          </Button>
        )}
        {lead && (
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/15 hover:text-white" onClick={() => openRelation(lead.id)}>
            <Waypoints aria-hidden />
            关系图
          </Button>
        )}
        {phase === "contained" && (
          <Button size="icon" variant="ghost" aria-label="收起" className="size-8 text-white hover:bg-white/15 hover:text-white" onClick={onDismiss}>
            <X aria-hidden />
          </Button>
        )}
      </div>
    </section>
  );
}

type StepState = "done" | "active" | "waiting";

/** 四步防护进程：每步配图标与文字，进行中的一步转圈 */
function Steps({ threat }: { threat: Threat }) {
  const { phase, ai } = threat;
  const handled = phase === "contained";
  const handling = phase === "defending";
  const steps: { label: string; state: StepState }[] = [
    { label: "发现攻击", state: "done" },
    {
      label: ai.state === "done" ? "AI 研判完成" : ai.state === "running" ? `AI 研判中 · ${ai.steps} 步` : "AI 研判",
      state: ai.state === "done" || handled ? "done" : ai.state === "running" || threat.incident ? "active" : "waiting",
    },
    {
      label: { attack: "自动处置", confirm: "待人工确认", defending: "正在封禁", notified: "已通知 · 待联动", contained: "已封禁攻击源" }[phase],
      state: handled ? "done" : handling || phase === "confirm" || phase === "notified" ? "active" : "waiting",
    },
    // 未阻断时写目标"阻断攻击"：旁路模式只能通知，不得出现"已阻断"（V-T1）
    { label: handled ? "攻击已阻断" : "阻断攻击", state: handled ? "done" : "waiting" },
  ];
  return (
    <ol aria-label="防护进程" className="mt-2 flex flex-wrap items-center gap-1.5">
      {steps.map((step, i) => (
        <li key={step.label} data-step={step.state} className="flex items-center gap-1.5">
          {i > 0 && <span aria-hidden className={cn("h-0.5 w-5 rounded-full", step.state === "waiting" ? "bg-white/30" : "bg-white")} />}
          <span
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 py-1 text-xs whitespace-nowrap",
              step.state === "done" && "bg-white font-medium text-foreground",
              step.state === "active" && "bg-white/20 font-medium ring-1 ring-white",
              step.state === "waiting" && "text-white/60 ring-1 ring-white/30",
            )}
          >
            {step.state === "done" ? (
              <Check aria-hidden className="size-3.5 text-contained" />
            ) : step.state === "active" ? (
              <Loader2 aria-hidden className="size-3.5 animate-spin" />
            ) : null}
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** 秒级时钟：每秒通知一次；同一秒内返回同一个值，供 useSyncExternalStore 比较 */
const subscribeClock = (notify: () => void) => {
  const timer = setInterval(notify, 1000);
  return () => clearInterval(timer);
};
const subscribeNever = () => () => undefined;
const secondNow = () => Math.floor(Date.now() / 1000) * 1000;

/** 当前时刻（攻击持续时长），active 时每秒刷新 */
function useTicker(active: boolean): number {
  return useSyncExternalStore(active ? subscribeClock : subscribeNever, secondNow);
}

/**
 * 由攻击或处置中转为已阻断的那一刻，屏幕边缘绿光一闪：返回递增的序号作为闪光元素的 key，每次转为已阻断重播一次
 * 淡出动画（终态不可见）；0 为不闪。在渲染中比较上一阶段（React 推荐的"随属性变化调整状态"写法）
 */
function useContainedFlash(phase: Phase | null): number {
  const [previous, setPrevious] = useState(phase);
  const [count, setCount] = useState(0);
  if (phase !== previous) {
    setPrevious(phase);
    if (phase === "contained" && previous !== null) setCount((n) => n + 1);
  }
  return phase === "contained" ? count : 0;
}
