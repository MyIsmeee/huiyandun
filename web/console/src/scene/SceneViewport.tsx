import { CircleAlert } from "lucide-react";
import {
  Component,
  lazy,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Site } from "../lib/api";
import { useConnection } from "../store/connection";
import { useLive } from "../store/live";
import { selectTarget } from "../store/selection";
import { moveCamera, panned, useCamera } from "./camera";
import { CameraControls } from "./CameraControls";
import { DevicePicker } from "./DevicePicker";
import { DeviceTags } from "./DeviceTags";
import { useCameras } from "./devices";
import { isoView, OVERVIEW, planView, type Size, type View } from "./layout";
import { Scene2D } from "./Scene2D";
import { TargetMarker } from "./TargetMarker";
import { pickTarget, RENDER_DELAY_MS, visibleTargets } from "./targets";

// 降级说明须简短：1366 宽下与 KPI 底板同处顶部一行（V-P3）
const DEGRADED = { text: "2D 视图 · 不支持 WebGL2", title: "浏览器不支持 WebGL2，已降级为 2D 俯视视图（C-FE-08）" };

// three 体积较大，单独分包按需加载，不拖慢登录页与首屏（C-FE-04）
const Scene3D = lazy(() => import("./Scene3D"));

function supportsWebGL2(): boolean {
  const gl = document.createElement("canvas").getContext("webgl2");
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return gl !== null;
}

function useSize(ref: RefObject<HTMLElement | null>): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** 场景代码加载或 WebGL 初始化失败时显示"加载失败" */
class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * 场景视口（HYD-UIX-004 §8）：加载 / 空场景 / 加载失败 / 无 WebGL2 降级 2D。
 * data-scene 标示当前状态，3D 场景首帧绘制后为 ready。
 */
export function SceneViewport({ site }: { site: Site }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const [webgl2] = useState(supportsWebGL2);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const pose = useCamera((s) => s.pose);
  const cameras = useCameras(site.devices);
  const iso = useMemo(() => (size && webgl2 ? isoView(site, size, pose) : null), [site, size, webgl2, pose]);
  const plan = useMemo(() => (size && !webgl2 ? planView(site, size, pose) : null), [site, size, webgl2, pose]);
  const view = iso ?? plan;
  const state = failed ? "error" : !webgl2 ? "2d" : ready ? "ready" : "loading";
  const { dragged, ...drag } = useDragPan(view);
  useEffect(() => moveCamera(OVERVIEW, false), []); // 每次进入主界面从总览开始
  // 断线时所有动效立即停止（V-U3、C-FE-05）：进行中的转场直接到位
  const offline = useConnection((s) => !s.open && !s.connecting);
  useEffect(() => {
    if (offline) moveCamera(useCamera.getState().goal, false);
  }, [offline]);

  // 单击人员或车辆：选中并展开详情，镜头不动（V-I2、D-054）；按渲染中的位置命中。2D 降级视图不绘制目标
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    if (!iso || dragged.current || (e.target as Element).closest("button")) return;
    const { targets, behaviors } = useLive.getState();
    const box = e.currentTarget.getBoundingClientRect();
    const point = [e.clientX - box.left, e.clientY - box.top] as const;
    const key = pickTarget(visibleTargets(targets, cameras, behaviors), iso, point, Date.now() - RENDER_DELAY_MS);
    if (key) selectTarget(key);
  };

  return (
    <div ref={ref} data-scene={state} {...drag} onClick={pick}>
      {iso && (
        <Boundary onError={() => setFailed(true)}>
          <Suspense fallback={null}>
            <Scene3D site={site} cameras={cameras} view={iso} onReady={() => setReady(true)} />
          </Suspense>
        </Boundary>
      )}
      {plan && <Scene2D site={site} cameras={cameras} view={plan} />}
      {view && (state === "ready" || state === "2d") && (
        <>
          <DeviceTags cameras={cameras} view={view} />
          <DevicePicker cameras={cameras} view={view} />
          {iso && <TargetMarker />}
        </>
      )}
      {(state === "ready" || state === "2d") && (
        <CameraControls notice={state === "2d" ? DEGRADED : undefined} />
      )}
      {state === "loading" && <Note>场景加载中…</Note>}
      {state === "error" && (
        <Note>
          <CircleAlert aria-hidden className="size-4" />
          场景加载失败
          <button
            onClick={() => location.reload()}
            className="pointer-events-auto h-8 rounded-full border border-line px-3 transition-colors hover:bg-raised"
          >
            重新加载
          </button>
        </Note>
      )}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="pointer-events-none absolute inset-0 m-auto flex h-fit items-center justify-center gap-2 text-sm text-fg-3">
      {children}
    </p>
  );
}

/** 放大后拖拽平移（V-I1）：总览倍数下不响应；拖拽即时生效，并打断进行中的转场。dragged：本次按下后发生过平移，松开时的单击不选中目标 */
function useDragPan(view: View | null) {
  const last = useRef<readonly [number, number] | null>(null);
  const dragged = useRef(false);
  const zoomedIn = useCamera((s) => s.goal.zoom > OVERVIEW.zoom);
  const end = () => {
    last.current = null;
  };
  return {
    dragged,
    className: zoomedIn ? "absolute inset-0 cursor-grab active:cursor-grabbing" : "absolute inset-0",
    onPointerDown: (e: PointerEvent) => {
      dragged.current = false;
      if (!zoomedIn || e.button !== 0 || (e.target as Element).closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = [e.clientX, e.clientY];
    },
    onPointerMove: (e: PointerEvent) => {
      if (!last.current || !view) return;
      const delta = [e.clientX - last.current[0], e.clientY - last.current[1]] as const;
      last.current = [e.clientX, e.clientY];
      dragged.current ||= delta[0] !== 0 || delta[1] !== 0;
      moveCamera(panned(useCamera.getState().goal, delta, view.zoom, view.panLimit), false);
    },
    // 浏览器取消手势（如触屏滚动）时同样结束拖拽，否则松开后指针移动仍会平移
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
}
