import { CircleAlert, ListChecks, LogOut, MapPin, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { guardLeave } from "../../editor/History";
import { ScenePage } from "../../editor/ScenePage";
import { api, type Site } from "../../lib/api";
import { useArea } from "../../scene/areas";
import { connect, useConnection } from "../../store/connection";
import { applySite, useLive } from "../../store/live";
import { type AdminPage, go, type Page, useNav } from "../../store/nav";
import { select, useSelection } from "../../store/selection";
import { canManageProviders, useSession } from "../../store/session";
import { AdminFrame } from "../Admin/AdminFrame";
import { Alarm } from "../Alarm/Alarm";
import { CameraPage } from "../CameraList/CameraList";
import { InvestigationSheet, InvestigationWatcher } from "../InvestigationSheet/InvestigationSheet";
import { INVESTIGATED, openInvestigation, useSheet } from "../InvestigationSheet/sheet";
import { ConnectionStatus } from "../ConnectionStatus/ConnectionStatus";
import { LlmStatusBadge } from "../LlmStatusBadge/LlmStatusBadge";
import { Overview } from "../Overview/Overview";
import { ProviderPage } from "../ProviderList/ProviderList";
import { ThemeToggle } from "../ThemeToggle/ThemeToggle";
import { WallPage } from "../VideoWall/WallPage";

const deselect = () => select(null);
// 关闭管理页回到它盖住的态势或监控墙
const home = () => go(useNav.getState().main);

/**
 * 主界面（设计 150 §3）：顶栏导航 + 当前页面。监控墙为默认页，态势（3D 铺满 + 浮动卡片）为辅助总览，二者只挂载当前一个：
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
  // 换账户重新登录时从态势页、列表第一个区域开始
  useEffect(
    () => () => {
      useNav.setState(useNav.getInitialState());
      useArea.setState(useArea.getInitialState());
    },
    [],
  );
  const admin = canManageProviders(useSession((s) => s.role));
  const roleFailed = useSession((s) => s.roleFailed);
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
  // 选中的设备不在站点中（摄像头已删除，仍可从它的旧告警点选）：取消选中，不留下无详情可显示的高亮
  const deviceId = useSelection((s) => s.deviceId);
  const known = deviceId === null || site.devices.some((d) => d.id === deviceId);
  useEffect(() => {
    if (!known) deselect();
  }, [known]);

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
        <span className="flex shrink-0 items-center gap-2 text-[15px] font-semibold whitespace-nowrap">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck aria-hidden className="size-4" />
          </span>
          慧眼盾
        </span>
        <NavBar page={page} admin={admin} onChange={(next) => leave(() => go(next))} />
        <span className="flex min-w-0 items-center gap-1.5 text-meta whitespace-nowrap text-muted-foreground">
          <MapPin aria-hidden className="size-3.5" />
          {site.name}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {roleFailed && (
            <p role="status" className="flex items-center gap-1 text-meta text-muted-foreground">
              <CircleAlert aria-hidden className="size-4" />
              权限信息读取失败，正在重试
            </p>
          )}
          <InvestigationButton />
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
      {admin && isAdminPage(page) && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-20 bg-background">
          <AdminFrame page={page} onNavigate={(next) => leave(() => go(next))}>
            {/* 场景页铺满、页面本身不滚动（V-L2）；其余管理页在内容区内滚动 */}
            {page === "scene" ? (
              <ScenePage site={site} onClose={home} />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {page === "cameras" ? <CameraPage onClose={home} /> : <ProviderPage onClose={home} />}
              </div>
            )}
          </AdminFrame>
        </div>
      )}
      {/* 研判面板：高危关联事件实时到达时自动打开，逐步展示 AI 调查过程 */}
      <InvestigationWatcher />
      <InvestigationSheet stale={offline} />
      {/* 确认级物理告警：响铃并弹出带当时画面的处置卡片 */}
      <Alarm />
      {/* 操作结果提示（设计 150 §9A）：保存、删除区域的成功与失败 */}
      <Toaster position="top-center" />
    </div>
  );
}

/** 顶栏"研判"：打开最近一起在 AI 调查范围内的关联事件；面板已打开时再点收起 */
function InvestigationButton() {
  const latest = useLive((s) => s.incidents.find((i) => INVESTIGATED.has(i.severity)));
  const open = useSheet((s) => s.incidentId !== null);
  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="sm"
      disabled={!latest && !open}
      aria-pressed={open}
      onClick={() => (open ? useSheet.setState({ incidentId: null }) : latest && openInvestigation(latest.id))}
    >
      <ListChecks aria-hidden />
      研判
    </Button>
  );
}

const isAdminPage = (page: Page): page is AdminPage => page !== "overview" && page !== "wall";

/**
 * 顶栏分段导航（D-106、设计 150 §3）：态势 · 监控墙 · 管理。"管理"只对 admin 渲染（C-FE-07），进入摄像头页，
 * 摄像头、场景、模型供应商在管理页左侧栏切换（产品负责人 2026-11-09 选定，导航不重复）
 */
function NavBar(props: { page: Page; admin: boolean; onChange: (page: Page) => void }) {
  const { page, admin, onChange } = props;
  const items: { page: Page; label: string; current: boolean }[] = [
    { page: "wall", label: "监控墙", current: page === "wall" },
    { page: "overview", label: "态势", current: page === "overview" },
  ];
  if (admin) items.push({ page: "cameras", label: "管理", current: isAdminPage(page) });
  return (
    <nav aria-label="导航" className="flex h-8 items-center gap-0.5 rounded-md bg-secondary p-0.5">
      {items.map((item) => (
        <button
          key={item.page}
          type="button"
          aria-current={item.current ? "page" : undefined}
          onClick={() => !item.current && onChange(item.page)}
          className={cn(
            "h-7 rounded-sm px-3 text-sm whitespace-nowrap transition-colors",
            item.current ? "bg-card font-medium text-primary shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
