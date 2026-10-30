import { CircleAlert, Lock, LockOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { type Execution, useLive } from "../../store/live";
import { canContain, useSession } from "../../store/session";

/** 处置状态的说明（04 §5.2、V-T1）；原因或拦截证据另起一行 */
const STATE: Record<Execution["state"], string> = {
  pending: "待确认处置",
  executing: "处置中",
  verifying: "处置中",
  contained: "已处置",
  failed: "处置失败",
  rolled_back: "已解除",
  notify_only: "已通知 · 待联动",
  skipped: "未处置",
  expired: "未确认 · 已过期",
};

/** 设备当前的处置：最近更新的、涉及该设备的执行 */
export function useDeviceExecution(deviceId: string): Execution | undefined {
  return useLive((s) => Object.values(s.executions).filter((e) => e.device_ids.includes(deviceId)).at(-1));
}

function remaining(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * 处置操作（HYD-UIX-004 §8 ActionBar）：执行状态、原因或拦截证据（D-072）、到期剩余时间；已处置且角色为
 * operator 及以上时渲染"立即解封"，请求期间不可再点（FR-405）；无权限时不渲染（C-FE-07、V-T2）。
 */
export function ActionBar(props: { deviceId: string }) {
  const execution = useDeviceExecution(props.deviceId);
  const role = useSession((s) => s.role);
  // 请求记在发起时的执行与其原因上：受理后保持不可点，直到执行器推送结果（解封后按钮消失；解封失败时原因更新，
  // 可再次解封，D-075）；换了一个执行（如回滚后再次封禁）即不再显示上一次的结果
  const [request, setRequest] = useState<{
    id: string;
    reason: string | null;
    status: "pending" | "failed";
    message?: string;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const contained = execution?.state === "contained";
  useEffect(() => {
    if (!contained) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [contained]);
  if (!execution) return null;
  const current = request?.id === execution.id && request.reason === execution.reason ? request : null;

  // 已处置时另有拦截证据；原因（如解封失败，D-075）在前
  const details = [execution.reason, contained ? execution.verify_result?.reason : null].filter(Boolean);
  async function rollback(id: string, reason: string | null) {
    setRequest({ id, reason, status: "pending" });
    try {
      await api.rollback(id);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "无法连接服务器，请重试";
      setRequest({ id, reason, status: "failed", message });
    }
  }

  return (
    <section aria-label="处置" className="flex flex-col gap-2 rounded-xl border border-line p-3 text-sm">
      <p className="flex items-center gap-2">
        {contained ? <Lock aria-hidden className="size-4 text-contained" /> : <LockOpen aria-hidden className="size-4" />}
        <span className="font-medium">{STATE[execution.state]}</span>
        <span className="text-fg-3 tabular-nums">{execution.target}</span>
        {contained && execution.expires_at && (
          <span className="ml-auto text-fg-3 tabular-nums">剩余 {remaining(execution.expires_at, now)}</span>
        )}
      </p>
      {details.map((text) => (
        <p key={text} className="text-fg-2">
          {text}
        </p>
      ))}
      {contained && canContain(role) && (
        <button
          type="button"
          onClick={() => void rollback(execution.id, execution.reason)}
          disabled={current?.status === "pending"}
          className="h-9 self-start rounded-full border border-line px-4 transition-colors hover:bg-raised disabled:opacity-40"
        >
          {current?.status === "pending" ? "解封中…" : "立即解封"}
        </button>
      )}
      {current?.status === "failed" && (
        <p role="alert" className="flex items-center gap-1 text-fg-2">
          <CircleAlert aria-hidden className="size-4" />
          {current.message}
        </p>
      )}
    </section>
  );
}
