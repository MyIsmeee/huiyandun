import { Check, CircleAlert, X } from "lucide-react";
import { useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import type { Provider } from "../ProviderList/ProviderList";

type Schemas = components["schemas"];
type Preset = Schemas["Preset"];
export type TestResult = Schemas["ProviderTestResult"];
export type EditorForm = {
  preset: Preset;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  timeout_s: number;
  network: "auto" | Schemas["Network"];
};
export type Pending = "save" | "test" | "models" | null;

// 本地服务填局域网 IP（04 §7 的示例主机），端口为各服务默认值；域名一律判为公网（C-LLM-13），故不用 host.docker.internal
const PRESETS: Record<Preset, [label: string, url: string]> = {
  llama_cpp: ["llama.cpp", "http://192.168.1.50:8080/v1"],
  ollama: ["Ollama", "http://192.168.1.50:11434/v1"],
  lm_studio: ["LM Studio", "http://192.168.1.50:1234/v1"],
  vllm: ["vLLM", "http://192.168.1.50:8000/v1"],
  deepseek: ["DeepSeek", "https://api.deepseek.com/v1"],
  bailian: ["阿里云百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  kimi: ["Kimi", "https://api.moonshot.cn/v1"],
  zhipu: ["智谱", "https://open.bigmodel.cn/api/paas/v4"],
  siliconflow: ["硅基流动", "https://api.siliconflow.cn/v1"],
  custom: ["自定义", ""],
};
const CHECKS = { connectivity: "连通", model: "模型存在", structured_output: "结构化输出" } as const;
const LOOPBACK = /^\s*https?:\/\/(127\.|localhost(?=[:/]|\s*$)|\[::1\])/i;
const button = "h-9 rounded-full border border-line px-4 transition-colors hover:bg-raised disabled:opacity-40";
const field = "h-9 min-w-0 rounded-lg border border-line bg-page px-3";

const initialForm = (p: Provider | null): EditorForm => ({
  preset: p?.preset ?? "llama_cpp",
  name: p?.name ?? PRESETS.llama_cpp[0],
  base_url: p?.base_url ?? PRESETS.llama_cpp[1],
  api_key: "",
  model: p?.model ?? "",
  timeout_s: p?.timeout_s ?? 60,
  network: p?.network_overridden ? p.network : "auto",
});

/**
 * 添加与编辑供应商（04 §7.2）。测试连接只能针对已保存的供应商，故"保存并测试"先保存再测试；
 * 保存后对话框转为编辑该供应商。Key 只写不读：留空表示不修改（V-M5）。
 */
export function ProviderEditor(props: { provider: Provider | null; onClose: () => void; onSaved: () => void }) {
  const [saved, setSaved] = useState(props.provider);
  const [form, setForm] = useState(() => initialForm(props.provider));
  const [models, setModels] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  async function attempt(kind: Pending, action: () => Promise<void>) {
    setPending(kind);
    setMessage(null);
    try {
      await action();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "无法连接服务器，请重试");
    }
    setPending(null);
  }
  async function save(): Promise<Provider> {
    const body = {
      name: form.name.trim(),
      preset: form.preset,
      base_url: form.base_url.trim(),
      model: form.model.trim(),
      timeout_s: form.timeout_s,
      ...(form.api_key ? { api_key: form.api_key } : {}),
      ...(form.network !== "auto" ? { network: form.network } : {}),
    };
    const provider = saved ? await api.updateProvider(saved.id, body) : await api.createProvider(body);
    setSaved(provider);
    // 地址以服务端纠正后的为准；Key 已保存，输入框清空即"不修改"
    setForm((f) => ({ ...f, base_url: provider.base_url, api_key: "" }));
    props.onSaved();
    return provider;
  }
  // 已保存且地址与 Key 未改时用已存的 Key 获取，否则凭当前填写的地址与 Key
  const fetchModels = () =>
    attempt("models", async () => {
      const list =
        saved && !form.api_key && form.base_url.trim() === saved.base_url
          ? await api.listProviderModels(saved)
          : await api.discoverModels({
              base_url: form.base_url.trim(),
              timeout_s: form.timeout_s,
              ...(form.api_key ? { api_key: form.api_key } : {}),
            });
      setModels(list.models);
      if (list.models.length === 0) setMessage("供应商未返回任何模型，请手工填写");
    });

  return (
    <ProviderEditorView
      form={form}
      provider={saved}
      models={models}
      pending={pending}
      message={message}
      result={result}
      onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
      onPreset={(preset) =>
        setForm((f) => ({
          ...f,
          preset,
          base_url: PRESETS[preset][1],
          // 名称仍是上一个预设的默认名时随预设更换
          name: !f.name.trim() || f.name === PRESETS[f.preset][0] ? PRESETS[preset][0] : f.name,
        }))
      }
      onFetchModels={() => void fetchModels()}
      onSave={() =>
        void attempt("save", async () => {
          await save();
          props.onClose();
        })
      }
      onSaveAndTest={() =>
        void attempt("test", async () => {
          setResult(await api.testProvider(await save()));
          props.onSaved();
        })
      }
      onClose={props.onClose}
    />
  );
}

export function ProviderEditorView(props: {
  form: EditorForm;
  provider: Provider | null;
  models: string[];
  pending: Pending;
  message: string | null;
  result: TestResult | null;
  onChange: (patch: Partial<EditorForm>) => void;
  onPreset: (preset: Preset) => void;
  onFetchModels: () => void;
  onSave: () => void;
  onSaveAndTest: () => void;
  onClose: () => void;
}) {
  const { form, provider, models, pending, result, onChange } = props;
  const incomplete = !form.name.trim() || !form.base_url.trim() || !form.model.trim() || !(Number.isInteger(form.timeout_s) && form.timeout_s >= 1);
  const network = provider && (provider.network === "internal" ? "内网" : "公网");
  return (
    <div className="fixed inset-0 z-10 grid place-items-center overflow-auto bg-page/60 p-4">
      <form
        role="dialog"
        aria-modal
        aria-label={provider ? "编辑供应商" : "添加供应商"}
        onSubmit={(e) => {
          e.preventDefault();
          props.onSave();
        }}
        className="flex w-[34rem] max-w-full flex-col gap-3 rounded-2xl border border-line bg-panel p-4 text-sm"
      >
        <h2 className="font-semibold">{provider ? "编辑供应商" : "添加供应商"}</h2>
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label className="contents">
            预设
            <select value={form.preset} onChange={(e) => props.onPreset(e.target.value as Preset)} className={field}>
              {Object.entries(PRESETS).map(([value, [label]]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="contents">
            名称
            <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} className={field} />
          </label>
          <label className="contents">
            地址
            <input value={form.base_url} onChange={(e) => onChange({ base_url: e.target.value })} className={field} />
          </label>
          {LOOPBACK.test(form.base_url) && (
            <p role="alert" className="col-start-2 text-fg-2">
              容器内 127.0.0.1、localhost 指向网关自身：改填模型服务所在主机的局域网 IP，如 http://192.168.1.50:8080/v1（DP-07）
            </p>
          )}
          <label className="contents">
            API Key
            <input
              type="password"
              autoComplete="off"
              value={form.api_key}
              placeholder={provider?.api_key_last4 ? `已保存 ••••${provider.api_key_last4}，留空不修改` : "可选"}
              onChange={(e) => onChange({ api_key: e.target.value })}
              className={field}
            />
          </label>
          {/* 按钮不放进 label，否则成为输入框名称的一部分 */}
          <label htmlFor="provider-model">模型</label>
          <span className="flex gap-2">
            <input
              id="provider-model"
              list="provider-models"
              value={form.model}
              onChange={(e) => onChange({ model: e.target.value })}
              className={`${field} flex-1`}
            />
            <button type="button" onClick={props.onFetchModels} disabled={pending !== null} className={button}>
              {pending === "models" ? "获取中…" : "获取列表"}
            </button>
          </span>
          <datalist id="provider-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <label className="contents">
            超时
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                value={Number.isNaN(form.timeout_s) ? "" : form.timeout_s}
                onChange={(e) => onChange({ timeout_s: e.target.valueAsNumber })}
                className={`${field} w-24`}
              />
              秒
            </span>
          </label>
          <label className="contents">
            网络位置
            <select
              value={form.network}
              onChange={(e) => onChange({ network: e.target.value as EditorForm["network"] })}
              className={field}
            >
              <option value="auto">自动判定{network && `（当前：${network}）`}</option>
              <option value="internal">内网</option>
              <option value="public">公网</option>
            </select>
          </label>
        </div>
        {result && <Result result={result} onChange={onChange} />}
        {props.message && (
          <p role="alert" className="flex items-start gap-1 text-fg-2">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">{props.message}</span>
          </p>
        )}
        <p className="flex justify-end gap-2">
          <button
            type="button"
            onClick={props.onSaveAndTest}
            disabled={pending !== null || incomplete}
            className={button}
          >
            {pending === "test" ? "测试中…" : "保存并测试"}
          </button>
          <button type="button" onClick={props.onClose} className={button}>
            关闭
          </button>
          <button type="submit" disabled={pending !== null || incomplete} className={button}>
            {pending === "save" ? "保存中…" : "保存"}
          </button>
        </p>
      </form>
    </div>
  );
}

/** 分项结果与改法（V-M4）；建议地址与候选模型由管理员一键采用，不静默改写（D-084） */
function Result(props: { result: TestResult; onChange: (patch: Partial<EditorForm>) => void }) {
  const { checks, suggested_base_url: url, suggested_models: candidates } = props.result;
  const link = "underline underline-offset-4 hover:text-fg";
  return (
    <section aria-label="测试结果" className="flex flex-col gap-1.5 rounded-xl border border-line p-3">
      {checks.map((c) => (
        <p key={c.check} className="flex items-start gap-2">
          {c.ok ? <Check aria-hidden className="mt-0.5 size-4 shrink-0" /> : <X aria-hidden className="mt-0.5 size-4 shrink-0" />}
          <span className="w-20 shrink-0">{CHECKS[c.check]}</span>
          <span className="min-w-0 text-fg-2">
            {c.ok ? (c.latency_ms != null ? `${c.latency_ms} ms` : "通过") : [c.reason, c.hint].filter(Boolean).join("；")}
          </span>
        </p>
      ))}
      {url && (
        <p className="flex flex-wrap gap-x-2 text-fg-2">
          建议地址 {url}
          <button type="button" onClick={() => props.onChange({ base_url: url })} className={link}>
            采用
          </button>
        </p>
      )}
      {candidates.length > 0 && (
        <p className="flex flex-wrap gap-x-2 text-fg-2">
          改选模型
          {candidates.map((m) => (
            <button key={m} type="button" onClick={() => props.onChange({ model: m })} className={link}>
              {m}
            </button>
          ))}
        </p>
      )}
    </section>
  );
}
