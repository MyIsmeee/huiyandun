import { BellRing, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../../lib/api";
import { type Alert, type Behavior, type RuleEvent, useLive } from "../../store/live";
import { go } from "../../store/nav";
import { select } from "../../store/selection";
import { canContain, useSession } from "../../store/session";
import { alertText } from "../AlertList/AlertList";
import { ClipButton } from "../AlertList/ClipDialog";
import { DISPOSITION, type DispositionAction, dispose } from "../AlertList/Dispose";
import { formatStamp } from "../ConnectionStatus/ConnectionStatus";

/** 只对此时长内发生的告警响铃弹窗：登录后补推的近 24 小时记录不再打扰 */
export const ALARM_WINDOW_MS = 2 * 60_000;
const MUTE_KEY = "hyd.alarm-muted";

type Physical = Behavior | RuleEvent;

/**
 * 需要值班员处理的告警：确认级的物理告警（行为事件；区域入侵进入与越线），发生在 ALARM_WINDOW_MS 内、
 * 还没有任何处置、本机也没有关掉弹窗的；新的在前
 */
export function pendingAlarms(alerts: Alert[], disposed: Record<string, unknown>, dismissed: ReadonlySet<string>, now: number): Physical[] {
  return alerts.filter((a): a is Physical => {
    if (!("camera_id" in a) || a.level !== "confirmed") return false;
    if ("rule_type" in a && a.phase !== "start" && a.phase !== "pulse") return false;
    return !(a.event_id in disposed) && !dismissed.has(a.event_id) && now - Date.parse(a.ts) <= ALARM_WINDOW_MS;
  });
}

/** 两声提示音（WebAudio 合成，不加载音频文件）；浏览器未允许出声时静默失败 */
export function chime(): void {
  try {
    const ctx = new AudioContext();
    [0, 0.32].forEach((at, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i === 0 ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.3);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // 不支持 WebAudio 时只弹窗
  }
}

/** 本机最多保留的告警画面：超出的最早一张释放 */
const MAX_SHOTS = 20;

/** 告警发生时抓的一帧与出事的人在画面中的检测框（归一化），供弹窗显示"当时的画面" */
interface Shot {
  url: string | null;
  bbox: number[] | null;
  failed: boolean;
}

/**
 * 告警弹窗（告警闭环）：确认级物理告警到达时响铃，右下角弹出卡片，附发生时抓的画面并框出出事的人；
 * operator 及以上可直接标已确认、误报、已处理，任何人都可只关掉本机弹窗。静音记在本机
 */
export function Alarm() {
  const alerts = useLive((s) => s.alerts);
  const dispositions = useLive((s) => s.dispositions);
  const role = useSession((s) => s.role);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === "1");
  const [now, setNow] = useState(() => Date.now());
  const [shots, setShots] = useState<Record<string, Shot>>({});
  const [pending, setPending] = useState(false);
  const seen = useRef(new Set<string>());

  // 每 10 s 重算一次：超出时间窗的弹窗自行收起
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const queue = useMemo(() => pendingAlarms(alerts, dispositions, dismissed, now), [alerts, dispositions, dismissed, now]);
  const head = queue[0];

  // 新告警：响铃、记下此刻出事的人的检测框并抓一帧
  useEffect(() => {
    const fresh = queue.filter((a) => !seen.current.has(a.event_id));
    if (fresh.length === 0) return;
    for (const a of fresh) seen.current.add(a.event_id);
    if (!muted) chime();
    for (const a of fresh) {
      const bbox = useLive.getState().targets[`${a.camera_id}/${a.track_id}`]?.bbox ?? null;
      const keep = (shot: Shot) =>
        setShots((s) => {
          const entries = [...Object.entries(s), [a.event_id, shot] as const];
          for (const [, old] of entries.slice(0, -MAX_SHOTS)) if (old.url) URL.revokeObjectURL(old.url);
          return Object.fromEntries(entries.slice(-MAX_SHOTS));
        });
      api.getCameraSnapshot(a.camera_id).then(
        (blob) => keep({ url: URL.createObjectURL(blob), bbox, failed: false }),
        () => keep({ url: null, bbox, failed: true }),
      );
    }
  }, [queue, muted]);

  if (!head) return null;
  const { title } = alertText(head);
  const shot = shots[head.event_id];
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = shot?.bbox ?? [];
  const toggleMute = () => {
    localStorage.setItem(MUTE_KEY, muted ? "0" : "1");
    setMuted(!muted);
  };
  const act = async (action: DispositionAction) => {
    setPending(true);
    await dispose([head], action);
    setPending(false);
  };

  return (
    <section role="alertdialog" aria-label="告警提醒" className="fixed right-4 bottom-4 z-40 w-[360px] overflow-hidden rounded-lg border bg-card shadow-2xl animate-in fade-in slide-in-from-bottom-4">
      <header className="flex items-center gap-2 bg-[#D03B3B] px-3 py-2 text-white">
        <BellRing aria-hidden className="size-4 animate-pulse" />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {queue.length > 1 && <span className="text-xs tabular-nums opacity-90">还有 {queue.length - 1} 条</span>}
        <button type="button" aria-label={muted ? "打开提示音" : "静音"} title={muted ? "打开提示音" : "静音"} onClick={toggleMute} className="rounded p-0.5 hover:bg-white/20">
          {muted ? <VolumeX aria-hidden className="size-4" /> : <Volume2 aria-hidden className="size-4" />}
        </button>
        <button
          type="button"
          aria-label="关闭本机弹窗"
          title="关闭本机弹窗（不处置）"
          onClick={() => setDismissed((d) => new Set(d).add(head.event_id))}
          className="rounded p-0.5 hover:bg-white/20"
        >
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <div className="relative aspect-video bg-black">
        {shot?.url ? (
          <>
            <img src={shot.url} alt="告警时的画面" className="absolute inset-0 size-full object-fill" />
            {shot.bbox && (
              <span
                aria-hidden
                className="absolute rounded-sm border-2 border-[#D03B3B] shadow-[0_0_12px_#D03B3B]"
                style={{ left: `${x1 * 100}%`, top: `${y1 * 100}%`, width: `${(x2 - x1) * 100}%`, height: `${(y2 - y1) * 100}%` }}
              />
            )}
          </>
        ) : (
          <p className="absolute inset-0 grid place-items-center text-xs text-white/70">{shot?.failed ? "取不到当时的画面" : "正在抓取当时的画面…"}</p>
        )}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <p className="text-meta text-muted-foreground tabular-nums">
          {head.camera_id} · 人员 #{head.track_id} · {formatStamp(Date.parse(head.ts))}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {canContain(role) &&
            (["acknowledged", "false_positive", "resolved"] as const).map((action) => (
              <Button key={action} size="sm" variant={action === "acknowledged" ? "default" : "outline"} disabled={pending} onClick={() => void act(action)}>
                {DISPOSITION[action]}
              </Button>
            ))}
          <ClipButton eventId={head.event_id} title={title} camera={head.camera_id} ts={head.ts} size="sm" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              select(head.camera_id);
              go("wall");
            }}
          >
            查看画面
          </Button>
        </div>
      </div>
    </section>
  );
}
