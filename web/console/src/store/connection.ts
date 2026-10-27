import { create } from "zustand";
import { prune, receive, useLive } from "./live";

/** api-server 每 5 s 推送一次心跳：超过 2 个周期无帧即为延迟 */
export const STALE_MS = 10_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 10_000;
const POLICY_VIOLATION = 1008; // 会话失效或已登出
const PRUNE_MS = 500;

export type Freshness = "connecting" | "live" | "delayed" | "offline";

interface ConnectionState {
  open: boolean;
  /** 首次连接尚无结果：不按断线呈现 */
  connecting: boolean;
  /** 最后收到数据的时刻（毫秒时间戳）；连上时记为当前时刻 */
  lastFrameAt: number | null;
}

export const useConnection = create<ConnectionState>()(() => ({
  open: false,
  connecting: true,
  lastFrameAt: null,
}));

export function freshness({ open, connecting, lastFrameAt }: ConnectionState, now: number): Freshness {
  if (!open) return connecting ? "connecting" : "offline";
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
  // 只在连接中移除超时化身：断线期间保留最后位置，按"数据非实时"呈现（V-U3、V-U4）
  const pruner = setInterval(() => {
    if (useConnection.getState().open) prune(Date.now());
  }, PRUNE_MS);

  function open() {
    let opened = false;
    socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.onopen = () => {
      opened = true;
      retryMs = RETRY_MIN_MS;
      useConnection.setState({ open: true, connecting: false, lastFrameAt: Date.now() });
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const now = Date.now();
      useConnection.setState({ lastFrameAt: now });
      receive(JSON.parse(event.data), now);
    };
    socket.onclose = (event) => {
      if (stopped) return; // 已停止的旧连接不得改写新连接的状态
      useConnection.setState({ open: false, connecting: false });
      if (!opened || event.code === POLICY_VIOLATION) onRejected();
      timer = setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
  }

  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(pruner);
    socket.close();
    // 重新登录后不沿用上次会话的最后更新时刻与场景实体
    useConnection.setState(useConnection.getInitialState());
    useLive.setState(useLive.getInitialState());
  };
}
