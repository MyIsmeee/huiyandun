import { create } from "zustand";

/** api-server 每 5 s 推送一次心跳：超过 2 个周期无帧即为延迟 */
export const STALE_MS = 10_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 10_000;
const POLICY_VIOLATION = 1008; // 会话失效或已登出

export type Freshness = "live" | "delayed" | "offline";

interface ConnectionState {
  open: boolean;
  /** 最后收到数据的时刻（毫秒时间戳）；连上时记为当前时刻 */
  lastFrameAt: number | null;
}

export const useConnection = create<ConnectionState>()(() => ({ open: false, lastFrameAt: null }));

export function freshness({ open, lastFrameAt }: ConnectionState, now: number): Freshness {
  if (!open) return "offline";
  return lastFrameAt !== null && now - lastFrameAt <= STALE_MS ? "live" : "delayed";
}

/**
 * 连接 WS /ws，断开后按 1 s 起倍增、上限 10 s 重连，返回停止函数。
 * 会话失效时服务端以 1008 断开，握手阶段被拒在浏览器中只表现为连接未建立即关闭：
 * 两种情况都调用 onRejected，由上层核对会话（失效则回到登录页），重连照常进行。
 */
export function connect(onRejected: () => void): () => void {
  let socket: WebSocket;
  let retryMs = RETRY_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function open() {
    let opened = false;
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.onopen = () => {
      opened = true;
      retryMs = RETRY_MIN_MS;
      useConnection.setState({ open: true, lastFrameAt: Date.now() });
    };
    socket.onmessage = () => useConnection.setState({ lastFrameAt: Date.now() });
    socket.onclose = (event) => {
      useConnection.setState({ open: false });
      if (stopped) return;
      if (!opened || event.code === POLICY_VIOLATION) onRejected();
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
  }

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket.close();
    useConnection.setState(useConnection.getInitialState()); // 重新登录后不沿用上次会话的最后更新时刻
  };
}
