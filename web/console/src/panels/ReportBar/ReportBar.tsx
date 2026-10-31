import { CircleAlert, FileText } from "lucide-react";
import { useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { type Incident, useLive } from "../../store/live";
import { canContain, useSession } from "../../store/session";

export type Report = components["schemas"]["Report"];
export type ReportRequest = { status: "idle" | "pending" } | { status: "failed"; message: string };

const exportUrl = (report: Report, format: "html" | "md") =>
  `/api/reports/${encodeURIComponent(report.id)}/export?format=${format}`;

/**
 * 报告栏（D-079，最简入口；完整报告界面随 TK-071）：对涉及所选设备的最近一个关联事件生成报告，生成后可在新标签页
 * 查看网页、下载 Markdown、标记已复核（FR-501、FR-504）。只有 operator 及以上渲染（C-FE-07）；报告只保存在本组件中。
 */
export function ReportBar(props: { deviceId: string }) {
  const incident = useLive((s) => s.incidents.find((i) => i.device_ids.includes(props.deviceId)));
  const role = useSession((s) => s.role);
  if (!incident || !canContain(role)) return null;
  // key：换了关联事件即不再显示上一个事件的报告
  return <ReportBarState key={incident.id} incident={incident} />;
}

function ReportBarState(props: { incident: Incident }) {
  const { incident } = props;
  const [report, setReport] = useState<Report | null>(null);
  const [request, setRequest] = useState<ReportRequest>({ status: "idle" });

  async function run(call: () => Promise<Report>) {
    setRequest({ status: "pending" });
    try {
      setReport(await call());
      setRequest({ status: "idle" });
    } catch (e) {
      setRequest({ status: "failed", message: e instanceof ApiError ? e.message : "无法连接服务器，请重试" });
    }
  }

  return (
    <ReportBarView
      incident={incident}
      report={report}
      request={request}
      onGenerate={() => void run(() => api.createReport(incident.id))}
      onReview={(r) => void run(() => api.reviewReport(r.id))}
    />
  );
}

export function ReportBarView(props: {
  incident: Incident;
  report: Report | null;
  request: ReportRequest;
  onGenerate: () => void;
  onReview: (report: Report) => void;
}) {
  const { incident, report, request, onGenerate, onReview } = props;
  const pending = request.status === "pending";
  const button = "h-9 rounded-full border border-line px-4 transition-colors hover:bg-raised disabled:opacity-40";
  const link = "underline underline-offset-4 hover:text-fg";
  return (
    <section aria-label="报告" className="flex flex-col gap-2 rounded-xl border border-line p-3 text-sm">
      <p className="flex items-center gap-2">
        <FileText aria-hidden className="size-4 shrink-0" />
        <span className="shrink-0 font-medium">溯源报告</span>
        <span className="min-w-0 truncate text-fg-3" title={incident.title}>
          {incident.title}
        </span>
      </p>
      {report === null ? (
        <button type="button" onClick={onGenerate} disabled={pending} className={`${button} self-start`}>
          {pending ? "生成中…" : "生成报告"}
        </button>
      ) : (
        <>
          <p className="text-fg-2">
            {report.source === "template" ? "模板生成" : "模型生成"} ·{" "}
            {report.reviewed_by ? `已复核：${report.reviewed_by}` : "未复核草稿"}
          </p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-fg-2">
            <a href={exportUrl(report, "html")} target="_blank" rel="noopener noreferrer" className={link}>
              查看报告
            </a>
            <a href={exportUrl(report, "md")} download className={link}>
              下载 Markdown
            </a>
            {!report.reviewed_by && (
              <button type="button" onClick={() => onReview(report)} disabled={pending} className={button}>
                {pending ? "提交中…" : "标记已复核"}
              </button>
            )}
          </p>
        </>
      )}
      {request.status === "failed" && (
        <p role="alert" className="flex items-center gap-1 text-fg-2">
          <CircleAlert aria-hidden className="size-4" />
          {request.message}
        </p>
      )}
    </section>
  );
}
