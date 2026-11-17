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
import { Button } from "../components/ui/button";
import type { Site } from "../lib/api";
import type { Area } from "./areas";
import { useConnection } from "../store/connection";
import { useLive } from "../store/live";
import { useNav } from "../store/nav";
import { select, selectTarget, useSelection } from "../store/selection";
import { adjustOrbit, adjustZoom, focusOn, moveCamera, orbited, panned, useCamera, useFocusShot, wheelZoomed } from "./camera";
import { useSceneMode } from "./Backdrop";
import { CameraControls, useAnimate } from "./CameraControls";
import { AttackLines } from "./AttackLines";
import { CALLOUT, CameraCallout } from "./CameraCallout";
import { DevicePicker } from "./DevicePicker";
import { DeviceTags } from "./DeviceTags";
import type { SceneItem } from "./assets";
import { useAutoScene } from "./autoScene";
import { useCameras } from "./devices";
import { bounds, OVERVIEW, overviewShot, planView, type SceneView, type Size, sceneView, type View } from "./layout";
import { Scene2D } from "./Scene2D";
import { HoverMarker, TargetMarker } from "./TargetMarker";
import { renderedPosition } from "./smoothing";
import { pickTarget, visibleTargets } from "./targets";

/** 还没有任何区域时的取景范围，单位米 */
const NO_AREA = { width_m: 20, depth_m: 20 };
const NO_ITEMS: SceneItem[] = [];

/** 场景上自带交互的浮层：按钮、视角控件与画面引线卡。落在其上的指针事件不算作对场景的点选、跟随、悬停与拖拽 */
const CHROME = `button, [role=toolbar], ${CALLOUT}`;
/** 打开中的弹层（Radix 的对话框、菜单、下拉与浮层）：Esc 先由它们关闭 */
const POPUPS = "[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]";
const onChrome = (target: EventTarget | null) => target instanceof Element && target.closest(CHROME) !== null;

/**
 * Esc 是否由场景处理（回到总览）：有弹层打开时让弹层先关；被管理页盖住时场景不可见，同样不处理。
 * 管理页盖在态势页之上而不卸载它（Shell），窗口级的监听仍会收到按键
 */
export function sceneHandlesEscape(): boolean {
  const { page } = useNav.getState();
  return (page === "overview" || page === "wall") && document.querySelector(POPUPS) === null;
}

// three 体积较大，单独分包按需加载，不拖慢登录页与首屏（C-FE-04）
const Scene3D = lazy(() => import("./Scene3D"));

export function supportsWebGL2(): boolean {
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
export class Boundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
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
 * 场景视口（ui.md）：加载 / 空区域 / 加载失败 / 无 WebGL2 降级 2D。onBuild 只对 admin 传入：空区域提示旁的"去搭建"打开场景页。
 * data-scene 标示当前状态，3D 场景首帧绘制后为 ready。
 */
export function SceneViewport({ site, scene, onBuild }: { site: Site; scene: Area | null; onBuild?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const [webgl2] = useState(supportsWebGL2);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const pose = useCamera((s) => s.pose);
  const cameras = useCameras(site.devices, scene?.id ?? null);
  // 区域没有手工搭建的物体时，按画面自动识别的结果显示（autoScene.ts）
  const autoScene = useAutoScene(scene, site.devices);
  const auto = autoScene?.items ?? null;
  const items = scene?.items.length ? scene.items : (auto ?? NO_ITEMS);
  const measured = scene?.items.length ? null : (autoScene?.frames ?? null);
  // 实景底图：自动识别的场景带有底图时可切换为实景，默认白模（Backdrop.tsx）
  const hasBackdrop = measured?.some((f) => f.backdrop) ?? false;
  const mode = useSceneMode((s) => s.mode);
  const photo = hasBackdrop && mode === "photo";
  // 总览按区域尺寸取景（设计 150 §9）；目标与告警不影响取景
  const [width, depth] = [scene?.width_m ?? NO_AREA.width_m, scene?.depth_m ?? NO_AREA.depth_m];
  const area = useMemo(() => bounds({ width_m: width, depth_m: depth }), [width, depth]);
  const animate = useAnimate();
  const overviewed = useMemo(() => (size && webgl2 ? overviewShot(area, size, pose) : null), [area, size, webgl2, pose]);
  const shot = useFocusShot(overviewed?.shot ?? null, size, cameras, animate());
  const view3d = useMemo(
    () => (size && shot && overviewed ? sceneView(shot, size, overviewed.panLimit) : null),
    [size, shot, overviewed],
  );
  const plan = useMemo(() => (size && !webgl2 ? planView(area, size, pose) : null), [area, size, webgl2, pose]);
  const view = view3d ?? plan;
  const state = failed ? "error" : !webgl2 ? "2d" : ready ? "ready" : "loading";
  const { dragged, ...drag } = useDragView(view);
  useWheelZoom(ref, view);
  // 每次进入主界面、切换区域都从总览开始
  useEffect(() => {
    focusOn(null, false);
    moveCamera(OVERVIEW, false);
  }, [scene?.id]);
  // 断线时所有动效立即停止（V-U3、C-FE-05）：进行中的转场直接到位
  const offline = useConnection((s) => !s.open && !s.connecting);
  useEffect(() => {
    if (!offline) return;
    const { goal, focus } = useCamera.getState();
    moveCamera(goal, false);
    // 飞行直接到位：跟随中按最新实测位置取景，飞回总览则直接按总览姿态取景
    useCamera.setState(focus ? { flight: null } : { flight: null, shot: null });
  }, [offline]);

  // Esc：处于跟随视角时先回到总览，详情保留；再按一次由详情面板收起（V-I2、D-048）。捕获阶段先于详情面板处理；
  // 有弹层打开或被管理页盖住时不处理，也不 preventDefault（Radix 弹层见到已阻止默认行为的 Esc 不会关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !useCamera.getState().focus || !sceneHandlesEscape()) return;
      e.preventDefault();
      focusOn(null, animate());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [animate]);

  // 只在 e2e 构建中提供：目标（模型中部）当前的场景内像素位置，用例据此点选，不随机位调整失效
  useEffect(() => {
    if (import.meta.env.MODE !== "e2e" || !view3d) return;
    window.__hydTargetAt = (key) => {
      const target = useLive.getState().targets[key];
      if (!target) return null;
      const [x, y] = renderedPosition(key, target, Date.now(), true);
      return view3d.project([x, 0.9, y]);
    };
    return () => {
      delete window.__hydTargetAt;
    };
  }, [view3d]);

  /** 指针下的人员或车辆：按渲染中的位置命中。2D 降级视图只显示目标位置，不支持点选 */
  const hit = (e: MouseEvent<HTMLDivElement>) => {
    if (!view3d || onChrome(e.target)) return null;
    const { targets, behaviors } = useLive.getState();
    const box = e.currentTarget.getBoundingClientRect();
    const point = [e.clientX - box.left, e.clientY - box.top] as const;
    const now = Date.now();
    // 与 TargetModels 同一渲染时刻：降低动效时模型画在最新实测位置，命中也按最新位置
    const motion = animate();
    return pickTarget(visibleTargets(targets, cameras, behaviors), view3d, point, (target) =>
      renderedPosition(target.key, target, now, motion),
    );
  };
  // 单击：选中并展开详情，镜头不动（V-I2、D-054）；单击空白处取消选中并收起详情（D-058）。双击：飞入跟随视角（V-I1）
  const pick = (e: MouseEvent<HTMLDivElement>) => {
    if (dragged.current || onChrome(e.target)) return;
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
            <Scene3D area={area} items={items} measured={measured} photo={photo} cameras={cameras} view={view3d} onReady={() => setReady(true)} />
          </Suspense>
        </Boundary>
      )}
      {plan && (
        <Boundary onError={() => setFailed(true)}>
          <Suspense fallback={null}>
            <Scene2D items={items} cameras={cameras} view={plan} area={area} />
          </Suspense>
        </Boundary>
      )}
      {view && (state === "ready" || state === "2d") && (
        <>
          <AttackLines area={area} cameras={cameras} view={view} />
          <DeviceTags cameras={cameras} view={view} />
          <DevicePicker
            cameras={cameras}
            view={view}
            onFocus={view3d ? (id) => focusOn({ kind: "camera", id }, animate()) : undefined}
          />
          {view3d && <TargetMarker />}
          {view3d && <HoverMarker />}
          {view3d && <CameraCallout cameras={cameras} view={view3d} />}
        </>
      )}
      {(state === "ready" || state === "2d") && measured !== null && measured.length > 0 && (
        <p className="floating-card pointer-events-none absolute top-36 left-4 px-3 py-2 text-xs text-muted-foreground">
          场景由画面自动识别，每 10 分钟更新
        </p>
      )}
      {(state === "ready" || state === "2d") && !items.length && !measured?.length && (
        // 不自动补全场景（设计 150 §4）：只显示摄像头与视场，并说明尚未搭建。一行小字提示，不做成醒目的大卡片：
        // 区域边线已标出范围，这里只提醒并给 admin 入口（产品负责人 2026-11-15 要求收敛）
        <p className="floating-card pointer-events-none absolute top-36 left-4 flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground">
          {scene ? "该区域还没有搭建场景" : "还没有场景区域"}
          {onBuild && (
            <Button size="sm" variant="outline" className="pointer-events-auto h-7" onClick={onBuild}>
              去搭建
            </Button>
          )}
        </p>
      )}
      {(state === "ready" || state === "2d") && (
        <CameraControls photo={hasBackdrop} />
      )}
      {state === "loading" && <Note>场景加载中…</Note>}
      {state === "error" && (
        <Note>
          <CircleAlert aria-hidden className="size-4" />
          场景加载失败
          <button
            onClick={() => location.reload()}
            className="pointer-events-auto h-8 rounded-full border border-border px-3 transition-colors hover:bg-secondary"
          >
            重新加载
          </button>
        </Note>
      )}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="pointer-events-none absolute inset-0 m-auto flex h-fit items-center justify-center gap-2 text-sm text-subtle-foreground">
      {children}
    </p>
  );
}

/**
 * 鼠标拖拽（V-I1）：总览下左键平移（缩到最小时没有可平移的余地）、右键或 Shift + 左键旋转（左右改方位、上下改俯角）；
 * 跟随视角下拖动绕目标转动、上下改仰角；摄像头视角由摄像头决定，不响应。拖拽即时生效，并打断进行中的转场。
 * dragged：本次按下后发生过移动，松开时的单击不选中目标
 */
function useDragView(view: View | null) {
  const last = useRef<readonly [number, number] | null>(null);
  const mode = useRef<"pan" | "orbit" | "follow">("pan");
  const dragged = useRef(false);
  const zoomedIn = useCamera((s) => s.goal.zoom > OVERVIEW.zoom && !s.focus);
  const following = useCamera((s) => s.focus?.kind === "target");
  const end = () => {
    last.current = null;
  };
  return {
    dragged,
    className: zoomedIn || following ? "absolute inset-0 cursor-grab active:cursor-grabbing" : "absolute inset-0",
    onContextMenu: (e: MouseEvent) => {
      if (!onChrome(e.target)) e.preventDefault(); // 右键拖动用于旋转
    },
    onPointerDown: (e: PointerEvent) => {
      dragged.current = false;
      if (onChrome(e.target) || (e.button !== 0 && e.button !== 2)) return;
      const { focus } = useCamera.getState();
      if (focus?.kind === "camera") return;
      mode.current = focus ? "follow" : e.button === 2 || e.shiftKey ? "orbit" : "pan";
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = [e.clientX, e.clientY];
    },
    onPointerMove: (e: PointerEvent) => {
      if (!last.current || !view) return;
      const delta = [e.clientX - last.current[0], e.clientY - last.current[1]] as const;
      last.current = [e.clientX, e.clientY];
      dragged.current ||= delta[0] !== 0 || delta[1] !== 0;
      const { goal, adjust } = useCamera.getState();
      if (mode.current === "follow") useCamera.setState({ adjust: adjustOrbit(adjust, delta) });
      else if (mode.current === "orbit") moveCamera(orbited(goal, delta), false);
      else moveCamera(panned(goal, delta, view.zoom, view.panLimit), false);
    },
    // 浏览器取消手势（如触屏滚动）时同样结束拖拽，否则松开后指针移动仍会平移
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };
}

/**
 * 滚轮缩放：总览下以光标为中心连续缩放（ZOOM_MIN～ZOOM_MAX），跟随视角下拉近推远，摄像头视角下收窄、放宽视场。
 * 落在浮层（按钮、视角控件、引线卡）上的滚动不处理。原生监听、非被动：React 的 onWheel 是被动监听，阻止不了页面滚动
 */
function useWheelZoom(ref: RefObject<HTMLDivElement | null>, view: View | null) {
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  }, [view]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      const current = latest.current;
      if (!current || onChrome(e.target) || e.deltaY === 0) return;
      e.preventDefault();
      // 按行、按页滚动的设备折算为像素
      const deltaY = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? element.clientHeight : 1);
      const { goal, focus, adjust } = useCamera.getState();
      if (focus) {
        useCamera.setState({ adjust: adjustZoom(adjust, deltaY) });
        return;
      }
      const box = element.getBoundingClientRect();
      const center = "shot" in current ? (current as SceneView).shot.center : [box.width / 2, box.height / 2];
      const offset = [e.clientX - box.left - (center[0] ?? 0), e.clientY - box.top - (center[1] ?? 0)] as const;
      moveCamera(wheelZoomed(goal, deltaY, offset, current.zoom, current.panLimit), false);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [ref]);
}

declare global {
  interface Window {
    /** e2e 构建专用（见 SceneViewport） */
    __hydTargetAt?: (key: string) => readonly [number, number] | null;
    /** e2e 构建专用（见 Scene3D） */
    __hydDrawCalls?: () => number;
  }
}
