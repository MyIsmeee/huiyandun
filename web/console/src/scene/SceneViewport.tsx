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
import { select, selectTarget, useSelection } from "../store/selection";
import { focusOn, moveCamera, panned, useCamera, useFocusShot } from "./camera";
import { CameraControls, useAnimate } from "./CameraControls";
import { AttackLines } from "./AttackLines";
import { DevicePicker } from "./DevicePicker";
import { DeviceTags } from "./DeviceTags";
import { useCameras } from "./devices";
import { OVERVIEW, overviewShot, planView, type Size, sceneView, type View } from "./layout";
import { Scene2D } from "./Scene2D";
import { HoverMarker, TargetMarker } from "./TargetMarker";
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
  const animate = useAnimate();
  const overviewed = useMemo(() => (size && webgl2 ? overviewShot(site, size, pose) : null), [site, size, webgl2, pose]);
  const shot = useFocusShot(overviewed?.shot ?? null, size, cameras, animate());
  const view3d = useMemo(
    () => (size && shot && overviewed ? sceneView(shot, size, overviewed.panLimit) : null),
    [size, shot, overviewed],
  );
  const plan = useMemo(() => (size && !webgl2 ? planView(site, size, pose) : null), [site, size, webgl2, pose]);
  const view = view3d ?? plan;
  const state = failed ? "error" : !webgl2 ? "2d" : ready ? "ready" : "loading";
  const { dragged, ...drag } = useDragPan(view);
  // 每次进入主界面从总览开始
  useEffect(() => {
    focusOn(null, false);
    moveCamera(OVERVIEW, false);
  }, []);
  // 断线时所有动效立即停止（V-U3、C-FE-05）：进行中的转场直接到位
  const offline = useConnection((s) => !s.open && !s.connecting);
  useEffect(() => {
    if (!offline) return;
    const { goal, focus } = useCamera.getState();
    moveCamera(goal, false);
    // 飞行直接到位：跟随中按最新实测位置取景，飞回总览则直接按总览姿态取景
    useCamera.setState(focus ? { flight: null } : { flight: null, shot: null });
  }, [offline]);

  // Esc：处于跟随视角时先回到总览，详情保留；再按一次由详情面板收起（V-I2、D-048）。捕获阶段先于详情面板处理
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !useCamera.getState().focus) return;
      e.preventDefault();
      focusOn(null, animate());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [animate]);

  /** 指针下的人员或车辆：按渲染中的位置命中。2D 降级视图不绘制目标 */
  const hit = (e: MouseEvent<HTMLDivElement>) => {
    if (!view3d || (e.target as Element).closest("button")) return null;
    const { targets, behaviors } = useLive.getState();
    const box = e.currentTarget.getBoundingClientRect();
    const point = [e.clientX - box.left, e.clientY - box.top] as const;
    return pickTarget(visibleTargets(targets, cameras, behaviors), view3d, point, Date.now() - RENDER_DELAY_MS);
  };
  // 单击：选中并展开详情，镜头不动（V-I2、D-054）；单击空白处取消选中并收起详情（D-058）。双击：飞入跟随视角（V-I1）
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    if (dragged.current || (e.target as Element).closest("button, [role=toolbar]")) return;
    const key = hit(e);
    if (key) selectTarget(key);
    else select(null);
  };
  // 悬停：人员与车辆显示中性灰四角括框、指针变为手形（V-I4）
  // 悬停的目标离开画面即恢复指针，不必等鼠标再动
  const hoveredKey = useSelection((s) => s.hoveredKey);
  const hovering = useLive((s) => hoveredKey !== null && hoveredKey in s.targets);
  const hover = (key: string | null) => {
    if (key !== useSelection.getState().hoveredKey) useSelection.setState({ hoveredKey: key });
  };
  const follow = (e: MouseEvent<HTMLDivElement>) => {
    const key = dragged.current ? null : hit(e);
    if (!key) return;
    selectTarget(key);
    focusOn({ kind: "target", key }, animate());
  };

  return (
    <div
      ref={ref}
      data-scene={state}
      {...drag}
      style={hovering ? { cursor: "pointer" } : undefined}
      onClick={pick}
      onDoubleClick={follow}
      onMouseMove={(e) => hover(e.buttons === 0 ? hit(e) : null)}
      onMouseLeave={() => hover(null)}
    >
      {view3d && (
        <Boundary onError={() => setFailed(true)}>
          <Suspense fallback={null}>
            <Scene3D site={site} cameras={cameras} view={view3d} onReady={() => setReady(true)} />
          </Suspense>
        </Boundary>
      )}
      {plan && <Scene2D site={site} cameras={cameras} view={plan} />}
      {view && (state === "ready" || state === "2d") && (
        <>
          <AttackLines site={site} cameras={cameras} view={view} />
          <DeviceTags cameras={cameras} view={view} />
          <DevicePicker
            cameras={cameras}
            view={view}
            onFocus={view3d ? (id) => focusOn({ kind: "camera", id }, animate()) : undefined}
          />
          {view3d && <TargetMarker />}
          {view3d && <HoverMarker />}
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

/** 放大后拖拽平移（V-I1）：总览倍数下、跟随视角下不响应；拖拽即时生效，并打断进行中的转场。dragged：本次按下后发生过平移，松开时的单击不选中目标 */
function useDragPan(view: View | null) {
  const last = useRef<readonly [number, number] | null>(null);
  const dragged = useRef(false);
  // 跟随视角下机位由目标或摄像头决定，不响应拖拽（D-058）
  const zoomedIn = useCamera((s) => s.goal.zoom > OVERVIEW.zoom && !s.focus);
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
