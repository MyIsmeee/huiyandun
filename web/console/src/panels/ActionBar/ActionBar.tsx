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

/**
 * 执行按优先级显示：已处置 > 处置中 > 只通知，其余同级（与 api-server 设备状态的优先级相同）。设备状态在攻击结束后
 * 不再显示只通知，处置栏仍显示它，与已解除一样属于上一次执行的结果
 */
const PRIORITY: Partial<Record<Execution["state"], number>> = {
  contained: 0,
  executing: 1,
  verifying: 1,
  notify_only: 2,
};
const priority = (e: Execution) => PRIORITY[e.state] ?? 3;

/** 受理后等待执行器推送结果的时长：执行器停机时回滚请求可能丢失，到时恢复可点 */
export const RESULT_TIMEOUT_MS = 30_000;

/**
 * 设备当前的处置：涉及该设备的执行中优先级最高的，同级取最近更新的。仍被封禁的攻击源不因后来的执行
 * （待确认、互斥跳过）显示为未处置、丢失解封按钮
 */
export function useDeviceExecution(deviceId: string): Execution | undefined {
  return useLive((s) =>
    Object.values(s.executions)
      .filter((e) => e.device_ids.includes(deviceId))
      .reduce<Execution | undefined>((best, e) => (best && priority(best) < priority(e) ? best : e), undefined),
  );
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
  // 请求记在发起时收到的那条执行推送上：受理后保持不可点，直到执行器推送新结果（每次推送都是新对象；解封后按钮
  // 消失，解封失败时可再次解封，D-075，原因与上次相同也能识别）；换了一个执行即不再显示上一次的结果
  const [request, setRequest] = useState<{
    execution: Execution;
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
  const current = request?.execution === execution ? request : null;

  // 已处置时另有拦截证据；原因（如解封失败，D-075）在前
  const details = [execution.reason, contained ? execution.verify_result?.reason : null].filter(Boolean);
  async function rollback(target: Execution) {
    setRequest({ execution: target, status: "pending" });
    try {
      await api.rollback(target.id);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "无法连接服务器，请重试";
      setRequest({ execution: target, status: "failed", message });
      return;
    }
    setTimeout(() => {
      setRequest((r) =>
        r?.execution === target && r.status === "pending"
          ? { ...r, status: "failed", message: "未收到执行结果，请重试" }
          : r,
      );
    }, RESULT_TIMEOUT_MS);
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
          onClick={() => void rollback(execution)}
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
