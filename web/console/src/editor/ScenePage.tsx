import { ArrowLeft, ChevronDown, CircleAlert, Clock, House, Minus, Plus, RotateCw } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { SceneArea, Site } from "../lib/api";
import { formatTime } from "../panels/ConnectionStatus/ConnectionStatus";
import { ControlButton, useAnimate } from "../scene/CameraControls";
import { type Camera, useCameras } from "../scene/devices";
import { Boundary, Note, supportsWebGL2 } from "../scene/SceneViewport";
import { useConnection } from "../store/connection";
import type { EditorView } from "./view";

// three 体积较大，与态势页一样单独分包按需加载（C-FE-04）
const EditorCanvas = lazy(() => import("./EditorCanvas"));

/**
 * 场景页（设计 150 §6，FR-908），只对 admin 渲染入口（C-FE-07）：选择区域，在 3D 编辑视图中查看区域。
 * 区域数据取自站点（GET /api/site 与 WS site 频道），保存后各浏览器 5 s 内更新
 */
export function ScenePage({ site, onClose }: { site: Site; onClose: () => void }) {
  const [areaId, setAreaId] = useState<string | null>(null);
  const area = site.areas.find((a) => a.id === areaId) ?? site.areas[0] ?? null;
  const cameras = useCameras(site.devices, area?.id ?? null);

  return (
    <section aria-label="场景编辑" className="flex h-full flex-col text-sm">
      <header className="flex items-center gap-3 border-b bg-card px-4 py-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          <ArrowLeft aria-hidden />
          返回
        </Button>
        <h1 className="text-base font-semibold">场景</h1>
        {area && <AreaMenu areas={site.areas} current={area} onSelect={setAreaId} />}
      </header>
      <div className="relative min-h-0 flex-1">
        {area ? (
          <AreaView key={area.id} area={area} cameras={cameras} />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle className="text-base">还没有场景区域</EmptyTitle>
              <EmptyDescription>新建一个区域，再像搭地图一样摆放建筑、道路与家具。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  );
}

/** 区域切换（设计 150 §3）：列出全部区域及尺寸 */
function AreaMenu(props: { areas: SceneArea[]; current: SceneArea; onSelect: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={`区域：${props.current.name}`}>
          区域：{props.current.name}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuRadioGroup value={props.current.id} onValueChange={props.onSelect}>
          {props.areas.map((a) => (
            <DropdownMenuRadioItem key={a.id} value={a.id}>
              {a.name}
              <span className="ml-auto pl-3 text-xs text-subtle-foreground">
                {a.width_m}×{a.depth_m} m
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 区域的 3D 编辑视图：加载中 / 就绪 / 加载失败 / 不支持 WebGL2；断线时提示数据非实时（V-G3、V-U3）。
 * data-editor 标示当前状态，首帧绘制后为 ready
 */
function AreaView({ area, cameras }: { area: SceneArea; cameras: Camera[] }) {
  const [webgl2] = useState(supportsWebGL2);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<EditorView | null>(null);
  const offline = useConnection((s) => !s.open && !s.connecting);
  const lastFrameAt = useConnection((s) => s.lastFrameAt);
  if (!webgl2) return <Note>场景编辑需要支持 WebGL2 的浏览器</Note>;

  return (
    <div data-editor={state} className="absolute inset-0">
      <Boundary onError={() => setState("error")}>
        <Suspense fallback={null}>
          <EditorCanvas area={area} cameras={cameras} onView={setView} onReady={() => setState("ready")} />
        </Suspense>
      </Boundary>
      {state === "ready" && view && <ViewTools view={view} />}
      {state === "loading" && <Note>场景加载中…</Note>}
      {state === "error" && (
        <Note>
          <CircleAlert aria-hidden className="size-4" />
          场景加载失败
          <Button variant="outline" size="sm" className="pointer-events-auto rounded-full" onClick={() => location.reload()}>
            重新加载
          </Button>
        </Note>
      )}
      {offline && (
        <p className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-dashed border-uncertain bg-card/90 px-3 py-1.5 text-meta text-muted-foreground backdrop-blur-sm">
          <Clock aria-hidden className="size-4" />
          数据非实时 · 最后更新 {formatTime(lastFrameAt)}
        </p>
      )}
    </div>
  );
}

/** 视角控件（设计 150 §3）：缩小、放大、旋转 90°、返回总览，位于左下角，与态势页同一样式 */
function ViewTools({ view }: { view: EditorView }) {
  const animate = useAnimate();
  const tools: [string, typeof Plus, (v: EditorView) => void][] = [
    ["缩小", Minus, (v) => v.zoom(-1, animate())],
    ["放大", Plus, (v) => v.zoom(1, animate())],
    ["旋转 90°", RotateCw, (v) => v.rotate(animate())],
    ["返回总览", House, (v) => v.home(animate())],
  ];
  return (
    <div
      role="toolbar"
      aria-label="视角"
      className="absolute bottom-3 left-3 flex items-center rounded-lg border bg-card/90 p-1 text-meta text-muted-foreground backdrop-blur-sm"
    >
      {tools.map(([label, Icon, run]) => (
        <ControlButton key={label} label={label} disabled={false} onClick={() => run(view)}>
          <Icon aria-hidden className="size-4" />
        </ControlButton>
      ))}
    </div>
  );
}
