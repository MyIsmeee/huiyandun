import {
  CircleAlert,
  Eye,
  EyeOff,
  Link2,
  type LucideIcon,
  Undo2,
  Workflow,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../../lib/api";
import type { Role } from "../../store/session";
import { useTheme } from "../../theme/store";
import { GlobeStage } from "./globe/GlobeStage";

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

  // 结构照搬 Voyage 后台登录页（aegis-console auth-stage）：全屏背景 + 页眉 / 靠右的玻璃卡片 / 页脚。
  // 背景是太空与地球，相当于 Voyage 的壁纸，不随主题变化；登录层内固定用夜间令牌，卡片与文字按深色底取色
  return (
    <div ref={rootRef} data-theme="night" className="fixed inset-0 z-40 overflow-hidden bg-background text-foreground">
      <Starfield />
      <GlobeStage
        night={night}
        reducedMotion={reducedMotion}
        diving={entering}
        onReveal={reveal}
        onDone={entered}
        fadeRef={rootRef}
        className={cn("absolute inset-0 transition-opacity duration-500", !entering && "max-lg:opacity-50")}
      />
      <div className="animate-enter absolute inset-0 overflow-x-hidden overflow-y-auto">
        <div className="relative flex min-h-full flex-col px-5 pt-5 pb-5 sm:px-8 lg:px-12">
          <header className={cn("hidden h-12 items-center lg:flex", leave, entering && "-translate-y-2")}>
            <Brand />
          </header>

          <main
            className={cn(
              "flex flex-1 items-center justify-center py-10 lg:justify-end lg:pr-[4vw] xl:pr-[8vw]",
              leave,
              entering && "translate-x-6",
            )}
          >
            {/* 毛玻璃卡片：照搬 Voyage 登录卡片的深色样式（zinc-950/70、backdrop-blur-2xl、白色细描边） */}
            <section className="w-full max-w-[420px] rounded-[28px] bg-[rgb(9_9_11/0.7)] p-7 shadow-[0_32px_90px_-24px_rgb(0_0_0/0.65)] ring-1 ring-white/10 backdrop-blur-2xl backdrop-saturate-150 sm:p-10">
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
                    className={FIELD}
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
                      className={cn(FIELD, "pr-10")}
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
                      className="absolute top-1/2 right-1.5 size-8 -translate-y-1/2 text-muted-foreground hover:bg-white/10 hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  </div>
                </div>
                {error && (
                  <p
                    role="alert"
                    className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-sm"
                  >
                    <CircleAlert aria-hidden className="size-4 shrink-0" />
                    {error}
                  </p>
                )}
                {/* 深色玻璃上的主按钮与 Voyage 一致：白底深字 */}
                <Button
                  type="submit"
                  className="mt-1 h-11 w-full bg-white text-[#09090b] hover:bg-white/90 disabled:opacity-50"
                  disabled={pending || !username || !password}
                >
                  {pending && <Spinner aria-hidden />}
                  {pending ? "登录中…" : "登录"}
                </Button>
              </form>
              <p className="mt-6 text-center text-[13px] text-muted-foreground">仅限授权人员使用</p>
            </section>
          </main>

          <footer
            className={cn(
              // 窄屏只保留表单
              "hidden gap-4 [text-shadow:0_1px_3px_rgb(0_0_0/0.5)] lg:flex lg:flex-row lg:items-end lg:justify-between",
              leave,
            )}
          >
            <div>
              <p className="text-[13px] tracking-[0.2em] text-white/70">边缘智能防护系统</p>
              <h1 className="mt-1 text-xl font-medium text-white">物理安防与网络攻防 · 一屏联动</h1>
              <p className="mt-1 text-[11px] text-white/55">离线运行 · 不访问任何外部地址</p>
            </div>
            <ul className="flex max-w-[56rem] gap-6">
              {CAPABILITIES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex max-w-60 gap-2.5">
                  <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-white/80" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-white/90">{title}</span>
                    <span className="block text-[11px] text-white/55">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** 输入框：深色玻璃上的半透明底（对应 Voyage 深色主题下 shadcn 输入框的 bg-input/30） */
const FIELD =
  "h-11 border-white/10 bg-white/[0.04] placeholder:text-white/35 focus-visible:border-white/30 focus-visible:ring-white/15";

/** 星空：固定种子生成，每次一样；静止不闪烁 */
const STARS = (() => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  return Array.from({ length: 220 }, () => ({
    x: rand() * 1600,
    y: rand() * 1000,
    r: 0.35 + rand() * rand() * 1.3,
    o: 0.15 + rand() * 0.6,
  }));
})();

function Starfield() {
  return (
    <svg aria-hidden className="absolute inset-0 size-full" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
      {STARS.map((star, i) => (
        <circle key={i} cx={star.x} cy={star.y} r={star.r} fill="white" fillOpacity={star.o} />
      ))}
    </svg>
  );
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
      <BrandMark className="h-10" />
      <span>
        <span className="block text-lg leading-tight font-medium">慧眼盾</span>
        <span className="block text-xs tracking-[0.3em] text-white/60">
          HUIYANDUN
        </span>
      </span>
    </div>
  );
}
