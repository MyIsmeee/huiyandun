import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiError, api, type Site } from "./lib/api";
import { type Role, useSession } from "./store/session";
import { LoginPage } from "./panels/LoginPage/LoginPage";
import { Shell } from "./panels/Shell/Shell";

type Gate = { kind: "checking" | "login" | "unreachable" } | { kind: "ready"; site: Site };

/** 角色读取失败后的重试间隔：2 s 起倍增，上限 30 s */
const ROLE_RETRY_MIN_MS = 2_000;
const ROLE_RETRY_MAX_MS = 30_000;

export function App() {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  // 角色重试的定时器：重新探测或卸载时取消，换账户后不由上一轮的重试写入角色
  const roleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const roleRound = useRef(0);
  useEffect(() => () => clearTimeout(roleTimer.current), []);

  // 角色只决定渲染哪些操作；读取失败时保持未知（不渲染需要权限的操作，C-FE-07），按退避重试直到成功或会话失效
  const loadRole = useCallback(() => {
    clearTimeout(roleTimer.current);
    const round = ++roleRound.current;
    const attempt = (delay: number) =>
      api.session().then(
        (s) => {
          if (round === roleRound.current) useSession.setState({ role: s.role, roleFailed: false });
        },
        (e: unknown) => {
          if (round !== roleRound.current) return;
          // 会话已失效：由下一次请求或 WS 被拒回到登录页，不再重试
          if (e instanceof ApiError && e.status === 401) {
            useSession.setState({ role: null, roleFailed: false });
            return;
          }
          // 已从登录响应得知角色时照常显示，只在后台重试
          useSession.setState((st) => ({ roleFailed: st.role === null }));
          roleTimer.current = setTimeout(() => void attempt(Math.min(delay * 2, ROLE_RETRY_MAX_MS)), delay);
        },
      );
    void attempt(ROLE_RETRY_MIN_MS);
  }, []);

  // 以 viewer 即可访问的 GET /api/site 探测是否已登录；未登录或不可达时清空角色，换账户登录后不沿用上一个角色
  const probe = useCallback(
    () =>
      api.getSite().then(
        (site) => {
          setGate({ kind: "ready", site });
          loadRole();
        },
        (e: unknown) => {
          clearTimeout(roleTimer.current);
          roleRound.current += 1;
          useSession.setState({ role: null, roleFailed: false });
          setGate({ kind: e instanceof ApiError && e.status === 401 ? "login" : "unreachable" });
        },
      ),
    [loadRole],
  );
  // 登录响应已带角色：先用它渲染，不等再查一次会话（查询失败也不至于整个会话按无权限显示）
  const login = useCallback(
    (role?: Role) => {
      if (role) useSession.setState({ role, roleFailed: false });
      return probe();
    },
    [probe],
  );
  // 无论登出请求成败都重新探测：以服务端的实际会话状态决定显示哪一页
  const logout = useCallback(() => api.logout().then(probe, probe), [probe]);
  // WS 被拒时核对会话：失效回到登录页；服务不可达时留在主界面，由连接状态提示断线（V-U3）
  const recheck = useCallback(() => {
    api.getSite().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 401) {
        clearTimeout(roleTimer.current);
        roleRound.current += 1;
        useSession.setState({ role: null, roleFailed: false });
        setGate({ kind: "login" });
      }
    });
  }, []);
  // 请求 ID（crypto.randomUUID）与 Secure 会话 Cookie 都要求安全上下文：http 访问时直接说明，不发请求
  const secure = window.isSecureContext;
  useEffect(() => {
    if (secure) void probe();
  }, [secure, probe]);

  if (!secure) return <Notice text="请通过 HTTPS 地址访问控制台" />;
  if (gate.kind === "login") return <LoginPage onLogin={login} />;
  if (gate.kind === "unreachable") return <Notice text="无法连接服务器" onRetry={probe} />;
  if (gate.kind === "ready") return <Shell site={gate.site} onLogout={logout} onRejected={recheck} />;
  return <main className="h-full bg-background" />;
}

function Notice({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4 bg-background">
      <p className="text-muted-foreground">{text}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          重试
        </Button>
      )}
    </main>
  );
}
