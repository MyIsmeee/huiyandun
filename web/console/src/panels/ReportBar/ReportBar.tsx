import { ArrowLeft, CircleAlert, FileText } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { type Incident, useLive } from "../../store/live";
import { canContain, useSession } from "../../store/session";
import { useDeviceIncident } from "../IncidentTimeline/IncidentTimeline";

export type Report = components["schemas"]["Report"];
export type ReportRequest = { status: "idle" | "pending" } | { status: "failed"; message: string };
export type ReportsLoad = { status: "loading" | "failed" } | { status: "ready"; reports: Report[] };

const exportUrl = (report: Report, format: "html" | "md") =>
  `/api/reports/${encodeURIComponent(report.id)}/export?format=${format}`;
const failure = (e: unknown) => (e instanceof ApiError ? e.message : "无法连接服务器，请重试");
/** AbortSignal.timeout 到时抛 TimeoutError（部分实现为 AbortError） */
const timedOut = (e: unknown) => e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
/** 客户端等不到结果时服务端可能仍在生成：到时与之后再隔这么久各重读一次列表 */
const LATE_RELOAD_MS = 30_000;
const source = (report: Report) => (report.source === "template" ? "模板生成" : "模型生成");
const describe = (report: Report) =>
  `${source(report)} · ${report.reviewed_by ? `已复核：${report.reviewed_by}` : "未复核草稿"}`;
// 历史行须在详情面板宽度内放下复核状态：时刻到分，复核人放在悬停说明
const MINUTE = { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } as const;
const row = (report: Report) =>
  `${new Date(report.created_at).toLocaleString("zh-CN", MINUTE)} · ${source(report)} · ${report.reviewed_by ? "已复核" : "未复核"}`;

const button = buttonVariants({ variant: "outline", size: "sm" });
const link = "underline underline-offset-4 hover:text-foreground";

/** 导出接口是 POST，不能用 <a download> 直接下载：取回后交给浏览器保存 */
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // 下载开始后再释放，立即释放在部分浏览器中会使下载失败
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 导出 PDF：把导出网页装进一个临时的 iframe，由浏览器打印（目标选"另存为 PDF"），版式、水印与导出网页一致（V-AI4）。
 * 报告页里显示正文的 iframe 完全沙箱化，父页面不能对它调用打印，所以另开一个：只放行同源与打印对话框，不放行脚本
 * （报告本身也不含脚本，导出接口另有 CSP）。打印结束或取消后移除
 */
export function printReport(report: Report) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.title = "报告打印";
  frame.style.display = "none";
  frame.addEventListener("load", () => {
    const view = frame.contentWindow;
    if (!view) return frame.remove();
    view.addEventListener("afterprint", () => frame.remove(), { once: true });
    view.focus();
    view.print();
  });
  frame.src = exportUrl(report, "html");
  document.body.append(frame);
}

type Job = { status: "pending" } | { status: "failed"; message: string };

/**
 * 生成报告的请求按关联事件记在模块级（最长 70 s）：详情面板关闭再打开时仍显示生成中、不能再点，
 * 结果回来时若该事件的报告栏正在显示即打开新报告。version 每次需要重读历史列表时递增
 */
export const useReports = create<{ jobs: Record<string, Job>; versions: Record<string, number> }>()(() => ({ jobs: {}, versions: {} }));
/** 正在显示的报告栏打开报告的方法（按关联事件）：结果回来时没有报告栏在显示就不打开，只等下次打开时读列表 */
const openers = new Map<string, Set<(report: Report) => void>>();

const setJob = (id: string, job: Job | null) =>
  useReports.setState((s) => ({
    jobs: job ? { ...s.jobs, [id]: job } : Object.fromEntries(Object.entries(s.jobs).filter(([key]) => key !== id)),
  }));
const bump = (id: string) => useReports.setState((s) => ({ versions: { ...s.versions, [id]: (s.versions[id] ?? 0) + 1 } }));

export async function generateReport(incidentId: string): Promise<void> {
  if (useReports.getState().jobs[incidentId]?.status === "pending") return;
  setJob(incidentId, { status: "pending" });
  try {
    const report = await api.createReport(incidentId);
    setJob(incidentId, null);
    for (const open of openers.get(incidentId) ?? []) open(report);
    bump(incidentId); // 重新读取完整列表，不在可能读取失败或未读完的旧列表上拼接
  } catch (e) {
    if (timedOut(e)) {
      setJob(incidentId, { status: "failed", message: "生成超时，报告可能仍在生成，稍后会出现在列表中" });
      bump(incidentId);
      setTimeout(() => bump(incidentId), LATE_RELOAD_MS);
    } else setJob(incidentId, { status: "failed", message: failure(e) });
  }
}

/**
 * 报告栏（TK-071）：列出涉及所选设备的最近一个关联事件的全部历史报告，点击在主界面之上打开报告页；
 * 全部角色可看，"生成报告""导出证据包"（TK-081，演示第 11 步）只有 operator 及以上渲染（C-FE-07）。
 * 生成后新报告置顶并直接打开。
 */
export function ReportBar(props: { deviceId: string }) {
  const { deviceId } = props;
  // 报告页打开期间锁定其关联事件：同一设备来了新事件也不换，否则报告栏重建、正在看的报告页随之关闭。
  // 未锁定时取告警栏点选的那一起，否则该设备最近的一起：生成报告、导出证据包都针对它
  const [pinned, setPinned] = useState<string | null>(null);
  const selected = useDeviceIncident(deviceId);
  const incident = useLive((s) => s.incidents.find((i) => i.id === pinned && i.device_ids.includes(deviceId))) ?? selected;
  const canEdit = canContain(useSession((s) => s.role));
  if (!incident) return null;
  // key：换了关联事件即重新拉取，不再显示上一个事件的报告
  return <ReportBarState key={incident.id} incident={incident} canEdit={canEdit} onPin={setPinned} />;
}

function ReportBarState(props: { incident: Incident; canEdit: boolean; onPin: (incidentId: string | null) => void }) {
  const { incident, canEdit, onPin } = props;
  const [load, setLoad] = useState<ReportsLoad>({ status: "loading" });
  const job = useReports((s) => s.jobs[incident.id]);
  const version = useReports((s) => s.versions[incident.id] ?? 0);
  const request: ReportRequest = job ?? { status: "idle" };
  const [review, setReview] = useState<ReportRequest>({ status: "idle" });
  const [exporting, setExporting] = useState<ReportRequest>({ status: "idle" });
  // 打开的报告单独保存，不随列表的读取结果变化；openId 供请求返回时核对打开的仍是同一份
  const [open, setOpen] = useState<Report | null>(null);
  const openId = useRef<string | null>(null);
  // 只采用最近一次读取的结果：晚到的旧结果不覆盖生成后重新读取的列表
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<Report[] | null> => {
    const seq = ++latest.current;
    const next: ReportsLoad = await api.listReports(incident.id).then(
      ({ items }) => ({ status: "ready", reports: items }),
      () => ({ status: "failed" }),
    );
    if (seq === latest.current) setLoad(next);
    return next.status === "ready" ? next.reports : null;
  }, [incident.id]);

  useEffect(() => void reload(), [reload, version]);
  // 换了设备或关联事件而卸载时解除锁定
  useEffect(() => () => onPin(null), [onPin]);
  const openReport = useCallback(
    (report: Report | null) => {
      setReview({ status: "idle" });
      setOpen(report);
      openId.current = report?.id ?? null;
      onPin(report ? incident.id : null);
    },
    [incident.id, onPin],
  );
  // 生成的报告回来时本报告栏在显示：新报告直接打开（列表由 version 递增重读）
  useEffect(() => {
    const id = incident.id;
    const set = openers.get(id) ?? new Set();
    openers.set(id, set.add(openReport));
    return () => {
      set.delete(openReport);
      if (set.size > 0) return;
      openers.delete(id);
      // 失败提示只对正在看的人有意义：关闭后不再带到下次打开
      if (useReports.getState().jobs[id]?.status === "failed") setJob(id, null);
    };
  }, [incident.id, openReport]);

  async function exportEvidence() {
    setExporting({ status: "pending" });
    try {
      save(await api.exportEvidence(incident.id), `evidence-${incident.id}.zip`);
      setExporting({ status: "idle" });
    } catch (e) {
      setExporting({ status: "failed", message: failure(e) });
    }
  }

  async function markReviewed(id: string) {
    setReview({ status: "pending" });
    try {
      const report = await api.reviewReport(id);
      setLoad((l) => (l.status === "ready" ? { ...l, reports: l.reports.map((r) => (r.id === id ? report : r)) } : l));
      // 返回前已关闭或换看了另一份：不把这一份重新打开，也不改另一份的提示
      if (openId.current !== id) return;
      setOpen(report);
      setReview({ status: "idle" });
    } catch (e) {
      if (openId.current === id) setReview({ status: "failed", message: failure(e) });
      // 已被他人复核（409）：重读列表，打开的报告换成最新内容，不再显示复核按钮
      if (e instanceof ApiError && e.status === 409) {
        const reports = await reload();
        const fresh = reports?.find((r) => r.id === id);
        if (fresh && openId.current === id) setOpen(fresh);
      }
    }
  }

  return (
    <>
      <ReportBarView
        incident={incident}
        load={load}
        request={request}
        exporting={exporting}
        canEdit={canEdit}
        onGenerate={() => void generateReport(incident.id)}
        onExport={() => void exportEvidence()}
        onOpen={openReport}
      />
      {/* 与供应商页相同，盖在主界面之上而不替换它；挂到 body 下，不受详情面板的布局约束 */}
      {open &&
        createPortal(
          <div role="dialog" aria-modal="true" aria-label="溯源报告" className="fixed inset-0 z-10 bg-background">
            <ReportPage
              report={open}
              canReview={canEdit}
              review={review}
              onReview={() => void markReviewed(open.id)}
              onClose={() => openReport(null)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

export function ReportBarView(props: {
  incident: Incident;
  load: ReportsLoad;
  request: ReportRequest;
  exporting: ReportRequest;
  canEdit: boolean;
  onGenerate: () => void;
  onExport: () => void;
  onOpen: (report: Report) => void;
}) {
  const { incident, load, request, exporting, canEdit, onGenerate, onExport, onOpen } = props;
  return (
    <section aria-label="报告" className="flex flex-col gap-2.5 border-t pt-4 text-sm">
      <p className="flex items-center gap-2">
        <FileText aria-hidden className="size-4 shrink-0" />
        <span className="shrink-0 font-medium">溯源报告</span>
        <span className="min-w-0 truncate text-subtle-foreground" title={incident.title}>
          {incident.title}
        </span>
      </p>
      {load.status === "loading" && <p className="text-subtle-foreground">读取历史报告…</p>}
      {load.status === "failed" && <p className="text-subtle-foreground">历史报告读取失败</p>}
      {load.status === "ready" &&
        (load.reports.length === 0 ? (
          <p className="text-subtle-foreground">尚无报告</p>
        ) : (
          <ul aria-label="历史报告" className="flex max-h-32 flex-col overflow-y-auto">
            {load.reports.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  title={describe(r)}
                  className="w-full truncate rounded-md px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  {row(r)}
                </button>
              </li>
            ))}
          </ul>
        ))}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onGenerate} disabled={request.status === "pending"} className={button}>
            {request.status === "pending" ? "生成中…" : "生成报告"}
          </button>
          <button type="button" onClick={onExport} disabled={exporting.status === "pending"} className={button}>
            {exporting.status === "pending" ? "导出中…" : "导出证据包"}
          </button>
        </div>
      )}
      {request.status === "failed" && <Failure message={request.message} />}
      {exporting.status === "failed" && <Failure message={exporting.message} />}
    </section>
  );
}

/**
 * 报告页（D-097）：嵌入导出网页，事实区、AI 区、未溯源标记、水印都由它呈现（V-AI1～V-AI5），与导出文件一致。
 * 网页不含脚本，iframe 也不放行脚本；复核后重新加载，水印随之消失（V-AI4）。
 */
export function ReportPage(props: {
  report: Report;
  canReview: boolean;
  review: ReportRequest;
  onReview: () => void;
  onClose: () => void;
}) {
  const { report, canReview, review, onReview, onClose } = props;
  // Esc 返回：报告页盖住了详情面板，详情面板此时不处理 Esc（DetailPanel 的 Drawer）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-3 p-4 text-sm">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" onClick={onClose} className={`${button} flex items-center gap-2`}>
          <ArrowLeft aria-hidden className="size-4" />
          返回
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-medium" title={report.facts.incident.title}>
          溯源报告：{report.facts.incident.title}
        </h1>
        <span className="text-muted-foreground">{describe(report)}</span>
        {canReview && !report.reviewed_by && (
          <button type="button" onClick={onReview} disabled={review.status === "pending"} className={button}>
            {review.status === "pending" ? "提交中…" : "标记已复核"}
          </button>
        )}
        <button type="button" onClick={() => printReport(report)} className={button}>
          导出 PDF
        </button>
        <a href={exportUrl(report, "md")} download className={`${link} text-muted-foreground`}>
          下载 Markdown
        </a>
        <a href={exportUrl(report, "html")} target="_blank" rel="noopener noreferrer" className={`${link} text-muted-foreground`}>
          新标签页打开
        </a>
      </header>
      {review.status === "failed" && <Failure message={review.message} />}
      <iframe
        key={report.reviewed_at ?? "draft"}
        title="报告内容"
        src={exportUrl(report, "html")}
        sandbox=""
        className="min-h-0 flex-1 rounded-lg border border-border bg-white"
      />
    </div>
  );
}

function Failure(props: { message: string }) {
  return (
    <p role="alert" className="flex items-center gap-1 text-muted-foreground">
      <CircleAlert aria-hidden className="size-4" />
      {props.message}
    </p>
  );
}
