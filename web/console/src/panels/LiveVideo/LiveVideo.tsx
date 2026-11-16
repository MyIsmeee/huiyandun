import { Clock, RotateCw, Video, VideoOff } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApiError, api } from "../../lib/api";
import { DetectionOverlay } from "../DetectionOverlay/DetectionOverlay";

/** 连接中 / 播放 / 媒体中断（保留最后画面，等待恢复）/ 不可用 / 设备没有视频流（ui.md） */
export type VideoStatus =
  | { kind: "connecting" }
  | { kind: "playing"; stream: MediaStream }
  | { kind: "interrupted"; stream: MediaStream }
  | { kind: "unavailable"; reason: string; retrying?: boolean }
  | { kind: "none" };

/** 取得 answer 后超过此时长仍未取得画面即判为不可用；信令本身的超时由 api 客户端负责 */
const CONNECT_TIMEOUT_MS = 10_000;
/** 媒体中断（disconnected）超过此时长仍未自行恢复即重建连接，不等浏览器判为 failed（约 30 s） */
const INTERRUPT_MS = 10_000;
/** 不可用后自动重试：5 s 起倍增，上限 60 s；页面隐藏时暂停，回到前台再连（无人值守的监控墙须能自愈） */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** go2rtc 的 HTTP 信令不支持增量候选：等候选收集完再提交 offer，最多等此时长 */
const GATHER_MS = 2_000;
const NO_MEDIA = "无法取得画面：浏览器须能访问本机 8555 端口";
/** 曾经播放过的连接失败：网络或视频服务中断，端口说明不适用 */
const LOST = "连接中断，正在自动重连";

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

/**
 * 建立并维护一路实时画面连接（监控墙瓦片与详情共用）；deviceId 变化时由调用方以 key 重建。
 * 不可用时按退避自动重试，手动"重试"立即重连并重置退避
 */
export function useLiveVideo(deviceId: string): [VideoStatus, () => void] {
  const [status, setStatus] = useState<VideoStatus>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);
  /** 连续失败次数：决定下次自动重试的间隔，连通后清零 */
  const failures = useRef(0);
  /** 本组件内是否播放过：失败时据此区分"连接中断"与"从未连上" */
  const played = useRef(false);
  const reconnect = useCallback(() => {
    setStatus({ kind: "connecting" });
    setAttempt((n) => n + 1);
  }, []);
  const retry = () => {
    failures.current = 0;
    reconnect();
  };
  useEffect(() => {
    // 不配置 ICE 服务器：只用本机候选，不访问公网 STUN（G-05）
    const pc = new RTCPeerConnection({ iceServers: [] });
    let stream: MediaStream | null = null;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupt: ReturnType<typeof setTimeout> | undefined;
    let again: ReturnType<typeof setTimeout> | undefined;
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      reconnect();
    };
    const fail = (reason: string) => {
      clearTimeout(timer);
      clearTimeout(interrupt);
      pc.close();
      if (!active) return;
      setStatus({ kind: "unavailable", reason: played.current ? LOST : reason, retrying: true });
      failures.current += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (failures.current - 1));
      again = setTimeout(() => {
        if (!document.hidden) reconnect();
        else document.addEventListener("visibilitychange", onVisible);
      }, delay);
    };
    const update = () => {
      if (!active || !stream) return;
      if (pc.connectionState === "connected") {
        clearTimeout(timer);
        clearTimeout(interrupt);
        interrupt = undefined;
        failures.current = 0;
        played.current = true;
        setStatus({ kind: "playing", stream });
      }
      if (pc.connectionState === "disconnected") {
        setStatus({ kind: "interrupted", stream });
        interrupt ??= setTimeout(() => fail(LOST), INTERRUPT_MS);
      }
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
      clearTimeout(interrupt);
      clearTimeout(again);
      document.removeEventListener("visibilitychange", onVisible);
      pc.close();
    };
  }, [deviceId, attempt, reconnect]);
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
/** dark：画面底色为黑（监控墙瓦片），状态文字改用浅色，否则深色字落在黑底上看不清 */
export function LiveVideoView(props: { status: VideoStatus; onRetry?: () => void; className?: string; dark?: boolean; children?: ReactNode }) {
  const { status, onRetry, className, dark = false, children } = props;
  return (
    <div data-video={status.kind} className={cn("relative aspect-video overflow-hidden rounded-md border border-border bg-secondary", className)}>
      {"stream" in status && <Stream stream={status.stream} />}
      {status.kind === "connecting" && (
        <Center dark={dark}>
          <Video aria-hidden className="size-5" />
          正在连接实时画面…
        </Center>
      )}
      {status.kind === "none" && <Center dark={dark}>该设备没有视频流</Center>}
      {status.kind === "unavailable" && (
        <Center dark={dark}>
          <span className={cn("flex items-center gap-1.5 font-medium", dark ? "text-white" : "text-foreground")}>
            <VideoOff aria-hidden className="size-4" />
            实时画面不可用
          </span>
          <span className="px-4 text-center text-xs">{status.reason}</span>
          {status.retrying && <span className="text-xs">稍后自动重试</span>}
          {/* 按钮底色为浅色：文字色写明，不继承黑底瓦片上的浅色字 */}
          <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 text-foreground">
            <RotateCw aria-hidden />
            重试
          </Button>
        </Center>
      )}
      {status.kind === "interrupted" && (
        <p className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full border border-dashed border-uncertain bg-card/80 px-3 py-1 text-xs whitespace-nowrap text-muted-foreground backdrop-blur">
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

function Center({ children, dark }: { children: ReactNode; dark: boolean }) {
  return (
    <div className={cn("absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm", dark ? "text-white/70" : "text-subtle-foreground")}>
      {children}
    </div>
  );
}
