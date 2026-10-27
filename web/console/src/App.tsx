import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./lib/api";
import { LoginPage } from "./panels/LoginPage/LoginPage";

type Gate = "checking" | "login" | "ready" | "unreachable";

export function App() {
  const [gate, setGate] = useState<Gate>("checking");

  // 没有"当前会话"接口：以 viewer 即可访问的 GET /api/site 探测是否已登录
  const probe = useCallback(
    () =>
      api.getSite().then(
        () => setGate("ready"),
        (e: unknown) => setGate(e instanceof ApiError && e.status === 401 ? "login" : "unreachable"),
      ),
    [],
  );
  // 请求 ID（crypto.randomUUID）与 Secure 会话 Cookie 都要求安全上下文：http 访问时直接说明，不发请求
  const secure = window.isSecureContext;
  useEffect(() => {
    if (secure) void probe();
  }, [secure, probe]);

  if (!secure) return <Notice text="请通过 HTTPS 地址访问控制台" />;
  if (gate === "login") return <LoginPage onLogin={probe} />;
  if (gate === "unreachable") return <Notice text="无法连接服务器" onRetry={probe} />;
  // TODO(#33): ready 时接入主界面布局
  return <main className="h-full bg-page" />;
}

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 bg-page">
      <p className="text-fg-2">{text}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="h-10 rounded-full border border-line px-5 transition-colors hover:bg-raised"
        >
          重试
        </button>
      )}
    </main>
  );
}
