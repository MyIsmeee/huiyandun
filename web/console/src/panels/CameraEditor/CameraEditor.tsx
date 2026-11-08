import { CircleAlert, Eraser, X } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type MouseEvent, useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";

type Schemas = components["schemas"];
export type Camera = Schemas["Camera"];
type Protocol = Schemas["CameraSource"]["protocol"];
type Pose = Schemas["Pose"];

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
  host: c?.source?.host ?? "",
  port: c?.source?.port ?? PROTOCOLS.rtsp[1],
  path: c?.source?.path ?? "",
  relay: c?.source?.relay ?? false,
  username: c?.username ?? "",
  password: "",
  pose: c?.pose ?? DEFAULT_POSE,
  climb_lines: c?.climb_lines ?? [],
});

/** 设备推流的地址（FR-907）：推到边缘主机的 8554 端口，路径即摄像头编号；边缘主机即打开本页的主机 */
export const pushUrl = (id: string) => `rtsp://${location.hostname}:8554/${id}`;
export const PUSH_USER = "hyd";

const RELAYABLE = new Set<Protocol>(["rtsp", "rtmp"]);

/** 主机留空时取设备 IP（常见情况：摄像头本身提供取流服务）；推流不带拉流地址与凭据 */
export function body(form: CameraForm): Schemas["CameraCreate"] {
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

/** 取一帧画面；失败时给出服务端的白话原因（V-CAM4） */
const snapshotOf = (id: string): Promise<Snapshot> =>
  api.getCameraSnapshot(id).then(
    (blob) => ({ status: "ready", url: URL.createObjectURL(blob) }),
    (e: unknown) => ({ status: "failed", message: e instanceof ApiError ? e.message : "取不到画面，请重试" }),
  );

type Snapshot = { status: "none" } | { status: "loading" } | { status: "ready"; url: string } | { status: "failed"; message: string };

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
  const set = (patch: Partial<CameraForm>) => setForm((f) => ({ ...f, ...patch }));

  async function preview(id: string) {
    setSnapshot({ status: "loading" });
    setSnapshot(await snapshotOf(id));
  }
  useEffect(() => {
    if (!props.camera) return;
    let current = true;
    void snapshotOf(props.camera.id).then((s) => current && setSnapshot(s));
    return () => {
      current = false;
    };
  }, [props.camera]);
  useEffect(() => () => void (snapshot.status === "ready" && URL.revokeObjectURL(snapshot.url)), [snapshot]);

  async function save() {
    setPending(true);
    setMessage(null);
    try {
      const request = body(form);
      const camera = saved ? await api.updateCamera(saved.id, request) : await api.createCamera(request);
      setSaved(camera);
      if (camera.push_password) setPushPassword(camera.push_password);
      set({ password: "" });
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
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
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
          <button type="button" aria-label="关闭" onClick={props.onClose} className="grid size-8 place-items-center rounded-full hover:bg-secondary">
            <X aria-hidden className="size-4" />
          </button>
        </header>

        <div className="grid grid-cols-[6rem_minmax(0,1fr)_6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <Label htmlFor="cam-name">名称</Label>
          <Input id="cam-name" required maxLength={40} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          <Label htmlFor="cam-ip">设备 IP</Label>
          <Input id="cam-ip" required placeholder="192.168.8.31" value={form.ip} onChange={(e) => set({ ip: e.target.value })} />
          <span>接入方式</span>
          <RadioGroup
            aria-label="接入方式"
            value={form.ingest}
            onValueChange={(value) => set({ ingest: value as typeof form.ingest })}
            className="col-span-3 flex gap-4"
          >
            {(
              [
                ["pull", "拉流（系统从摄像头取流）"],
                ["push", "推流（设备推到本机）"],
              ] as const
            ).map(([value, label]) => (
              <Label key={value}>
                <RadioGroupItem value={value} />
                {label}
              </Label>
            ))}
          </RadioGroup>
          {form.ingest === "push" ? (
            <PushInfo id={saved?.id ?? null} password={pushPassword} />
          ) : (
            <>
          <Label htmlFor="cam-protocol">协议</Label>
          <Select
            value={form.protocol}
            onValueChange={(value) => {
              const protocol = value as Protocol;
              set({ protocol, port: PROTOCOLS[protocol][1] });
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
          <Input id="cam-port" type="number" min={1} max={65535} required value={form.port} onChange={(e) => set({ port: Number(e.target.value) })} />
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
          <p className="text-xs text-subtle-foreground">朝向自平面 x 轴正方向逆时针计；俯角向下为负。保存后大屏按此画出视场锥体，并估算人员位置。</p>
          <div className="grid grid-cols-4 gap-x-3 gap-y-2">
            {POSE_FIELDS.map(([key, label, unit]) => (
              <Label key={key} className="flex items-center gap-2">
                <span className="w-20 shrink-0">{label}</span>
                <Input
                  type="number"
                  step="any"
                  required
                  aria-label={label}
                  value={form.pose[key]}
                  onChange={(e) => set({ pose: { ...form.pose, [key]: Number(e.target.value) } })}
                />
                <span className="text-subtle-foreground">{unit}</span>
              </Label>
            ))}
          </div>
        </fieldset>

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
          <button type="button" onClick={props.onClose} className={button}>
            关闭
          </button>
          <button type="submit" disabled={pending} className={buttonVariants({ size: "sm" })}>
            {pending ? "保存中…" : "保存"}
          </button>
        </footer>
      </form>
      </DialogContent>
    </Dialog>
  );
}

/** 推流地址、用户名与口令（FR-907、V-CAM2）：口令只在保存为推流后显示一次 */
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
