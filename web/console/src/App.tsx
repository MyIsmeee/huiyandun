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
  useEffect(() => {
    void probe();
  }, [probe]);

  if (gate === "login") return <LoginPage onLogin={probe} />;
  if (gate === "unreachable") {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-page">
        <p className="text-fg-2">无法连接服务器</p>
        <button
          onClick={probe}
          className="h-10 rounded-full border border-line px-5 transition-colors hover:bg-raised"
        >
          重试
        </button>
      </main>
    );
  }
  // TODO(#33): ready 时接入主界面布局
  return <main className="h-full bg-page" />;
}
