import { CircleAlert, LogOut, MapPin, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { guardLeave } from "../../editor/History";
import { ScenePage } from "../../editor/ScenePage";
import { api, type Site } from "../../lib/api";
import { connect, useConnection } from "../../store/connection";
import { applySite, useLive } from "../../store/live";
import { go, type Page, useNav } from "../../store/nav";
import { select, useSelection } from "../../store/selection";
import { canManageProviders, useSession } from "../../store/session";
import { CameraPage } from "../CameraList/CameraList";
import { ConnectionStatus } from "../ConnectionStatus/ConnectionStatus";
import { LlmStatusBadge } from "../LlmStatusBadge/LlmStatusBadge";
import { Overview } from "../Overview/Overview";
import { ProviderPage } from "../ProviderList/ProviderList";
import { ThemeToggle } from "../ThemeToggle/ThemeToggle";
import { WallPage } from "../VideoWall/WallPage";

const deselect = () => select(null);
const home = () => go("overview");

/**
 * 主界面（设计 150 §3）：顶栏导航 + 当前页面。态势为默认页（3D 铺满 + 浮动卡片），监控墙为独立视图，二者只挂载当前一个：
 * 监控墙下不占用 3D 渲染，态势页不保持多路实时画面连接。
 * onLogout 完成后若仍渲染本页，说明会话仍有效、退出未成功。
 * 进入即连接 WS；连接被拒时调用 onRejected 核对会话。
 */
export function Shell(props: { site: Site; onLogout: () => Promise<void>; onRejected: () => void }) {
  const { onLogout, onRejected } = props;
  // 摄像头登记表变化后以推送的站点为准（D-101）
  const site = useLive((s) => s.site) ?? props.site;
  const [logout, setLogout] = useState<"idle" | "pending" | "failed">("idle");
  const { page, main } = useNav();
  // 换账户重新登录时从态势页开始
  useEffect(() => () => useNav.setState(useNav.getInitialState()), []);
  const admin = canManageProviders(useSession((s) => s.role));
  const { open, connecting, lastFrameAt } = useConnection();
  const offline = !open && !connecting;
  useEffect(() => connect(onRejected), [onRejected]);
  // 断线期间摄像头登记表可能变化（site 频道不补推）：连接建立后重新读取站点
  useEffect(() => {
    if (open) api.getSite().then(applySite, () => undefined);
  }, [open]);
  const targetKey = useSelection((s) => s.targetKey);
  const target = useLive((s) => (targetKey ? s.targets[targetKey] : undefined));
  // 选中的目标离开画面（2 s 无更新被移除，V-U4）即取消选中、收起详情（D-054）
  useEffect(() => {
    if (targetKey && !target) deselect();
  }, [targetKey, target]);

  // 场景页有未保存的修改时，顶栏切页与退出先确认（设计 150 E-6）
  const leave = (action: () => void) => (page === "scene" ? guardLeave(action) : action());

  async function handleLogout() {
    setLogout("pending");
    await onLogout();
    setLogout("failed");
  }

  return (
    <div data-live={!offline} className="flex h-full flex-col bg-background">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-card px-3">
        <span className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck aria-hidden className="size-4" />
          </span>
          慧眼盾
        </span>
        <NavBar page={page} admin={admin} onChange={(next) => leave(() => go(next))} />
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
          <Button variant="ghost" size="sm" onClick={() => leave(() => void handleLogout())} disabled={logout === "pending"} aria-label="退出登录">
            <LogOut aria-hidden />
            {logout === "pending" ? "退出中…" : "退出"}
          </Button>
        </div>
      </header>

      {main === "wall" ? (
        <WallPage site={site} admin={admin} stale={offline} lastFrameAt={lastFrameAt} />
      ) : (
        <Overview site={site} stale={offline} lastFrameAt={lastFrameAt} onBuild={admin ? () => go("scene") : undefined} />
      )}

      {/* 管理页盖在态势或监控墙之上而不替换它：场景与推送保持运行，返回时无需重新加载 */}
      {admin && page === "cameras" && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 overflow-auto bg-background">
          <CameraPage onClose={home} />
        </div>
      )}
      {/* 场景页铺满、页面本身不滚动（V-L2） */}
      {admin && page === "scene" && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 bg-background">
          <ScenePage site={site} onClose={home} />
        </div>
      )}
      {admin && page === "providers" && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 overflow-auto bg-background">
          <ProviderPage onClose={home} />
        </div>
      )}
      {/* 操作结果提示（设计 150 §9A）：保存、删除区域的成功与失败 */}
      <Toaster position="top-center" />
    </div>
  );
}

/** 顶栏分段导航（D-106、设计 150 §3）：态势 · 监控墙 · 摄像头 · 场景 · 模型供应商，后三项只对 admin 渲染（C-FE-07） */
function NavBar(props: { page: Page; admin: boolean; onChange: (page: Page) => void }) {
  const { page, admin, onChange } = props;
  const items: { page: Page; label: string }[] = [
    { page: "overview", label: "态势" },
    { page: "wall", label: "监控墙" },
  ];
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
