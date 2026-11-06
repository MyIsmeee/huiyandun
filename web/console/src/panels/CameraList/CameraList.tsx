import { ArrowLeft, CircleAlert, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../../lib/api";
import { useLive } from "../../store/live";
import { type Camera, CameraEditor } from "../CameraEditor/CameraEditor";

export type CameraLoad = { status: "loading" } | { status: "failed"; message: string } | { status: "ready"; cameras: Camera[] };

const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : "无法连接服务器，请重试");
const button = "h-8 rounded-full border border-line px-3 transition-colors hover:bg-raised disabled:opacity-40";
const PROTOCOL = { rtsp: "RTSP", rtmp: "RTMP", http: "HTTP", onvif: "ONVIF" } as const;

/** 不含凭据的拉流地址（V-CAM1） */
export function address(camera: Camera): string {
  const s = camera.source;
  if (!s) return "推流";
  const host = s.host.includes(":") ? `[${s.host}]` : s.host;
  return s.protocol === "onvif" ? `onvif://${host}:${s.port}` : `${s.protocol}://${host}:${s.port}/${s.path.replace(/^\//, "")}`;
}

/**
 * 摄像头页（04 §7.4），只对 admin 渲染入口（C-FE-07）。保存后各服务即时生效（FR-906），列表以服务端为准重新读取。
 */
export function CameraPage(props: { onClose: () => void }) {
  const [load, setLoad] = useState<CameraLoad>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Camera | null>(null);
  const [editing, setEditing] = useState<{ camera: Camera | null } | null>(null);
  const reload = useCallback(
    () =>
      api.listCameras().then(
        (list) => setLoad({ status: "ready", cameras: list.items }),
        (e: unknown) => setLoad({ status: "failed", message: errorMessage(e) }),
      ),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(camera: Camera) {
    setDeleting(null);
    setNotice(null);
    try {
      await api.deleteCamera(camera.id);
    } catch (e) {
      setNotice(errorMessage(e));
    }
    await reload();
  }

  return (
    <CameraListView
      load={load}
      notice={notice}
      deleting={deleting}
      onClose={props.onClose}
      onRetry={() => void reload()}
      onAdd={() => setEditing({ camera: null })}
      onEdit={(c) => setEditing({ camera: c })}
      onDelete={setDeleting}
      onConfirmDelete={(c) => void remove(c)}
      onCancelDelete={() => setDeleting(null)}
      editor={editing && <CameraEditor camera={editing.camera} onClose={() => setEditing(null)} onSaved={() => void reload()} />}
    />
  );
}

export function CameraListView(props: {
  load: CameraLoad;
  notice: string | null;
  deleting: Camera | null;
  onClose: () => void;
  onRetry: () => void;
  onAdd: () => void;
  onEdit: (camera: Camera) => void;
  onDelete: (camera: Camera) => void;
  onConfirmDelete: (camera: Camera) => void;
  onCancelDelete: () => void;
  editor?: ReactNode;
}) {
  const { load, notice, deleting } = props;
  const devices = useLive((s) => s.devices);
  return (
    <section aria-label="摄像头" className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6 text-sm">
      <header className="flex items-center gap-3">
        <button type="button" onClick={props.onClose} className={`${button} flex items-center gap-1`}>
          <ArrowLeft aria-hidden className="size-4" />
          返回
        </button>
        <h1 className="text-base font-semibold">摄像头</h1>
        <button type="button" onClick={props.onAdd} className={`${button} ml-auto flex items-center gap-1`}>
          <Plus aria-hidden className="size-4" />
          添加
        </button>
      </header>
      <p className="text-fg-3">保存后立即生效：大屏出现视场锥体，视觉引擎开始识别，网络告警按设备 IP 关联。</p>
      {notice && (
        <p role="alert" className="flex items-center gap-1">
          <CircleAlert aria-hidden className="size-4" />
          {notice}
        </p>
      )}
      {load.status === "loading" && <p className="text-fg-3">加载中…</p>}
      {load.status === "failed" && (
        <p className="flex items-center gap-2">
          {load.message}
          <button type="button" onClick={props.onRetry} className={button}>
            重试
          </button>
        </p>
      )}
      {load.status === "ready" && load.cameras.length === 0 && <p className="text-fg-3">还没有摄像头，点"添加"登记第一路。</p>}
      {load.status === "ready" && load.cameras.length > 0 && (
        <ul aria-label="摄像头列表" className="flex flex-col gap-2">
          {load.cameras.map((camera) => {
            const offline = devices[camera.id]?.state === "offline";
            return (
              <li key={camera.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
                <span className="w-14 font-mono text-fg-2">{camera.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{camera.name}</span>
                  <span className="block truncate text-xs text-fg-3">
                    {address(camera)} · 口令 {camera.password_set ? "已设置" : "未设置"}
                  </span>
                </span>
                <span className="text-xs text-fg-2">
                  {camera.source ? `拉流 · ${PROTOCOL[camera.source.protocol]}` : "推流"} · {camera.ip}
                </span>
                {/* 在线状态以图标形状 + 文字表达，不使用状态色（V-CAM1） */}
                <span className="w-16 text-xs">{offline ? "○ 离线" : "● 在线"}</span>
                <span className="w-24 text-xs text-fg-3">{camera.calibration.length >= 4 ? "已标定" : "按安装参数估算"}</span>
                <button type="button" aria-label={`编辑 ${camera.name}`} onClick={() => props.onEdit(camera)} className={button}>
                  <Pencil aria-hidden className="size-4" />
                </button>
                <button type="button" aria-label={`删除 ${camera.name}`} onClick={() => props.onDelete(camera)} className={button}>
                  <Trash2 aria-hidden className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {deleting && (
        <div role="alertdialog" aria-label="确认删除" className="rounded-xl border border-line bg-raised p-4">
          <p>
            删除摄像头"{deleting.name}"（{deleting.id}）？该摄像头的告警历史保留，实时识别与录像停止。
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={props.onCancelDelete} className={button}>
              取消
            </button>
            <button type="button" onClick={() => props.onConfirmDelete(deleting)} className={`${button} font-semibold`}>
              删除
            </button>
          </div>
        </div>
      )}
      {props.editor}
    </section>
  );
}
