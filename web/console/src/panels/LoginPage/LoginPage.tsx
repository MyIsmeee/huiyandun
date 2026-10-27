import {
  CircleAlert,
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  LockKeyhole,
  type LucideIcon,
  ShieldCheck,
  Undo2,
  UserRound,
  Workflow,
} from "lucide-react";
import { type FormEvent, type InputHTMLAttributes, type ReactNode, useState } from "react";
import { ApiError, api } from "../../lib/api";

// 只列 M0 实际交付的能力（UP-4）；登录前没有真实数据，不放示意数据
const CAPABILITIES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Workflow, title: "双域联动", text: "画面中的异常行为与针对摄像头的网络攻击，关联为同一事件" },
  { icon: Undo2, title: "处置可回滚", text: "自动处置执行前校验白名单，到期自动撤销，也可一键回滚" },
  { icon: Link2, title: "证据哈希链", text: "告警与处置过程逐条存证，导出后可离线校验完整性" },
];

function reason(error: unknown): string {
  if (!(error instanceof ApiError) || error.status >= 500) return "无法连接服务器，请稍后重试";
  return error.status === 401 ? "用户名或密码错误" : `登录失败：${error.message}`;
}

/** onLogin 完成后若仍渲染登录页，说明登录未生效（如会话 Cookie 未被浏览器保存），不能一直停在提交中 */
export function LoginPage({ onLogin }: { onLogin: () => Promise<void> | void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api.login({ username, password });
      await onLogin();
      setError("登录未生效，请刷新页面后重试");
    } catch (e) {
      setError(reason(e));
    }
    setPending(false);
  }

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden bg-page p-6">
      <div
        aria-hidden
        className="bg-dots absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]"
      />
      <main className="animate-enter relative grid w-full max-w-[1080px] gap-6 lg:grid-cols-[1.1fr_1fr]">
        <section className="hidden flex-col gap-12 rounded-3xl border border-line bg-panel p-10 lg:flex">
          <Brand />
          <div>
            <p className="text-sm tracking-[0.2em] text-fg-3">边缘智能防护系统</p>
            <h1 className="mt-4 text-4xl leading-tight font-black">
              物理安防与网络攻防
              <br />
              一屏联动
            </h1>
            <ul className="mt-10 space-y-6">
              {CAPABILITIES.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-raised">
                    <Icon aria-hidden className="size-[18px]" />
                  </span>
                  <span>
                    <span className="block font-semibold">{title}</span>
                    <span className="mt-1 block text-sm text-fg-2">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-auto text-sm text-fg-3">离线运行 · 不访问任何外部地址</p>
        </section>

        <section className="mx-auto flex w-full max-w-md flex-col justify-center py-6 lg:max-w-none lg:px-12">
          <Brand className="mb-10 lg:hidden" />
          <h2 className="text-3xl font-black">欢迎回来</h2>
          <p className="mt-2 text-fg-2">使用本地账户登录控制台</p>
          <form onSubmit={submit} className="mt-8 space-y-4">
            <Field
              id="username"
              label="用户名"
              icon={UserRound}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
            <Field
              id="password"
              label="密码"
              icon={LockKeyhole}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              trailing={
                <button
                  type="button"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  onClick={() => setShowPassword(!showPassword)}
                  className="mr-2 grid size-10 place-items-center rounded-full text-fg-3 transition-colors hover:text-fg"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              }
            />
            {error && (
              <p
                role="alert"
                className="flex items-center gap-2 rounded-2xl border border-line bg-raised px-4 py-3 text-sm"
              >
                <CircleAlert aria-hidden className="size-4 shrink-0" />
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending || !username || !password}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-fg font-semibold text-page transition hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
            >
              {pending && <LoaderCircle aria-hidden className="size-4 animate-spin" />}
              {pending ? "登录中…" : "登录"}
            </button>
          </form>
          <p className="mt-8 text-center text-sm text-fg-3">仅限授权人员使用</p>
        </section>
      </main>
    </div>
  );
}

function Brand({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <span className="grid size-10 place-items-center rounded-xl bg-fg text-page">
        <ShieldCheck aria-hidden className="size-5" />
      </span>
      <span>
        <span className="block text-lg leading-tight font-black">慧眼盾</span>
        <span className="block text-xs tracking-[0.3em] text-fg-3">HUIYANDUN</span>
      </span>
    </div>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  icon: LucideIcon;
  trailing?: ReactNode;
}

/** 标签在框内：空且未聚焦时居中，聚焦或有值时上移（借鉴 uiverse 浮动标签） */
function Field({ id, label, icon: Icon, trailing, ...input }: FieldProps) {
  return (
    <div className="group flex h-14 items-center rounded-2xl border border-line bg-raised transition-colors focus-within:border-fg-3">
      <Icon aria-hidden className="ml-4 size-4 shrink-0 text-fg-3 transition-colors group-focus-within:text-fg" />
      <div className="relative h-full flex-1">
        <input
          id={id}
          placeholder=" "
          className="peer h-full w-full bg-transparent px-3 pt-5 pb-1 outline-none [&:-webkit-autofill]:shadow-[inset_0_0_0_100px_var(--color-raised)] [&:-webkit-autofill]:[-webkit-text-fill-color:var(--color-fg)]"
          {...input}
        />
        <label
          htmlFor={id}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3 transition-all peer-focus:top-4 peer-focus:text-sm peer-[:not(:placeholder-shown)]:top-4 peer-[:not(:placeholder-shown)]:text-sm"
        >
          {label}
        </label>
      </div>
      {trailing}
    </div>
  );
}
