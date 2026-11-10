import { Clock, Hourglass, LoaderCircle, type LucideIcon, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { type Freshness, freshness, useConnection } from "../../store/connection";

export function formatTime(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// 不使用 §3.2 状态色（V-S2）：延迟用"不确定 / 非实时"样式，断线以反色突出（V-U3 顶栏转告警态）
const STYLE: Record<Freshness, string> = {
  connecting: "border-border text-subtle-foreground",
  live: "border-border text-muted-foreground",
  delayed: "border-dashed border-uncertain text-muted-foreground",
  offline: "border-foreground bg-foreground text-background",
};

/** 连接与数据新鲜度（ui.md），常驻顶栏不可隐藏（§4.1 A 区）；以图标与文字区分状态（V-S3） */
export function ConnectionStatus() {
  const connection = useConnection();
  const state = freshness(connection, useNow(1000));
  const labels: Record<Freshness, [LucideIcon, string]> = {
    connecting: [LoaderCircle, "连接中"],
    live: [Wifi, "实时"],
    delayed: [Hourglass, `延迟 · 最后更新 ${formatTime(connection.lastFrameAt)}`],
    offline: [WifiOff, "断线 · 重连中"],
  };
  const [Icon, text] = labels[state];
  return (
    <p
      role="status"
      aria-label="连接状态"
      className={`flex h-8 items-center gap-2 rounded-md border px-2.5 text-meta whitespace-nowrap ${STYLE[state]}`}
    >
      <Icon aria-hidden className="size-3.5" />
      {text}
    </p>
  );
}

/** 断线时主视图底部居中的提示（V-U3）；className 覆盖默认的定位 */
export function StaleNotice({ lastFrameAt, className = "absolute bottom-3 left-1/2 -translate-x-1/2" }: { lastFrameAt: number | null; className?: string }) {
  return (
    <p role="status" aria-label="断线提示" className={`${className} flex items-center gap-2 rounded-md border border-dashed border-uncertain bg-card/90 px-3 py-1.5 text-meta text-muted-foreground backdrop-blur-sm`}>
      <Clock aria-hidden className="size-4" />
      数据非实时 · 最后更新 {formatTime(lastFrameAt)}
    </p>
  );
}
