import { CircleAlert, Clock, LogOut, MapPin, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScenePage } from "../../editor/ScenePage";
import { api, type Site } from "../../lib/api";
import { SceneViewport } from "../../scene/SceneViewport";
import { connect, useConnection } from "../../store/connection";
import { applySite, useLive } from "../../store/live";
import { select, useSelection } from "../../store/selection";
import { canManageProviders, useSession } from "../../store/session";
import { AlertList } from "../AlertList/AlertList";
import { CameraPage } from "../CameraList/CameraList";
import { CameraRail } from "../CameraRail/CameraRail";
import { CanvasToolbar } from "../CanvasToolbar/CanvasToolbar";
import { ConnectionStatus, formatTime } from "../ConnectionStatus/ConnectionStatus";
import { DetailPanel, TargetPanel } from "../DetailPanel/DetailPanel";
import { LlmStatusBadge } from "../LlmStatusBadge/LlmStatusBadge";
import { ProviderPage } from "../ProviderList/ProviderList";
import { ThemeToggle } from "../ThemeToggle/ThemeToggle";
import { VideoWall } from "../VideoWall/VideoWall";
import { WallControls } from "../VideoWall/WallControls";
import { useWall } from "../../store/wall";

const deselect = () => select(null);

/** 顶栏导航的页面（D-106）：管理页盖在态势之上，场景与推送不中断 */
type Page = "overview" | "cameras" | "scene" | "providers";

/**
 * 主界面分区（ui.md §4、D-115）：位置固定、不可拖拽（V-L1）；主画布面积最大（V-L2），其上不叠加面板（V-L3）。
 * D 检查栏未选中时为告警栏，选中设备或目标时切换为详情；告警栏只隐藏不卸载，返回时筛选、展开与滚动位置不丢失。
 * onLogout 完成后若仍渲染本页，说明会话仍有效、退出未成功。
 * 进入即连接 WS；连接被拒时调用 onRejected 核对会话。
 */
export function Shell(props: { site: Site; onLogout: () => Promise<void>; onRejected: () => void }) {
  const { onLogout, onRejected } = props;
  // 摄像头登记表变化后以推送的站点为准（D-101）
  const site = useLive((s) => s.site) ?? props.site;
  const [logout, setLogout] = useState<"idle" | "pending" | "failed">("idle");
  const [page, setPage] = useState<Page>("overview");
  const admin = canManageProviders(useSession((s) => s.role));
  const { open, connecting, lastFrameAt } = useConnection();
  const offline = !open && !connecting;
  useEffect(() => connect(onRejected), [onRejected]);
  // 断线期间摄像头登记表可能变化（site 频道不补推）：连接建立后重新读取站点
  useEffect(() => {
    if (open) api.getSite().then(applySite, () => undefined);
  }, [open]);
  // 设备状态以推送为准，未推送过的取 GET /api/site 的初始值
  const selectedId = useSelection((s) => s.deviceId);
  const pushed = useLive((s) => (selectedId ? s.devices[selectedId] : undefined));
  const selected = pushed ?? site.devices.find((d) => d.id === selectedId);
  const targetKey = useSelection((s) => s.targetKey);
  const canvas = useRef<HTMLElement>(null);
  const view = useWall((s) => s.view);
  const cameraCount = site.devices.filter((d) => d.camera).length;
  const target = useLive((s) => (targetKey ? s.targets[targetKey] : undefined));
  // 选中的目标离开画面（2 s 无更新被移除，V-U4）即取消选中、收起详情（D-054）
  useEffect(() => {
    if (targetKey && !target) deselect();
  }, [targetKey, target]);

  const detail = selected !== undefined || target !== undefined;

  async function handleLogout() {
    setLogout("pending");
    await onLogout();
    setLogout("failed");
  }

  return (
    <div
      data-live={!offline}
      className="grid h-full grid-cols-[auto_minmax(0,1fr)_360px] grid-rows-[48px_minmax(0,1fr)] bg-background 2xl:grid-cols-[auto_minmax(0,1fr)_400px]"
    >
      <header className="col-span-3 flex items-center gap-4 border-b bg-card px-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck aria-hidden className="size-4" />
          </span>
          慧眼盾
        </span>
        <NavBar page={page} admin={admin} onChange={setPage} />
        <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <MapPin aria-hidden className="size-3.5" />
          {site.name}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <LlmStatusBadge />
          <ConnectionStatus />
          {logout === "failed" && (
            <p role="alert" className="flex items-center gap-1 text-meta">
              <CircleAlert aria-hidden className="size-4" />
              退出失败，请重试
            </p>
          )}
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={handleLogout} disabled={logout === "pending"} aria-label="退出登录">
            <LogOut aria-hidden />
            {logout === "pending" ? "退出中…" : "退出"}
          </Button>
        </div>
      </header>

      {/* B 摄像头栏（D-115） */}
      <CameraRail devices={site.devices} admin={admin} />

      {/* C 主画布：工具条 + 当前视图；断线时饱和度降至 50%（V-U3） */}
      <section ref={canvas} aria-label="主画布" className="flex min-h-0 flex-col bg-background">
        <CanvasToolbar canvas={canvas} stale={offline}>
          <WallControls cameras={cameraCount} />
        </CanvasToolbar>
        <div
          aria-label={view === "wall" ? "监控墙视图" : "场景"}
          role="region"
          className={cn("relative min-h-0 flex-1 overflow-hidden", offline && "saturate-50")}
        >
          {/* 只挂载当前视图：监控墙下不占用 3D 渲染，空间态势下不保持多路实时画面连接 */}
          {view === "wall" ? <VideoWall devices={site.devices} /> : <SceneViewport site={site} onBuild={admin ? () => setPage("scene") : undefined} />}
          {offline && (
            <p className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border border-dashed border-uncertain bg-card/90 px-3 py-1.5 text-meta text-muted-foreground backdrop-blur-sm">
              <Clock aria-hidden className="size-4" />
              数据非实时 · 最后更新 {formatTime(lastFrameAt)}
            </p>
          )}
        </div>
      </section>

      {/* D 检查栏（D-115） */}
      <aside aria-label="检查栏" className="flex min-h-0 flex-col border-l bg-card">
        <div hidden={detail} className="flex min-h-0 flex-1 flex-col">
          <AlertList stale={offline} lastFrameAt={lastFrameAt} />
        </div>
        {selected && <DetailPanel device={selected} stale={offline} onClose={deselect} />}
        {target && <TargetPanel target={target} stale={offline} onClose={deselect} />}
      </aside>

      {/* 盖在主界面之上而不替换它：场景与推送保持运行，返回时无需重新加载 */}
      {admin && page === "cameras" && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 overflow-auto bg-background">
          <CameraPage onClose={() => setPage("overview")} />
        </div>
      )}
      {/* 场景页铺满、页面本身不滚动（V-L2） */}
      {admin && page === "scene" && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 bg-background">
          <ScenePage site={site} onClose={() => setPage("overview")} />
        </div>
      )}
      {admin && page === "providers" && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 overflow-auto bg-background">
          <ProviderPage onClose={() => setPage("overview")} />
        </div>
      )}
    </div>
  );
}

/** 顶栏分段导航（D-106、设计 150 §3）："摄像头""场景""模型供应商"只对 admin 渲染（C-FE-07） */
function NavBar(props: { page: Page; admin: boolean; onChange: (page: Page) => void }) {
  const { page, admin, onChange } = props;
  const items: { page: Page; label: string }[] = [{ page: "overview", label: "态势" }];
  if (admin) items.push({ page: "cameras", label: "摄像头" }, { page: "scene", label: "场景" }, { page: "providers", label: "模型供应商" });
  return (
    <nav aria-label="导航" className="flex h-8 items-center gap-0.5 rounded-md bg-secondary p-0.5">
      {items.map((item) => (
        <button
          key={item.page}
          type="button"
          aria-current={page === item.page ? "page" : undefined}
          onClick={() => onChange(item.page)}
          className={cn(
            "h-7 rounded-sm px-3 text-sm transition-colors",
            page === item.page ? "bg-card font-medium text-primary shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
