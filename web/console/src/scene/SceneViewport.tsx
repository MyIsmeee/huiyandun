import { CircleAlert } from "lucide-react";
import { Component, lazy, type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { Site } from "../lib/api";
import { FloorPlan2D } from "./FloorPlan2D";
import { isEmpty, isoView, planView, type Size, type View, zoneAnchor, zoneLabel } from "./layout";

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
  const iso = useMemo(() => (size && webgl2 ? isoView(site, size) : null), [site, size, webgl2]);
  const plan = useMemo(() => (size && !webgl2 ? planView(site, size) : null), [site, size, webgl2]);
  const view = iso ?? plan;
  const state = failed ? "error" : !webgl2 ? "2d" : ready ? "ready" : "loading";

  return (
    <div ref={ref} data-scene={state} className="absolute inset-0">
      {iso && (
        <Boundary onError={() => setFailed(true)}>
          <Suspense fallback={null}>
            <Scene3D site={site} view={iso} onReady={() => setReady(true)} />
          </Suspense>
        </Boundary>
      )}
      {plan && <FloorPlan2D site={site} view={plan} />}
      {view && (state === "ready" || state === "2d") && <ZoneLabels zones={site.zones} view={view} />}
      {state === "2d" && (
        <p className="absolute top-3 right-3 rounded-full border border-line bg-panel/80 px-3 py-1 text-sm text-fg-2 backdrop-blur">
          2D 平面视图 · 浏览器不支持 WebGL2
        </p>
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
