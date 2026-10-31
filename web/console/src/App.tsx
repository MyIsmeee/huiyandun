import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Site } from "./lib/api";
import { useSession } from "./store/session";
import { LoginPage } from "./panels/LoginPage/LoginPage";
import { Shell } from "./panels/Shell/Shell";

type Gate = { kind: "checking" | "login" | "unreachable" } | { kind: "ready"; site: Site };

export function App() {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });

  // 以 viewer 即可访问的 GET /api/site 探测是否已登录；未登录或不可达时清空角色，换账户登录后不沿用上一个角色
  const probe = useCallback(
    () =>
      api.getSite().then(
        (site) => {
          setGate({ kind: "ready", site });
          // 角色只决定渲染哪些操作；查询失败时按未知处理，不渲染需要权限的操作（C-FE-07）
          api.session().then(
            (s) => useSession.setState({ role: s.role }),
            () => useSession.setState({ role: null }),
          );
        },
        (e: unknown) => {
          useSession.setState({ role: null });
          setGate({ kind: e instanceof ApiError && e.status === 401 ? "login" : "unreachable" });
        },
      ),
    [],
  );
  // 无论登出请求成败都重新探测：以服务端的实际会话状态决定显示哪一页
  const logout = useCallback(() => api.logout().then(probe, probe), [probe]);
  // WS 被拒时核对会话：失效回到登录页；服务不可达时留在主界面，由连接状态提示断线（V-U3）
  const recheck = useCallback(() => {
    api.getSite().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) setGate({ kind: "login" });
    });
  }, []);
  // 请求 ID（crypto.randomUUID）与 Secure 会话 Cookie 都要求安全上下文：http 访问时直接说明，不发请求
  const secure = window.isSecureContext;
  useEffect(() => {
    if (secure) void probe();
  }, [secure, probe]);

  if (!secure) return <Notice text="请通过 HTTPS 地址访问控制台" />;
  if (gate.kind === "login") return <LoginPage onLogin={probe} />;
  if (gate.kind === "unreachable") return <Notice text="无法连接服务器" onRetry={probe} />;
  if (gate.kind === "ready") return <Shell site={gate.site} onLogout={logout} onRejected={recheck} />;
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
