import { Clock, RotateCw, Video, VideoOff } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../../lib/api";
import { DetectionOverlay } from "../DetectionOverlay/DetectionOverlay";

/** 连接中 / 播放 / 媒体中断（保留最后画面，等待恢复）/ 不可用 / 设备没有视频流（HYD-UIX-004 §8） */
export type VideoStatus =
  | { kind: "connecting" }
  | { kind: "playing"; stream: MediaStream }
  | { kind: "interrupted"; stream: MediaStream }
  | { kind: "unavailable"; reason: string }
  | { kind: "none" };

/** 取得 answer 后超过此时长仍未取得画面即判为不可用；信令本身的超时由 api 客户端负责 */
const CONNECT_TIMEOUT_MS = 10_000;
/** go2rtc 的 HTTP 信令不支持增量候选：等候选收集完再提交 offer，最多等此时长 */
const GATHER_MS = 2_000;
const NO_MEDIA = "无法取得画面：浏览器须能访问本机 8555 端口";

/**
 * 设备实时画面（FR-106）：信令经 api-server 转发，媒体流由 go2rtc 直达（D-02）。人体模糊为 [M1]。
 * 切换设备时由调用方以 key 重建组件。
 */
export function LiveVideo({ deviceId }: { deviceId: string }) {
  const [status, retry] = useLiveVideo(deviceId);
  const root = useRef<HTMLDivElement>(null);
  const video = useCallback(() => root.current?.querySelector("video") ?? null, []);
  // 画面上叠加该路的检测框与骨骼（FR-107）；无跟踪数据的摄像头叠加层不画任何东西
  return (
    <div ref={root}>
      <LiveVideoView status={status} onRetry={retry}>
        {status.kind === "playing" && <DetectionOverlay cameraId={deviceId} video={video} />}
      </LiveVideoView>
    </div>
  );
}

/** 建立并维护一路实时画面连接（监控墙瓦片与详情共用）；deviceId 变化时由调用方以 key 重建 */
export function useLiveVideo(deviceId: string): [VideoStatus, () => void] {
  const [status, setStatus] = useState<VideoStatus>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setStatus({ kind: "connecting" });
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    // 不配置 ICE 服务器：只用本机候选，不访问公网 STUN（G-05）
    const pc = new RTCPeerConnection({ iceServers: [] });
    let stream: MediaStream | null = null;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (reason: string) => {
      clearTimeout(timer);
      pc.close();
      if (active) setStatus({ kind: "unavailable", reason });
    };
    const update = () => {
      if (!active || !stream) return;
      if (pc.connectionState === "connected") {
        clearTimeout(timer);
        setStatus({ kind: "playing", stream });
      }
      if (pc.connectionState === "disconnected") setStatus({ kind: "interrupted", stream });
    };
    pc.ontrack = (e) => {
      stream = e.streams[0] ?? new MediaStream([e.track]);
      update();
    };
    pc.onconnectionstatechange = () => (pc.connectionState === "failed" ? fail(NO_MEDIA) : update());
    pc.addTransceiver("video", { direction: "recvonly" });
    negotiate(pc, deviceId, () => active)
      .catch(() => "浏览器无法建立 WebRTC 连接")
      .then((reason) => {
        if (!active) return;
        if (reason) fail(reason);
        else if (pc.connectionState !== "connected") timer = setTimeout(() => fail(NO_MEDIA), CONNECT_TIMEOUT_MS);
      });
    return () => {
      active = false;
      clearTimeout(timer);
      pc.close();
    };
  }, [deviceId, attempt]);
  return [status, retry];
}

/** 交换 SDP，失败时返回原因；组件已卸载时不再发起信令、不再设置 answer，避免 go2rtc 留下无人使用的会话 */
async function negotiate(pc: RTCPeerConnection, deviceId: string, active: () => boolean): Promise<string | null> {
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  if (!active()) return null;
  let answer: string;
  try {
    answer = await api.webrtc(deviceId, pc.localDescription?.sdp ?? "");
  } catch (e) {
    return e instanceof ApiError ? e.message : "无法连接 api-server";
  }
  if (!active()) return null;
  try {
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch {
    return "视频服务返回的应答无效";
  }
  return null;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve();
    setTimeout(resolve, GATHER_MS);
  });
}

/** 按状态呈现；与连接逻辑分开，供组件展示页截图（V-G3） */
export function LiveVideoView(props: { status: VideoStatus; onRetry?: () => void; className?: string; children?: ReactNode }) {
  const { status, onRetry, className, children } = props;
  return (
    <div data-video={status.kind} className={cn("relative aspect-video overflow-hidden rounded-md border border-border bg-secondary", className)}>
      {"stream" in status && <Stream stream={status.stream} />}
      {status.kind === "connecting" && (
        <Center>
          <Video aria-hidden className="size-5" />
          正在连接实时画面…
        </Center>
      )}
      {status.kind === "none" && <Center>该设备没有视频流</Center>}
      {status.kind === "unavailable" && (
        <Center>
          <span className="flex items-center gap-1.5 text-foreground">
            <VideoOff aria-hidden className="size-4" />
            实时画面不可用
          </span>
          <span className="px-4 text-center text-xs">{status.reason}</span>
          <button
            onClick={onRetry}
            className="mt-1 flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <RotateCw aria-hidden className="size-3.5" />
            重试
          </button>
        </Center>
      )}
      {status.kind === "interrupted" && (
        <p className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full border border-dashed border-uncertain bg-card/80 px-3 py-1 text-xs whitespace-nowrap text-uncertain backdrop-blur">
          <Clock aria-hidden className="size-3.5" />
          画面中断 · 正在重连
        </p>
      )}
      {children}
    </div>
  );
}

function Stream({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay muted playsInline aria-label="实时画面" className="size-full bg-black object-contain" />;
}

function Center({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-subtle-foreground">{children}</div>;
}
