import { ArrowLeft, Check, Circle, CircleAlert, CircleDot, Clock, Globe, House, Minus, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { formatTime } from "../ConnectionStatus/ConnectionStatus";

export type Provider = components["schemas"]["LlmProvider"];
export type ProviderLoad =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; providers: Provider[]; blockPublic: boolean };
export type Confirm = { kind: "enable"; provider: Provider };

const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : "无法连接服务器，请重试");
const host = (url: string) => (URL.canParse(url) ? new URL(url).host : url);
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const button = "h-8 rounded-full border border-line px-3 transition-colors hover:bg-raised disabled:opacity-40";

/**
 * 模型供应商页（04 §7.1），只对 admin 渲染入口（C-FE-07）。每次变更后重新读取列表：
 * 启用、全局禁止公网的结果以服务端为准（如开启禁止公网时服务端同时停用全部公网供应商）。
 */
export function ProviderPage(props: { onClose: () => void }) {
  const [load, setLoad] = useState<ProviderLoad>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const reload = useCallback(
    () =>
      Promise.all([api.listProviders(), api.getLlmSettings()]).then(
        ([list, settings]) => setLoad({ status: "ready", providers: list.items, blockPublic: settings.block_public }),
        (e: unknown) => setLoad({ status: "failed", message: errorMessage(e) }),
      ),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setNotice(errorMessage(e));
    }
    await reload();
    setBusy(false);
  }

  return (
    <ProviderListView
      load={load}
      busy={busy}
      notice={notice}
      confirm={confirm}
      onClose={props.onClose}
      onRetry={() => void reload()}
      onBlockPublic={(on) => void change(() => api.updateLlmSettings({ block_public: on }))}
      // 启用公网供应商须先确认（V-M2）
      onToggle={(p) =>
        !p.enabled && p.network === "public"
          ? setConfirm({ kind: "enable", provider: p })
          : void change(() => api.updateProvider(p.id, { enabled: !p.enabled }))
      }
      onConfirm={(c) => {
        setConfirm(null);
        void change(() => api.updateProvider(c.provider.id, { enabled: true }));
      }}
      onCancel={() => setConfirm(null)}
    />
  );
}

export function ProviderListView(props: {
  load: ProviderLoad;
  busy: boolean;
  notice: string | null;
  confirm: Confirm | null;
  onClose: () => void;
  onRetry: () => void;
  onBlockPublic: (on: boolean) => void;
  onToggle: (provider: Provider) => void;
  onConfirm: (confirm: Confirm) => void;
  onCancel: () => void;
}) {
  const { load, busy, notice, confirm } = props;
  return (
    <section aria-label="模型供应商" className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6 text-sm">
      <header className="flex items-center gap-3">
        <button type="button" onClick={props.onClose} className={`${button} flex items-center gap-1`}>
          <ArrowLeft aria-hidden className="size-4" />
          返回
        </button>
        <h1 className="text-base font-semibold">模型供应商</h1>
        {load.status === "ready" && (
          <Switch
            label="禁止公网供应商"
            text="禁止公网供应商"
            on={load.blockPublic}
            disabled={busy}
            onClick={() => props.onBlockPublic(!load.blockPublic)}
            className="ml-auto"
          />
        )}
      </header>
      <p className="text-fg-2">按顺序调用，前一个失败自动使用下一个。</p>
      {notice && <Notice>{notice}</Notice>}
      {load.status === "loading" && <p className="text-fg-3">读取中…</p>}
      {load.status === "failed" && (
        <>
          <Notice>{load.message}</Notice>
          <button type="button" onClick={props.onRetry} className={`${button} self-start`}>
            重试
          </button>
        </>
      )}
      {load.status === "ready" && <Cards {...props} providers={load.providers} blockPublic={load.blockPublic} />}
      {confirm && (
        <div className="fixed inset-0 grid place-items-center bg-page/60">
          <div
            role="dialog"
            aria-modal
            aria-label="启用公网供应商"
            className="flex w-96 flex-col gap-4 rounded-2xl border border-line bg-panel p-4"
          >
            <p>
              {`启用公网供应商“${confirm.provider.name}”？日志与告警内容将脱敏后发送至 ${host(confirm.provider.base_url)}；视频、图片、流量包不会发送。`}
            </p>
            <p className="flex justify-end gap-2">
              <button type="button" onClick={props.onCancel} className={button}>
                取消
              </button>
              <button type="button" onClick={() => props.onConfirm(confirm)} className={button}>
                确认启用
              </button>
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

function Cards(props: Parameters<typeof ProviderListView>[0] & { providers: Provider[]; blockPublic: boolean }) {
  const { providers, blockPublic, busy } = props;
  return (
    <ol aria-label="供应商" className="flex flex-col gap-2">
      {providers.length === 0 && <li className="text-fg-3">尚未添加供应商，报告使用规则模板生成</li>}
      {providers.map((p, i) => {
        const blocked = blockPublic && p.network === "public";
        return (
          <li
            key={p.id}
            className={`flex flex-col gap-1 rounded-xl border border-line bg-panel p-3 ${blocked ? "opacity-50" : ""}`}
          >
            <div className="flex items-center gap-2">
              <span className="w-4 tabular-nums text-fg-3">{i + 1}</span>
              <span className="min-w-0 truncate font-medium" title={p.name}>
                {p.name}
              </span>
              <span className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 text-xs text-fg-2">
                {p.network === "public" ? <Globe aria-hidden className="size-3" /> : <House aria-hidden className="size-3" />}
                {p.network === "public" ? "公网" : "内网"}
                {p.network_overridden && "（手动）"}
              </span>
              <Health provider={p} />
              <Switch
                label={`启用 ${p.name}`}
                text={p.enabled ? "启用" : "停用"}
                on={p.enabled}
                disabled={busy || blocked}
                onClick={() => props.onToggle(p)}
              />
            </div>
            <p className="truncate pl-10 text-fg-2" title={p.base_url}>
              {p.base_url} · {p.model}
              {p.api_key_last4 && ` · Key ••••${p.api_key_last4}`}
            </p>
            <div className="flex flex-wrap items-center gap-2 pl-10 text-fg-2">
              <span className="tabular-nums">
                今日 {p.usage_today.calls} 次 · {tokens(p.usage_today.tokens)} tokens
                {p.structured_output && ` · 结构化输出 ${p.structured_output === "none" ? "无" : p.structured_output}`}
              </span>
              {blocked && <span>已全局禁止公网供应商</span>}
            </div>
          </li>
        );
      })}
      <li className="flex items-center gap-2 rounded-xl border border-dashed border-line p-3 text-fg-2">
        <span className="font-medium text-fg">兜底</span>
        规则模板报告
        <span className="ml-auto text-fg-3">始终可用，不可删除、不可移动</span>
      </li>
    </ol>
  );
}

/** 健康状态以图标 + 文字表达，不用状态色（V-M7）；失败时悬停显示原因与时间。停用时由旁边的开关注明，这里不重复 */
function Health(props: { provider: Provider }) {
  const { enabled, last_test: test } = props.provider;
  const style = "ml-auto flex shrink-0 items-center gap-1 tabular-nums";
  if (!enabled) return <span className="ml-auto" />;
  if (!test)
    return (
      <span className={`${style} text-fg-3`}>
        <Minus aria-hidden className="size-4" />
        未测试
      </span>
    );
  if (test.health === "failed") {
    const failed = test.checks.find((c) => !c.ok);
    const why = [failed?.reason, failed?.hint].filter(Boolean).join("；");
    return (
      <span className={style} title={`${why}（${formatTime(Date.parse(test.tested_at))}）`}>
        <X aria-hidden className="size-4" />
        失败
      </span>
    );
  }
  const latency = test.checks.find((c) => c.check === "connectivity")?.latency_ms;
  return (
    <span className={style}>
      {test.health === "ok" ? <Check aria-hidden className="size-4" /> : <Clock aria-hidden className="size-4" />}
      {test.health === "ok" ? "可用" : "偏慢"}
      {latency != null && ` ${latency} ms`}
    </span>
  );
}

/** label 给读屏，text 为可见文字（卡片开关显示当前状态） */
function Switch(props: {
  label: string;
  text: string;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  className?: string;
}) {
  const { on, text } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`${button} flex shrink-0 items-center gap-1.5 ${props.className ?? ""}`}
    >
      {on ? <CircleDot aria-hidden className="size-4" /> : <Circle aria-hidden className="size-4" />}
      {text}
    </button>
  );
}

function Notice(props: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1 text-fg-2">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{props.children}</span>
    </p>
  );
}
