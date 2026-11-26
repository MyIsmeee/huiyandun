import { CircleAlert, Eraser, RefreshCw, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type MouseEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api, type Site } from "../../lib/api";
import { mappingText } from "../../scene/devices";
import { useLive } from "../../store/live";
import { CalibrationDialog } from "./CalibrationDialog";

type Schemas = components["schemas"];
export type Camera = Schemas["Camera"];
type Protocol = Schemas["CameraSource"]["protocol"];
type Pose = Schemas["Pose"];
type PoseCheck = NonNullable<Camera["pose_check"]>;

const PROTOCOLS: Record<Protocol, [label: string, port: number]> = {
  rtsp: ["RTSP", 554],
  rtmp: ["RTMP", 1935],
  http: ["HTTP（FLV、MJPEG）", 80],
  onvif: ["ONVIF", 80],
};
const POSE_FIELDS: [key: keyof Pose, label: string, unit: string][] = [
  ["x", "位置 x", "m"],
  ["y", "位置 y", "m"],
  ["height_m", "安装高度", "m"],
  ["yaw_deg", "朝向", "°"],
  ["pitch_deg", "俯角", "°"],
  ["hfov_deg", "水平视场角", "°"],
  ["range_m", "可视距离", "m"],
];
const DEFAULT_POSE: Pose = { x: 0, y: 0, height_m: 3, yaw_deg: 0, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const button = buttonVariants({ variant: "outline", size: "sm" });
/** 原生下拉框：与 Input 同样式（ui.md §2） */

export type CameraForm = {
  name: string;
  ip: string;
  ingest: Camera["ingest"];
  protocol: Protocol;
  host: string;
  port: number;
  path: string;
  /** 兼容模式：经 MediaMTX 中继拉流，只对 RTSP / RTMP 有效（D-117） */
  relay: boolean;
  /** USB 摄像头的设备标识（/dev/v4l/by-id 下的名字） */
  device: string;
  username: string;
  password: string;
  pose: Pose;
  climb_lines: number[][];
};

const initialForm = (c: Camera | null): CameraForm => ({
  name: c?.name ?? "",
  ip: c?.ip ?? "",
  ingest: c?.ingest ?? "pull",
  protocol: c?.source?.protocol ?? "rtsp",
  // 主机与设备 IP 相同即当初留空（或等价于留空）：回显为空，之后改了设备 IP 拉流地址随之改，不停在旧 IP
  host: c?.source && c.source.host !== c.ip ? c.source.host : "",
  port: c?.source?.port ?? PROTOCOLS.rtsp[1],
  path: c?.source?.path ?? "",
  relay: c?.source?.relay ?? false,
  device: c?.device ?? "",
  username: c?.username ?? "",
  password: "",
  pose: c?.pose ?? DEFAULT_POSE,
  climb_lines: c?.climb_lines ?? [],
});

/** 设备推流的地址（FR-907）：推到边缘主机的 8554 端口，路径即摄像头编号；边缘主机即打开本页的主机 */
export const pushUrl = (id: string) => `rtsp://${location.hostname}:8554/${id}`;
export const PUSH_USER = "hyd";

const RELAYABLE = new Set<Protocol>(["rtsp", "rtmp"]);

/** 视频文件摄像头的视频上限（D-145），与服务端一致 */
export const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const INGEST_LOCKED = "视频文件摄像头不能与其他接入方式互转";

/**
 * 主机留空时取设备 IP（常见情况：摄像头本身提供取流服务）；推流不带拉流地址与凭据。
 * video 为本次新上传的视频编号：视频文件摄像头没给出时沿用已保存的视频
 */
export function body(form: CameraForm, video?: string): Schemas["CameraCreate"] {
  // 视频文件摄像头同 USB 没有网络地址（D-145）
  if (form.ingest === "file")
    return { name: form.name.trim(), pose: form.pose, climb_lines: form.climb_lines, ingest: "file", source: null, username: null, ...(video ? { video_file: video } : {}) };
  // USB 摄像头没有网络地址：不提交设备 IP，新增时由服务端分配占位地址，修改时保持不变
  if (form.ingest === "usb")
    return { name: form.name.trim(), pose: form.pose, climb_lines: form.climb_lines, ingest: "usb", device: form.device, source: null, username: null };
  const common = { name: form.name.trim(), ip: form.ip.trim(), pose: form.pose, climb_lines: form.climb_lines };
  if (form.ingest === "push") return { ...common, ingest: "push", source: null, username: null };
  return {
    ...common,
    ingest: "pull",
    source: {
      protocol: form.protocol,
      host: form.host.trim() || form.ip.trim(),
      port: form.port,
      path: form.path.trim(),
      relay: form.relay && RELAYABLE.has(form.protocol),
    },
    username: form.username.trim() || null,
    ...(form.password ? { password: form.password } : {}),
  };
}

/** 数字字段：编辑中的文本单独保存，清空或只输入负号时不被改写成 0（受控 number 输入框的值为空串） */
type NumberField = keyof Pose | "port";

/**
 * 数字字段的取值范围（契约 Pose、CameraSource）：返回错误说明，合法时为 null。
 * 位置只在摄像头已放入区域时按区域宽深校验：超出时场景页保存该区域会被拒绝（D-125）
 */
export function fieldError(key: NumberField, text: string, area: { width_m: number; depth_m: number } | null): string | null {
  const v = Number(text);
  if (text.trim() === "" || !Number.isFinite(v)) return "请填写数字";
  switch (key) {
    case "port":
      return Number.isInteger(v) && v >= 1 && v <= 65535 ? null : "端口为 1～65535 的整数";
    case "height_m":
      return v > 0 && v <= 50 ? null : "安装高度须大于 0、不超过 50 m";
    case "pitch_deg":
      return v >= -90 && v < 0 ? null : "俯角须在 -90°～0° 之间（向下为负，不含 0°）";
    case "hfov_deg":
      return v > 0 && v < 180 ? null : "水平视场角须大于 0°、小于 180°";
    case "range_m":
      return v > 0 && v <= 200 ? null : "可视距离须大于 0、不超过 200 m";
    case "x":
      return !area || (v >= 0 && v <= area.width_m) ? null : `须在所在区域内（0～${area.width_m} m）`;
    case "y":
      return !area || (v >= 0 && v <= area.depth_m) ? null : `须在所在区域内（0～${area.depth_m} m）`;
    default:
      return null;
  }
}

/** 摄像头登记表变化后推送的站点；尚未推送过（如 WS 未连上）时读一次 GET /api/site，不因此显示"区域未载入" */
export function useSite(): Site | null {
  const pushed = useLive((s) => s.site);
  const [fetched, setFetched] = useState<Site | null>(null);
  useEffect(() => {
    if (pushed) return;
    let current = true;
    api.getSite().then(
      (site) => current && setFetched(site),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [pushed]);
  return pushed ?? fetched;
}

/** 取一帧画面；失败时给出服务端的白话原因（V-CAM4） */
const snapshotOf = (id: string): Promise<Snapshot> =>
  api.getCameraSnapshot(id).then(
    (blob) => ({ status: "ready", url: URL.createObjectURL(blob) }),
    (e: unknown) => ({ status: "failed", message: e instanceof ApiError ? e.message : "取不到画面，请重试" }),
  );

export type Snapshot = { status: "none" } | { status: "loading" } | { status: "ready"; url: string } | { status: "failed"; message: string };

/**
 * 添加与编辑摄像头（ui.md §7.2）。保存后自动取一帧预览（V-CAM4），可在预览上点两点画禁止攀爬警戒线（V-CAM7），
 * 画完再保存。口令只写不读：留空表示不修改（V-CAM2）。推流方式显示推流地址，推流口令只在保存为推流后显示一次。
 */
export function CameraEditor(props: { camera: Camera | null; onClose: () => void; onSaved: () => void }) {
  const [saved, setSaved] = useState(props.camera);
  const [form, setForm] = useState(() => initialForm(props.camera));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => (props.camera ? { status: "loading" } : { status: "none" }));
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [pushPassword, setPushPassword] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  /** 数字字段编辑中的文本；未编辑过的字段显示表单中的数值 */
  const [texts, setTexts] = useState<Partial<Record<NumberField, string>>>({});
  /** 视频文件摄像头新选的视频，保存时才上传；上传中为进度（0～1），期间不可保存、不可关闭 */
  const [video, setVideo] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  /** 新选视频已上传、摄像头尚未保存成功时的上传编号：重试保存不再上传，重新选视频时清空（服务端保留 10 分钟） */
  const [uploaded, setUploaded] = useState<string | null>(null);
  const tooLarge = form.ingest === "file" && (video?.size ?? 0) > MAX_VIDEO_BYTES;
  const close = () => progress === null && props.onClose();
  /** 编辑已有摄像头时，视频文件与其他接入方式不能互转（D-145） */
  const locked = (ingest: CameraForm["ingest"]) => !!saved && (saved.ingest === "file") !== (ingest === "file");
  /** 保存时改了安装参数：服务端丢弃按旧参数推算的自检，提示新结果要等视觉引擎重新推算 */
  const [poseChanged, setPoseChanged] = useState(false);
  const set = (patch: Partial<CameraForm>) => setForm((f) => ({ ...f, ...patch }));
  const calibrated = (saved?.calibration.length ?? 0) >= 4;
  const site = useSite();
  const area = (saved?.area_id && site?.areas.find((a) => a.id === saved.area_id)) || null;
  const textOf = (key: NumberField) => texts[key] ?? String(key === "port" ? form.port : form.pose[key]);
  const errorOf = (key: NumberField) => (texts[key] === undefined && key !== "x" && key !== "y" ? null : fieldError(key, textOf(key), area));
  /** 数字输入：保留原文；能解析为有限数时写入表单 */
  const edit = (key: NumberField, text: string) => {
    setTexts((t) => ({ ...t, [key]: text }));
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v)) return;
    if (key === "port") set({ port: v });
    else setForm((f) => ({ ...f, pose: { ...f.pose, [key]: v } }));
  };
  /** 整体改写数值（换协议的默认端口、填入建议值）：丢掉这些字段编辑中的文本 */
  const reset = (keys: NumberField[]) =>
    setTexts((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !keys.includes(k as NumberField))));

  // 取帧只采用最近一次的结果：打开时与保存后的取帧互不取消，迟到的旧结果不覆盖新画面；被丢弃或卸载后到达的画面立即释放
  const latest = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const fetchSnapshot = useCallback(async (id: string) => {
    const seq = ++latest.current;
    const next = await snapshotOf(id);
    if (seq !== latest.current || !alive.current) {
      if (next.status === "ready") URL.revokeObjectURL(next.url);
      return;
    }
    setSnapshot(next);
  }, []);
  // 打开时初始状态已是"正在取画面"
  useEffect(() => {
    if (props.camera) void fetchSnapshot(props.camera.id);
  }, [props.camera, fetchSnapshot]);
  function preview(id: string) {
    setSnapshot({ status: "loading" });
    return fetchSnapshot(id);
  }
  useEffect(() => () => void (snapshot.status === "ready" && URL.revokeObjectURL(snapshot.url)), [snapshot]);

  async function save() {
    const invalid = (["port", ...POSE_FIELDS.map(([key]) => key)] as NumberField[]).filter(
      (key) => (key !== "port" || form.ingest === "pull") && fieldError(key, textOf(key), area),
    );
    if (invalid.length > 0) {
      setTexts((t) => Object.fromEntries([...Object.entries(t), ...invalid.map((key) => [key, textOf(key)])]));
      setMessage("请先改正标出的数值");
      return;
    }
    if (form.ingest === "file" && !video && saved?.ingest !== "file") {
      setMessage("请选择视频");
      return;
    }
    setPending(true);
    setMessage(null);
    let id = uploaded;
    if (form.ingest === "file" && video && !id) {
      setProgress(0);
      try {
        id = (await api.uploadVideoFile(video, setProgress)).id;
        setUploaded(id);
      } catch (e) {
        setMessage(e instanceof ApiError ? e.message : "上传中断，请重试");
        setPending(false);
        return;
      } finally {
        setProgress(null);
      }
    }
    try {
      const request = body(form, id ?? undefined);
      const camera = saved ? await api.updateCamera(saved.id, request) : await api.createCamera(request);
      // 保存的响应不含自检：安装参数未变时服务端保留原自检，照旧显示；变了则旧建议作废
      const changed = !!saved && JSON.stringify(saved.pose) !== JSON.stringify(request.pose);
      setSaved({ ...camera, pose_check: camera.pose_check ?? (changed ? null : (saved?.pose_check ?? null)) });
      setPoseChanged(changed && !!saved?.pose_check);
      if (camera.push_password) setPushPassword(camera.push_password);
      set({ password: "" });
      setVideo(null);
      setUploaded(null);
      props.onSaved();
      void preview(camera.id);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : "无法连接服务器，请重试");
    }
    setPending(false);
  }

  /** 预览上点两点成线：坐标按画面原始尺寸换算为像素（与视觉引擎一致） */
  function click(e: MouseEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const u = Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
    const v = Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
    if (!point) return setPoint([u, v]);
    setPoint(null);
    if (point[0] === u) return setMessage("警戒线不能是竖直线段，请重新点两点");
    setMessage(null);
    set({ climb_lines: [...form.climb_lines, [point[0], point[1], u, v]] });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      {/* 点对话框外不关闭，避免丢掉未保存的填写；Esc 与取消按钮照常关闭 */}
      <DialogContent aria-describedby={undefined} showCloseButton={false} onInteractOutside={(e) => e.preventDefault()} className="max-h-[calc(100%-2rem)] overflow-y-auto p-0 sm:max-w-3xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4 p-6 text-sm"
      >
        <header className="flex items-center justify-between">
          <DialogTitle className="text-base font-medium">{saved ? `编辑摄像头 ${saved.id}` : "添加摄像头"}</DialogTitle>
          <button type="button" aria-label="关闭" disabled={progress !== null} onClick={close} className="grid size-8 place-items-center rounded-full hover:bg-secondary">
            <X aria-hidden className="size-4" />
          </button>
        </header>

        <div className="grid grid-cols-[6rem_minmax(0,1fr)_6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <Label htmlFor="cam-name">名称</Label>
          <Input id="cam-name" required maxLength={40} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          <Label htmlFor="cam-ip">设备 IP</Label>
          {form.ingest === "usb" || form.ingest === "file" ? (
            <span id="cam-ip" className="text-sm text-muted-foreground">{form.ingest === "usb" ? "USB 摄像头" : "视频文件"}无需填写</span>
          ) : (
            <Input id="cam-ip" required placeholder="192.168.8.31" value={form.ip} onChange={(e) => set({ ip: e.target.value })} />
          )}
          <span>接入方式</span>
          <RadioGroup
            aria-label="接入方式"
            value={form.ingest}
            onValueChange={(value) => set({ ingest: value as typeof form.ingest })}
            className="col-span-3 flex flex-wrap gap-x-4 gap-y-1"
          >
            {(
              [
                ["pull", "拉流（系统从摄像头取流）"],
                ["push", "推流（设备推到本机）"],
                ["usb", "USB 摄像头（插在本机）"],
                ["file", "视频文件（模拟摄像头）"],
              ] as const
            ).map(([value, label]) => (
              <Label key={value} title={locked(value) ? INGEST_LOCKED : undefined}>
                <RadioGroupItem value={value} disabled={locked(value)} />
                {label}
              </Label>
            ))}
          </RadioGroup>
          {form.ingest === "file" ? (
            <VideoPicker
              file={video}
              savedName={saved?.file_name ?? null}
              progress={progress}
              onChange={(file) => {
                setVideo(file);
                setUploaded(null);
                set({ name: form.name || file.name.replace(/\.[^.]*$/, "").slice(0, 40) });
              }}
            />
          ) : form.ingest === "usb" ? (
            <UsbPicker value={form.device} self={saved?.id ?? null} onChange={(device, name) => set({ device, name: form.name || name })} />
          ) : form.ingest === "push" ? (
            <PushInfo id={saved?.id ?? null} password={pushPassword} />
          ) : (
            <>
          <Label htmlFor="cam-protocol">协议</Label>
          <Select
            value={form.protocol}
            onValueChange={(value) => {
              const protocol = value as Protocol;
              set({ protocol, port: PROTOCOLS[protocol][1] });
              reset(["port"]);
            }}
          >
            <SelectTrigger id="cam-protocol" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PROTOCOLS).map(([key, [label]]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label htmlFor="cam-port">端口</Label>
          <NumberInput id="cam-port" label="端口" value={textOf("port")} error={errorOf("port")} onChange={(text) => edit("port", text)} />
          <Label htmlFor="cam-host">主机</Label>
          <Input id="cam-host" placeholder="留空即设备 IP" value={form.host} onChange={(e) => set({ host: e.target.value })} />
          <Label htmlFor="cam-path">流路径</Label>
          <Input
            id="cam-path"
            disabled={form.protocol === "onvif"}
            placeholder={form.protocol === "onvif" ? "ONVIF 自动获取" : "/Streaming/Channels/101"}
           
            value={form.path}
            onChange={(e) => set({ path: e.target.value })}
          />
          {form.protocol === "http" && (
            <p className="col-span-2 flex items-center gap-1.5 text-xs text-subtle-foreground">
              <CircleAlert aria-hidden className="size-3.5 shrink-0" />
              MJPEG 等 HTTP 画面不能在浏览器实时播放，请尽量改用 RTSP
            </p>
          )}
          {RELAYABLE.has(form.protocol) && (
            <>
              <Label htmlFor="cam-relay">兼容模式</Label>
              <div className="flex items-center gap-2">
                <Switch id="cam-relay" checked={form.relay} onCheckedChange={(relay) => set({ relay })} />
                <span className="text-xs text-subtle-foreground">经中继拉流：部分手机或 ONVIF 设备的画面无法识别时打开</span>
              </div>
            </>
          )}
          <Label htmlFor="cam-user">用户名</Label>
          <Input id="cam-user" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />
          <Label htmlFor="cam-pass">口令</Label>
          <Input
            id="cam-pass"
            type="password"
            autoComplete="new-password"
            placeholder={saved?.password_set ? "已设置，留空不修改" : "可选"}
            value={form.password}
            onChange={(e) => set({ password: e.target.value })}
          />
            </>
          )}
        </div>

        <fieldset className="flex flex-col gap-2 border-t border-border pt-3">
          <legend className="pr-2 font-medium">安装参数</legend>
          <p className="text-xs text-subtle-foreground">
            朝向自平面 +x 转向 +y 计（俯视场景时为顺时针）；俯角向下为负。保存后态势页按此画出视场锥体，并估算人员位置。
            {calibrated && "已标定：位置按标定换算，安装参数只用于画视场；摄像头转动过请重新标定。"}
          </p>
          <div className="grid grid-cols-4 gap-x-3 gap-y-2">
            {POSE_FIELDS.map(([key, label, unit]) => (
              <Label key={key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="w-20 shrink-0">{label}</span>
                <NumberInput label={label} value={textOf(key)} error={errorOf(key)} inline={false} onChange={(text) => edit(key, text)} className="min-w-0 flex-1" />
                <span className="text-subtle-foreground">{unit}</span>
              </Label>
            ))}
          </div>
          {/* 四列网格的格子太窄，错误说明放在网格下方整行显示，不挤压输入框 */}
          {POSE_FIELDS.some(([key]) => errorOf(key)) && (
            <ul aria-label="安装参数错误" className="flex flex-col gap-0.5 text-xs text-destructive">
              {POSE_FIELDS.map(([key, label]) => {
                const error = errorOf(key);
                return error && <li key={key} id={`pose-error-${key}`}>{label}：{error}</li>;
              })}
            </ul>
          )}
          {!calibrated && saved?.pose_check && (
            <PoseCheckNote
              check={saved.pose_check}
              onApply={(pose) => {
                setForm((f) => ({ ...f, pose: { ...f.pose, ...pose } }));
                reset(Object.keys(pose) as NumberField[]);
              }}
            />
          )}
          {!calibrated && poseChanged && !saved?.pose_check && (
            <p className="text-xs text-subtle-foreground">安装参数已修改：自检将按新参数重新推算，需画面中出现足够的站立行人；画面几何估计约 1 分钟后给出</p>
          )}
        </fieldset>

        {saved && (
          <section aria-label="地面映射" className="flex items-center gap-3 border-t border-border pt-3">
            <h3 className="font-medium">地面映射</h3>
            <span className="text-subtle-foreground">{mappingText(saved.calibration, saved.calibration_error_m)}</span>
            {!saved.area_id && <span className="ml-auto text-xs text-subtle-foreground">先在场景页把摄像头放入区域</span>}
            <button type="button" disabled={!saved.area_id} onClick={() => setCalibrating(true)} className={`${button} ${saved.area_id ? "ml-auto" : ""}`}>
              标定
            </button>
          </section>
        )}

        <section aria-label="预览" className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">预览与攀爬警戒线</h3>
            <span className="text-xs text-subtle-foreground">在画面上沿墙顶或栏杆顶点两点画线；共 {form.climb_lines.length} 条</span>
            {form.climb_lines.length > 0 && (
              <button type="button" onClick={() => set({ climb_lines: [] })} className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Eraser aria-hidden className="size-3.5" />
                清除
              </button>
            )}
          </div>
          <SnapshotView snapshot={snapshot} lines={form.climb_lines} point={point} onClick={click} />
        </section>

        {message && (
          <p role="alert" className="flex items-center gap-1">
            <CircleAlert aria-hidden className="size-4" />
            {message}
          </p>
        )}
        <footer className="flex justify-end gap-2">
          <button type="button" disabled={progress !== null} onClick={close} className={button}>
            关闭
          </button>
          <button type="submit" disabled={pending || tooLarge} className={buttonVariants({ size: "sm" })}>
            {pending ? "保存中…" : "保存"}
          </button>
        </footer>
      </form>
      </DialogContent>
      {calibrating && saved?.area_id && (
        <CalibrationDialog
          camera={saved}
          areaId={saved.area_id}
          snapshot={snapshot}
          onClose={() => setCalibrating(false)}
          onSaved={(camera) => {
            setSaved(camera);
            props.onSaved();
          }}
        />
      )}
    </Dialog>
  );
}

/** 数字输入：文本输入框配数字键盘，不用 type=number——其值在只输入负号或清空时为空串，受控时会被改写 */
/** inline 为假时错误说明由调用方另行显示，输入框只标记 aria-invalid */
function NumberInput(props: { id?: string; label: string; value: string; error: string | null; inline?: boolean; onChange: (text: string) => void; className?: string }) {
  const { id, label, value, error, inline = true, onChange, className } = props;
  const hint = useId();
  return (
    <span className={`flex flex-col gap-0.5 ${className ?? ""}`}>
      <Input
        id={id}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={error !== null}
        aria-describedby={error && inline ? hint : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && inline && (
        <span id={hint} className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

/** 推流地址、用户名与口令（FR-907、V-CAM2）：口令只在保存为推流后显示一次 */
type UsbDevice = Schemas["UsbDevice"];

/**
 * USB 摄像头的设备选择：列出插在边缘主机上的摄像头，已被其他摄像头接入的不可选；拔插后点刷新。
 * 选中时名称为空则带出设备名
 */
export function UsbPicker(props: { value: string; self: string | null; onChange: (device: string, name: string) => void }) {
  const { value, self, onChange } = props;
  const [devices, setDevices] = useState<UsbDevice[] | null>(null);
  const [failed, setFailed] = useState(false);
  /** 每次刷新加一，重新读取设备列表 */
  const [round, setRound] = useState(0);
  useEffect(() => {
    let current = true;
    api.listUsbDevices().then(
      (list) => {
        if (!current) return;
        setDevices(list.items);
        setFailed(false);
      },
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [round]);
  const load = () => setRound((n) => n + 1);
  const empty = devices !== null && devices.length === 0;
  return (
    <>
      <Label htmlFor="cam-usb">设备</Label>
      <div className="col-span-3 flex items-center gap-2">
        <Select value={value || undefined} onValueChange={(device) => onChange(device, devices?.find((d) => d.device === device)?.name ?? "")} disabled={!devices || empty}>
          <SelectTrigger id="cam-usb" className="min-w-0 flex-1">
            <SelectValue placeholder={failed ? "读取设备失败" : devices === null ? "正在查找 USB 摄像头…" : empty ? "未发现 USB 摄像头" : "选择要接入的摄像头"} />
          </SelectTrigger>
          <SelectContent>
            {devices?.map((d) => {
              const taken = d.camera_id !== null && d.camera_id !== self;
              return (
                <SelectItem key={d.device} value={d.device} disabled={taken}>
                  {d.name}
                  {taken && `（已接入为 ${d.camera_id}）`}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <button type="button" onClick={load} className={buttonVariants({ variant: "outline", size: "sm" })}>
          <RefreshCw aria-hidden />
          刷新
        </button>
      </div>
      <p className="col-span-4 text-xs text-subtle-foreground">
        只列出插在慧眼盾主机上的 USB 摄像头；插在其他电脑上的请用"推流"。插上新摄像头后点刷新。
      </p>
    </>
  );
}

const megabytes = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

/**
 * 视频文件摄像头的视频（V-CAM11）：未选时为"选择视频…"，已选或已保存时显示文件名（新选的带大小）、按钮为"更换视频"。
 * 文件在保存时才上传；超过 2 GB 立即提示、不可保存
 */
function VideoPicker(props: { file: File | null; savedName: string | null; progress: number | null; onChange: (file: File) => void }) {
  const { file, savedName, progress } = props;
  const input = useRef<HTMLInputElement>(null);
  const chosen = file ? `${file.name}（${megabytes(file.size)}）` : savedName;
  const percent = Math.round((progress ?? 0) * 100);
  return (
    <>
      <Label htmlFor="cam-video">视频</Label>
      <div className="col-span-3 flex min-w-0 items-center gap-2">
        <input
          ref={input}
          id="cam-video"
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) props.onChange(picked);
            e.target.value = ""; // 再选同一文件也触发
          }}
        />
        <button type="button" disabled={progress !== null} onClick={() => input.current?.click()} className={button}>
          {chosen ? "更换视频" : "选择视频…"}
        </button>
        {chosen && <span className="min-w-0 truncate">{chosen}</span>}
      </div>
      {file && file.size > MAX_VIDEO_BYTES && <p className="col-span-4 text-xs text-destructive">视频超过 2 GB</p>}
      {progress !== null && (
        <div className="col-span-4 flex items-center gap-2">
          <Progress value={percent} aria-label="上传进度" className="flex-1" />
          <span className="w-10 text-right text-xs text-subtle-foreground">{percent}%</span>
        </div>
      )}
      <p className="col-span-4 text-xs text-subtle-foreground">
        循环播放，作为一路摄像头识别。api-server 或推流服务重启后失效，需重新添加。短于 3 分钟的视频循环时会被识别为画面重放。
      </p>
    </>
  );
}

function PushInfo({ id, password }: { id: string | null; password: string | null }) {
  return (
    <dl className="col-span-4 grid grid-cols-[6rem_minmax(0,1fr)] gap-y-1 rounded-lg border border-border p-3">
      <dt>推流地址</dt>
      <dd className="font-mono break-all">{id ? pushUrl(id) : "保存后显示（路径为摄像头编号）"}</dd>
      <dt>用户名</dt>
      <dd className="font-mono">{PUSH_USER}</dd>
      <dt>推流口令</dt>
      <dd className="font-mono break-all">{password ?? "已设置（只在保存为推流后显示一次）"}</dd>
    </dl>
  );
}

function SnapshotView(props: {
  snapshot: Snapshot;
  lines: number[][];
  point: [number, number] | null;
  onClick: (e: MouseEvent<HTMLImageElement>) => void;
}) {
  const { snapshot, lines, point } = props;
  const [size, setSize] = useState<[number, number] | null>(null);
  if (snapshot.status !== "ready") {
    const text = {
      none: "保存后显示一帧画面",
      loading: "正在取画面…",
      failed: snapshot.status === "failed" ? `取不到画面：${snapshot.message}` : "",
    }[snapshot.status];
    return <p className="grid aspect-video place-items-center rounded-lg border border-dashed border-border text-subtle-foreground">{text}</p>;
  }
  return (
    <div className="relative">
      <img
        src={snapshot.url}
        alt="摄像头画面预览"
        onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
        onClick={props.onClick}
        className="w-full cursor-crosshair rounded-lg"
      />
      {size && (
        <svg aria-hidden viewBox={`0 0 ${size[0]} ${size[1]}`} className="pointer-events-none absolute inset-0 size-full">
          {lines.map(([u1, v1, u2, v2], i) => (
            <line key={i} x1={u1} y1={v1} x2={u2} y2={v2} stroke="#FFFFFF" strokeWidth={size[0] / 250} />
          ))}
          {point && <circle cx={point[0]} cy={point[1]} r={size[0] / 120} fill="#FFFFFF" />}
        </svg>
      )}
    </div>
  );
}

/**
 * 安装参数自检（视觉引擎按画面中站立行人推算，只对按安装参数估算地面映射的摄像头）：可疑时列出依据与建议值，
 * "填入建议值"只改表单，保存后才生效；样本不足时说明还缺什么
 */
export function PoseCheckNote({ check, onApply }: { check: PoseCheck; onApply: (pose: Partial<Pose>) => void }) {
  return (
    <>
      <PeopleCheck check={check} onApply={onApply} />
      {check.geometry && <GeometryNote geometry={check.geometry} onApply={onApply} />}
    </>
  );
}

/** 侧倾超过此值时提示：地面映射不含侧倾 */
const ROLL_HINT_DEG = 3;

/**
 * 画面几何估计（视觉引擎用单目几何模型从画面拟合地面，不依赖行人）：给出安装高度、俯角、视角的估计值，
 * "填入估计值"只改表单，保存后才生效
 */
function GeometryNote({ geometry, onApply }: { geometry: NonNullable<PoseCheck["geometry"]>; onApply: (pose: Partial<Pose>) => void }) {
  const { height_m: height, pitch_deg: pitch, hfov_deg: hfov, roll_deg: roll } = geometry;
  const fields: [keyof Pose & NumberField, number, string][] = [
    ["height_m", height, `高度 ${height} m`],
    ["pitch_deg", pitch, `俯角 ${pitch}°`],
    ["hfov_deg", hfov, `视角 ${hfov}°`],
  ];
  const usable = fields.filter(([key, value]) => fieldError(key, String(value), null) === null);
  const suggestion = Object.fromEntries(usable.map(([key, value]) => [key, value])) as Partial<Pose>;
  return (
    <div role="status" aria-label="画面几何估计" className="flex flex-col gap-1.5 rounded-md border border-border p-2.5 text-xs">
      <p className="font-medium">按画面自动估计的安装参数</p>
      <p className="text-subtle-foreground">
        安装高度约 {height} m、俯角 {pitch}°、水平视角 {hfov}°；画面中可见地面约 {geometry.floor_width_m} × {geometry.floor_depth_m} m
        {geometry.scale_ref === "desk" ? "（尺度按画面中桌面的标准高度校正）" : "（尺度为模型估计，误差可能较大）"}
      </p>
      {Math.abs(roll) > ROLL_HINT_DEG && <p className="text-subtle-foreground">摄像头约侧倾 {roll}°，地面映射不含侧倾，远处位置会有偏差，建议把画面调正</p>}
      {usable.length > 0 && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onApply(suggestion)} className={button}>
            填入估计值（{usable.map(([, , text]) => text).join("、")}）
          </button>
          <span className="text-subtle-foreground">填入后保存才生效，之后重新生成场景初稿</span>
        </div>
      )}
    </div>
  );
}

function PeopleCheck({ check, onApply }: { check: PoseCheck; onApply: (pose: Partial<Pose>) => void }) {
  if (check.status === "ok") {
    return <p className="text-xs text-subtle-foreground">安装参数自检通过：{check.reasons[0] ?? "与画面中行人的尺度相符"}</p>;
  }
  if (check.status === "insufficient") {
    return <p className="text-xs text-subtle-foreground">安装参数自检暂不能判断：{check.reasons.join("；")}</p>;
  }
  // 视觉引擎在 -85°～+10° 内搜索俯角：超出契约可填范围（-90°～0°，不含 0°）的建议不提供填入，保存会被拒绝
  const { suggested_height_m: height, suggested_pitch_deg: pitch } = check;
  const heightOk = height != null && fieldError("height_m", String(height), null) === null;
  const pitchOk = pitch != null && fieldError("pitch_deg", String(pitch), null) === null;
  const suggestion: Partial<Pose> = {
    ...(heightOk ? { height_m: height } : {}),
    ...(pitchOk ? { pitch_deg: pitch } : {}),
  };
  const parts = [heightOk && `高度 ${height} m`, pitchOk && `俯角 ${pitch}°`].filter(Boolean);
  return (
    <div role="status" aria-label="安装参数自检" className="flex flex-col gap-1.5 rounded-md border border-border p-2.5 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        <CircleAlert aria-hidden className="size-3.5 shrink-0" />
        安装参数可能填错，人员位置与速度会明显偏离
      </p>
      <ul className="list-disc pl-5 text-subtle-foreground">
        {check.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {pitch != null && !pitchOk && (
        <p className="text-subtle-foreground">推算的俯角约 {pitch}°，超出可填范围（向下为负、不含 0°）：摄像头可能接近水平安装，请实地确认后手动填写</p>
      )}
      {height != null && !heightOk && <p className="text-subtle-foreground">推算的安装高度约 {height} m，超出可填范围（0～50 m），请实地确认</p>}
      {parts.length > 0 && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => onApply(suggestion)} className={button}>
            填入建议值（{parts.join("、")}）
          </button>
          <span className="text-subtle-foreground">填入后保存才生效；按 {check.samples} 个站立行人样本推算，仍建议实地量一下</span>
        </div>
      )}
    </div>
  );
}
