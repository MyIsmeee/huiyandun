import { CircleAlert } from "lucide-react";
import {
  Component,
  lazy,
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
import { moveCamera, panned, useCamera } from "./camera";
import { CameraControls } from "./CameraControls";
import { FloorPlan2D } from "./FloorPlan2D";
import { isEmpty, isoView, OVERVIEW, planView, type Size, type View, zoneAnchor, zoneLabel } from "./layout";

// 降级说明须简短：1366 宽下与 KPI 底板同处顶部一行（V-P3）
const DEGRADED = { text: "2D 视图 · 不支持 WebGL2", title: "浏览器不支持 WebGL2，已降级为 2D 平面视图（C-FE-08）" };

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
  const iso = useMemo(() => (size && webgl2 ? isoView(site, size, pose) : null), [site, size, webgl2, pose]);
  const plan = useMemo(() => (size && !webgl2 ? planView(site, size, pose) : null), [site, size, webgl2, pose]);
  const view = iso ?? plan;
  const state = failed ? "error" : !webgl2 ? "2d" : ready ? "ready" : "loading";
  const drag = useDragPan(view);
  useEffect(() => moveCamera(OVERVIEW, false), []); // 每次进入主界面从总览开始

  return (
    <div ref={ref} data-scene={state} {...drag}>
      {iso && (
        <Boundary onError={() => setFailed(true)}>
          <Suspense fallback={null}>
            <Scene3D site={site} view={iso} onReady={() => setReady(true)} />
          </Suspense>
        </Boundary>
      )}
      {plan && <FloorPlan2D site={site} view={plan} />}
      {view && (state === "ready" || state === "2d") && <ZoneLabels zones={site.zones} view={view} />}
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
      {state !== "loading" && state !== "error" && isEmpty(site) && <Note>平面图中没有墙体与区域</Note>}
    </div>
  );
}

function ZoneLabels({ zones, view }: { zones: Site["zones"]; view: View }) {
  return zones.map((zone) => {
    const [left, top] = view.project(zoneAnchor(zone.polygon));
    return (
      <span
        key={zone.id}
        style={{ left, top }}
        className="pointer-events-none absolute -translate-1/2 rounded-full border border-line bg-panel/80 px-2 py-0.5 text-xs whitespace-nowrap text-fg-2"
      >
        {zoneLabel(zone)}
      </span>
    );
  });
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="pointer-events-none absolute inset-0 m-auto flex h-fit items-center justify-center gap-2 text-sm text-fg-3">
      {children}
    </p>
  );
}

/** 放大后拖拽平移（V-I1）：总览倍数下不响应；拖拽即时生效，并打断进行中的转场 */
function useDragPan(view: View | null) {
  const last = useRef<readonly [number, number] | null>(null);
  const zoomedIn = useCamera((s) => s.goal.zoom > OVERVIEW.zoom);
  return {
    className: zoomedIn ? "absolute inset-0 cursor-grab active:cursor-grabbing" : "absolute inset-0",
    onPointerDown: (e: PointerEvent) => {
      if (!zoomedIn || e.button !== 0 || (e.target as Element).closest("button")) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = [e.clientX, e.clientY];
    },
    onPointerMove: (e: PointerEvent) => {
      if (!last.current || !view) return;
      const delta = [e.clientX - last.current[0], e.clientY - last.current[1]] as const;
      last.current = [e.clientX, e.clientY];
      moveCamera(panned(useCamera.getState().goal, delta, view.zoom, view.panLimit), false);
    },
    onPointerUp: () => {
      last.current = null;
    },
  };
}
