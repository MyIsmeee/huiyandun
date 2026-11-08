import { ArrowLeft, Check, CircleAlert, Clock, Globe, GripVertical, House, Minus, Plus, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { ProviderEditor } from "../ProviderEditor/ProviderEditor";

export type Provider = components["schemas"]["LlmProvider"];
export type ProviderLoad =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; providers: Provider[]; blockPublic: boolean };
export type Confirm = { kind: "enable" | "delete"; provider: Provider };

const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : "无法连接服务器，请重试");
const host = (url: string) => (URL.canParse(url) ? new URL(url).host : url);
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const button = buttonVariants({ variant: "outline", size: "sm" });

/**
 * 模型供应商页（ui.md §7.1），只对 admin 渲染入口（C-FE-07）。每次变更后重新读取列表：
 * 启用、排序、全局禁止公网的结果以服务端为准（如开启禁止公网时服务端同时停用全部公网供应商）。
 */
export function ProviderPage(props: { onClose: () => void }) {
  const [load, setLoad] = useState<ProviderLoad>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // provider 为 null 即新建
  const [editing, setEditing] = useState<{ provider: Provider | null } | null>(null);

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

  async function run(action: () => Promise<unknown>) {
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setNotice(errorMessage(e));
    }
    await reload();
  }
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    await run(action);
    setBusy(false);
  }
  async function test(provider: Provider) {
    setTesting(provider.id);
    await run(() => api.testProvider(provider));
    setTesting(null);
  }

  return (
    <ProviderListView
      load={load}
      busy={busy}
      testing={testing}
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
      onTest={(p) => void test(p)}
      onDelete={(p) => setConfirm({ kind: "delete", provider: p })}
      onReorder={(ids) => void change(() => api.reorderProviders(ids))}
      onConfirm={(c) => {
        setConfirm(null);
        void change(() =>
          c.kind === "enable" ? api.updateProvider(c.provider.id, { enabled: true }) : api.deleteProvider(c.provider.id),
        );
      }}
      onCancel={() => setConfirm(null)}
      onAdd={() => setEditing({ provider: null })}
      onEdit={(p) => setEditing({ provider: p })}
      editor={
        editing && (
          <ProviderEditor provider={editing.provider} onClose={() => setEditing(null)} onSaved={() => void reload()} />
        )
      }
    />
  );
}

export function ProviderListView(props: {
  load: ProviderLoad;
  busy: boolean;
  testing: string | null;
  notice: string | null;
  confirm: Confirm | null;
  onClose: () => void;
  onRetry: () => void;
  onBlockPublic: (on: boolean) => void;
  onToggle: (provider: Provider) => void;
  onTest: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onReorder: (ids: string[]) => void;
  onConfirm: (confirm: Confirm) => void;
  onCancel: () => void;
  onAdd: () => void;
  onEdit: (provider: Provider) => void;
  editor?: ReactNode;
}) {
  const { load, busy, notice, confirm } = props;
  return (
    <section aria-label="模型供应商" className="mx-auto flex w-full max-w-[1200px] flex-col gap-4 px-6 py-8 text-sm">
      <header className="flex items-center gap-3">
        <button type="button" onClick={props.onClose} className={`${button} flex items-center gap-1`}>
          <ArrowLeft aria-hidden className="size-4" />
          返回
        </button>
        <h1 className="text-xl font-semibold">模型供应商</h1>
        {load.status === "ready" && (
          <Toggle
            label="禁止公网供应商"
            text="禁止公网供应商"
            on={load.blockPublic}
            disabled={busy}
            onChange={() => props.onBlockPublic(!load.blockPublic)}
            className="ml-auto"
          />
        )}
        <button type="button" onClick={props.onAdd} className={buttonVariants({ size: "sm" })}>
          <Plus aria-hidden className="size-4" />
          添加
        </button>
      </header>
      <p className="text-muted-foreground">按顺序调用，前一个失败自动使用下一个。拖动 ⠿ 调整顺序。</p>
      {notice && <Notice>{notice}</Notice>}
      {load.status === "loading" && <p className="text-subtle-foreground">读取中…</p>}
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
        <AlertDialog open onOpenChange={(open) => !open && props.onCancel()}>
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogTitle className="text-base font-medium">
              {confirm.kind === "enable" ? "启用公网供应商" : "删除供应商"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm.kind === "enable"
                ? `启用公网供应商“${confirm.provider.name}”？日志与告警内容将脱敏后发送至 ${host(confirm.provider.base_url)}；视频、图片、流量包不会发送。`
                : `删除供应商“${confirm.provider.name}”？`}
            </AlertDialogDescription>
            <p className="flex justify-end gap-2">
              <button type="button" onClick={props.onCancel} className={button}>
                取消
              </button>
              <button type="button" onClick={() => props.onConfirm(confirm)} className={buttonVariants({ size: "sm" })}>
                {confirm.kind === "enable" ? "确认启用" : "确认删除"}
              </button>
            </p>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {props.editor}
    </section>
  );
}

function Cards(props: Parameters<typeof ProviderListView>[0] & { providers: Provider[]; blockPublic: boolean }) {
  const { providers, blockPublic, busy, testing } = props;
  const [dragged, setDragged] = useState<string | null>(null);

  // 拖到某张卡上即占据它的位置（V-M1）
  function drop(target: string) {
    setDragged(null);
    if (dragged === null || dragged === target) return;
    const ids = providers.map((p) => p.id).filter((id) => id !== dragged);
    ids.splice(
      providers.findIndex((p) => p.id === target),
      0,
      dragged,
    );
    props.onReorder(ids);
  }

  return (
    <ol aria-label="供应商" className="flex flex-col gap-2">
      {providers.length === 0 && <li className="text-subtle-foreground">尚未添加供应商，报告使用规则模板生成</li>}
      {providers.map((p, i) => {
        const blocked = blockPublic && p.network === "public";
        return (
          <li
            key={p.id}
            draggable={!busy}
            onDragStart={() => setDragged(p.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(p.id)}
            className={`flex flex-col gap-1 rounded-lg border border-border bg-card p-3 ${blocked ? "opacity-50" : ""}`}
          >
            <div className="flex items-center gap-2">
              <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-subtle-foreground" />
              <span className="w-4 tabular-nums text-subtle-foreground">{i + 1}</span>
              <span className="min-w-0 truncate font-medium" title={p.name}>
                {p.name}
              </span>
              <Badge variant="outline" className="text-muted-foreground">
                {p.network === "public" ? <Globe aria-hidden /> : <House aria-hidden />}
                {p.network === "public" ? "公网" : "内网"}
                {p.network_overridden && "（手动）"}
              </Badge>
              <Health provider={p} />
              <Toggle
                label={`启用 ${p.name}`}
                text={p.enabled ? "启用" : "停用"}
                on={p.enabled}
                disabled={busy || blocked}
                onChange={() => props.onToggle(p)}
              />
            </div>
            <p className="truncate pl-10 text-muted-foreground" title={p.base_url}>
              {p.base_url} · {p.model}
              {p.api_key_last4 && ` · Key ••••${p.api_key_last4}`}
            </p>
            <div className="flex flex-wrap items-center gap-2 pl-10 text-muted-foreground">
              <span className="tabular-nums">
                今日 {p.usage_today.calls} 次 · {tokens(p.usage_today.tokens)} tokens
                {p.structured_output && ` · 结构化输出 ${p.structured_output === "none" ? "无" : p.structured_output}`}
              </span>
              {blocked && <span>已全局禁止公网供应商</span>}
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => props.onTest(p)}
                  disabled={testing !== null || blocked}
                  className={button}
                >
                  {testing === p.id ? "测试中…" : "测试"}
                </button>
                <button type="button" onClick={() => props.onEdit(p)} className={button}>
                  编辑
                </button>
                <button type="button" onClick={() => props.onDelete(p)} disabled={busy} className={button}>
                  删除
                </button>
              </span>
            </div>
          </li>
        );
      })}
      <li className="flex items-center gap-2 rounded-lg border border-dashed border-border p-3 text-muted-foreground">
        <span className="font-medium text-foreground">兜底</span>
        规则模板报告
        <span className="ml-auto text-subtle-foreground">始终可用，不可删除、不可移动</span>
      </li>
    </ol>
  );
}

/**
 * 健康状态以图标 + 文字表达，不用状态色（V-M7）；失败时悬停显示原因与日期时间。
 * 停用的供应商同样显示：公网供应商新增后默认停用，管理员先测再决定启用
 */
function Health(props: { provider: Provider }) {
  const test = props.provider.last_test;
  const style = "ml-auto flex shrink-0 items-center gap-1 tabular-nums";
  if (!test)
    return (
      <span className={`${style} text-subtle-foreground`}>
        <Minus aria-hidden className="size-4" />
        未测试
      </span>
    );
  if (test.health === "failed") {
    const failed = test.checks.find((c) => !c.ok);
    const why = [failed?.reason, failed?.hint].filter(Boolean).join("；");
    return (
      <span className={style} title={`${why}（${new Date(test.tested_at).toLocaleString("zh-CN", { hour12: false })}）`}>
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

/** shadcn 开关 + 可见文字：label 给读屏，text 为可见文字（卡片开关显示当前状态） */
function Toggle(props: { label: string; text: string; on: boolean; disabled: boolean; onChange: () => void; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-2", props.className)}>
      <Switch aria-label={props.label} checked={props.on} disabled={props.disabled} onCheckedChange={props.onChange} />
      <span aria-hidden className="text-muted-foreground">
        {props.text}
      </span>
    </span>
  );
}

function Notice(props: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1 text-muted-foreground">
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{props.children}</span>
    </p>
  );
}
