import { Bot, Camera, Map as MapIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import type { AdminPage } from "../../store/nav";

const ITEMS: [AdminPage, string, typeof Camera][] = [
  ["cameras", "摄像头", Camera],
  ["scene", "场景", MapIcon],
  ["providers", "模型供应商", Bot],
];

/**
 * 管理页外框（设计 150 §9A，借鉴 shadcn sidebar-07）：左侧可收起为图标栏的侧栏列出摄像头、场景、模型供应商，右侧为当前管理页；
 * 位于顶栏之下。只对 admin 渲染（C-FE-07），由调用方保证。切换前经 onNavigate（场景页有未保存修改时先确认）
 */
export function AdminFrame(props: { page: AdminPage; onNavigate: (page: AdminPage) => void; children: ReactNode }) {
  const { page, onNavigate, children } = props;
  return (
    <SidebarProvider className="h-full min-h-0">
      <Sidebar collapsible="icon" className="top-12 h-[calc(100svh-3rem)]">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <nav aria-label="管理">
                <SidebarMenu>
                  {ITEMS.map(([id, label, Icon]) => (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton
                        isActive={page === id}
                        tooltip={label}
                        aria-current={page === id ? "page" : undefined}
                        onClick={() => onNavigate(id)}
                      >
                        <Icon aria-hidden />
                        {/* 收起为图标栏时隐藏文字，名称见悬停提示 */}
                        <span className="group-data-[collapsible=icon]:hidden">{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </nav>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarTrigger />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-h-0 min-w-0">{children}</SidebarInset>
    </SidebarProvider>
  );
}
