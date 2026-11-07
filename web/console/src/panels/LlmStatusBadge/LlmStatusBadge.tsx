import { ArrowRightLeft, Bot, CircleHelp, FileText, LoaderCircle, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { api } from "../../lib/api";

export type LlmStatus = components["schemas"]["LlmStatus"];
export type LlmStatusLoad = { status: "loading" | "error" } | { status: "ready"; data: LlmStatus };

const POLL_MS = 5_000;

/** 顶栏模型状态（V-M8、FR-606）：每 5 s 拉取一次，上一次返回后再计时，请求不会叠加 */
export function LlmStatusBadge() {
  const [load, setLoad] = useState<LlmStatusLoad>({ status: "loading" });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    async function poll() {
      const next: LlmStatusLoad = await api.getLlmStatus().then(
        (data) => ({ status: "ready", data }),
        () => ({ status: "error" }),
      );
      if (!active) return;
      setLoad(next);
      timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  return <LlmStatusBadgeView load={load} />;
}

// 不使用 §3.2 状态色（V-S2、V-M7）：已切换与模板模式用虚线框，读不到状态用"不确定"样式
export function LlmStatusBadgeView(props: { load: LlmStatusLoad }) {
  const { load } = props;
  let view: [LucideIcon, string, string, string?];
  if (load.status !== "ready")
    view =
      load.status === "loading"
        ? [LoaderCircle, "模型状态…", "border-line text-fg-3"]
        : [CircleHelp, "模型状态未知", "border-dashed border-uncertain text-uncertain"];
  else if (load.data.state === "normal") view = [Bot, `模型：${load.data.provider_name}`, "border-line text-fg-2"];
  else if (load.data.state === "failover")
    view = [ArrowRightLeft, `已切换至 ${load.data.provider_name}`, "border-dashed border-fg-3 text-fg"];
  else view = [FileText, "模板模式", "border-dashed border-fg-3 text-fg", load.data.reason ?? undefined];
  const [Icon, text, style, title] = view;
  return (
    <p
      role="status"
      aria-label="模型状态"
      title={title ?? text}
      className={`flex h-8 max-w-64 items-center gap-2 rounded-md border px-2.5 text-meta whitespace-nowrap ${style}`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </p>
  );
}
