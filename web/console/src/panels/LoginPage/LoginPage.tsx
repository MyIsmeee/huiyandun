import {
  CircleAlert,
  Eye,
  EyeOff,
  Link2,
  type LucideIcon,
  ShieldCheck,
  Undo2,
  Workflow,
} from "lucide-react";
import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../../lib/api";
import type { Role } from "../../store/session";
import { useTheme } from "../../theme/store";
import { GlobeStage } from "./globe/GlobeStage";
import { restLayout } from "./globe/motion";

// 只列 M0 实际交付的能力（UP-4）；登录前没有真实数据，不放示意数据
const CAPABILITIES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: Workflow,
    title: "双域联动",
    text: "画面中的异常行为与针对摄像头的网络攻击，关联为同一事件",
  },
  {
    icon: Undo2,
    title: "处置可回滚",
    text: "自动处置执行前校验白名单，到期自动撤销，也可一键回滚",
  },
  {
    icon: Link2,
    title: "证据哈希链",
    text: "告警与处置过程逐条存证，导出后可离线校验完整性",
  },
];

function reason(error: unknown): string {
  if (!(error instanceof ApiError) || error.status >= 500)
    return "无法连接服务器，请稍后重试";
  return error.status === 401
    ? "用户名或密码错误"
    : `登录失败：${error.message}`;
}

/**
 * onLogin 返回 true 表示已进入控制台：上层随即把 entering 置为 true，本页播放俯冲过渡，
 * 先后通过 onReveal（挂载控制台）与 onEntered（移除登录层）交还上层。
 * 返回其他值说明登录未生效（如会话 Cookie 未被浏览器保存），不能一直停在提交中
 */
export function LoginPage({
  onLogin,
  entering = false,
  onReveal,
  onEntered,
}: {
  onLogin: (role?: Role) => unknown;
  entering?: boolean;
  onReveal?: () => void;
  onEntered?: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const night = useTheme((s) => s.night);
  const reducedMotion = useReducedMotion();
  const reveal = useCallback(() => onReveal?.(), [onReveal]);
  const entered = useCallback(() => onEntered?.(), [onEntered]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || entering) return;
    setPending(true);
    setError(null);
    try {
      const { role } = await api.login({ username, password });
      if ((await onLogin(role)) === true) return; // 进入过渡，保持提交中
      setError("登录未生效，请刷新页面后重试");
    } catch (e) {
      setError(reason(e));
    }
    setPending(false);
  }

  // 过渡期间表单与文案先退场，地球接管画面
  const leave = cn("transition-[opacity,translate] duration-300 ease-in", entering && "pointer-events-none opacity-0");
  // 宽屏时卡片左缘由地球布局决定（与 GlobeStage 共用 restLayout）：地球与卡片成组居中，卡片压在地球右侧
  const { cardLeft } = useRestLayout();

  return (
    <div ref={rootRef} className="fixed inset-0 z-40 overflow-hidden bg-background">
      <div
        aria-hidden
        className="bg-dots absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
      />
      <GlobeStage
        night={night}
        reducedMotion={reducedMotion}
        diving={entering}
        onReveal={reveal}
        onDone={entered}
        fadeRef={rootRef}
        className={cn("absolute inset-0 transition-opacity duration-500", !entering && "max-lg:opacity-60")}
      />
      <div className="animate-enter absolute inset-0 overflow-x-hidden overflow-y-auto">
        <div className="relative flex min-h-full items-center justify-center p-6 lg:block lg:p-0">
          <section
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 hidden flex-col justify-between p-12 lg:flex",
              leave,
              entering && "-translate-x-4",
            )}
          >
            <Brand />
            <div>
              <p className="text-sm tracking-[0.2em] text-subtle-foreground">边缘智能防护系统</p>
              <h1 className="mt-2 text-2xl leading-tight font-medium">物理安防与网络攻防 · 一屏联动</h1>
              <p className="mt-4 text-meta text-subtle-foreground">离线运行 · 不访问任何外部地址</p>
            </div>
          </section>

          <section
            style={{ "--card-left": `${cardLeft}px` } as CSSProperties}
            className={cn(
              "w-full max-w-[420px] lg:absolute lg:inset-y-0 lg:left-(--card-left) lg:flex lg:w-[420px] lg:flex-col lg:justify-center lg:py-12",
              leave,
              entering && "translate-x-6",
            )}
          >
            {/* 毛玻璃卡片：取自 Voyage 后台登录页（aegis-console auth-stage） */}
            <div
              className={cn(
                "rounded-[28px] p-7 sm:p-10",
                "bg-background/80 ring-1 ring-black/5 backdrop-blur-2xl backdrop-saturate-150",
                "shadow-[0_32px_90px_-24px_rgb(15_23_42/0.35)]",
                "[[data-theme=night]_&]:bg-background/70 [[data-theme=night]_&]:shadow-[0_32px_90px_-24px_rgb(0_0_0/0.65)] [[data-theme=night]_&]:ring-white/10",
              )}
            >
              <Brand className="mb-8 lg:hidden" />
              <div className="flex flex-col gap-1.5 pb-7">
                <h2 className="text-2xl font-semibold tracking-tight sm:text-[28px]">欢迎回来</h2>
                <p className="text-sm text-muted-foreground">使用本地账户登录控制台</p>
              </div>
              <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <div className="grid gap-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    className="h-11"
                    placeholder="请输入用户名"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username"
                    autoFocus
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="password">密码</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      className="h-11 pr-10"
                      placeholder="请输入密码"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  </div>
                </div>
                {error && (
                  <p
                    role="alert"
                    className="flex items-center gap-2 rounded-lg border border-border bg-secondary/80 px-3 py-2.5 text-sm"
                  >
                    <CircleAlert aria-hidden className="size-4 shrink-0" />
                    {error}
                  </p>
                )}
                <Button type="submit" className="mt-1 h-11 w-full" disabled={pending || !username || !password}>
                  {pending && <Spinner aria-hidden />}
                  {pending ? "登录中…" : "登录"}
                </Button>
              </form>
              <p className="mt-6 text-center text-[13px] text-muted-foreground">仅限授权人员使用</p>
            </div>
            <ul className="mt-8 hidden space-y-4 px-3 lg:block [@media(max-height:820px)]:hidden">
              {CAPABILITIES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border bg-card">
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{title}</span>
                    <span className="block text-meta text-muted-foreground">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

/** 视口尺寸对应的静止布局，窗口缩放时更新 */
function useRestLayout() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return restLayout(size.width, size.height);
}

/** 用户开关或系统 prefers-reduced-motion（V-A4）；jsdom 等没有 matchMedia 的环境按未开启处理 */
function useReducedMotion(): boolean {
  const user = useTheme((s) => s.reducedMotion);
  const [system, setSystem] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setSystem(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return user || system;
}

function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="grid size-10 place-items-center rounded-lg bg-primary text-primary-foreground">
        <ShieldCheck aria-hidden className="size-5" />
      </span>
      <span>
        <span className="block text-lg leading-tight font-medium">慧眼盾</span>
        <span className="block text-xs tracking-[0.3em] text-subtle-foreground">
          HUIYANDUN
        </span>
      </span>
    </div>
  );
}
