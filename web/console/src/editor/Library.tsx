import { BrickWall, Building2, Cctv, DoorOpen, type LucideIcon, Package, Route, Search, Sofa, Trees } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useCatalog, useCategories } from "../scene/assets";
import type { Device } from "../store/live";
import { cameraTool, placingCamera, removeCamera, selectTool, useDraft } from "./draft";

const ICONS: Record<string, LucideIcon> = {
  building: Building2,
  road: Route,
  wall: BrickWall,
  opening: DoorOpen,
  furniture: Sofa,
  equipment: Package,
  greenery: Trees,
};
/** 选中项蓝色描边（设计 150 §9A，借鉴 uiverse Yaya12085/silent-liger-85 的图标卡片式单选，MIT） */
const OPTION =
  "flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:bg-secondary aria-pressed:border-primary aria-pressed:bg-card";

/** 模型库（设计 150 §6）：按类别或名称查找模型，选中后在地面上放置（E-2），再点一次取消；底部为摄像头（E-5） */
export function Library({ devices }: { devices: Device[] }) {
  const catalog = useCatalog();
  const categories = useCategories();
  const tool = useDraft((s) => s.tool);
  const [category, setCategory] = useState(categories[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const assets = [...catalog.values()];
  const shown = query.trim() ? assets.filter((a) => a.name.includes(query.trim())) : assets.filter((a) => a.category === category);

  return (
    <aside aria-label="模型库" className="flex w-60 min-h-0 flex-col gap-3 border-r bg-card p-3">
      <label className="relative">
        <Search aria-hidden className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle-foreground" />
        <Input aria-label="搜索模型" placeholder="搜索…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
      </label>
      {!query.trim() && (
        <div role="group" aria-label="类别" className="grid gap-0.5">
          {categories.map((c) => {
            const Icon = ICONS[c.id] ?? Package;
            return (
              <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)} className={OPTION}>
                <Icon aria-hidden className="size-4 text-muted-foreground" />
                {c.name}
                <span className="ml-auto text-xs text-subtle-foreground">{assets.filter((a) => a.category === c.id).length}</span>
              </button>
            );
          })}
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1 border-t pt-2">
        <div role="group" aria-label="模型" className="grid gap-0.5 pr-3">
          {shown.map((a) => (
            <button
              key={a.id}
              type="button"
              aria-pressed={tool === a.id}
              onClick={() => selectTool(tool === a.id ? null : a.id)}
              className={cn(OPTION, "justify-between")}
            >
              {a.name}
              <span className="text-xs text-subtle-foreground">
                {a.footprint[0]}×{a.footprint[1]} m
              </span>
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-subtle-foreground">没有匹配的模型</p>}
        </div>
      </ScrollArea>
      <Cameras devices={devices} />
    </aside>
  );
}

/**
 * 摄像头（设计 150 E-5）：未放入任何区域的摄像头点选后在地面上按下即放置，拖动方向为朝向；
 * 本区域的摄像头可重新放置或移出区域；移出已标定的摄像头时提示保存后标定清除（D-134）。安装高度、俯角、视场角在摄像头页编辑
 */
/** 移出已标定摄像头时的提示，按摄像头编号去重，放回后撤掉 */
const clearNotice = (id: string) => `calibration-cleared-${id}`;

function Cameras({ devices }: { devices: Device[] }) {
  const placed = useDraft((s) => s.cameras);
  const areaId = useDraft((s) => s.areaId);
  const placing = cameraTool(useDraft((s) => s.tool));
  const ids = new Set(placed.map((c) => c.id));
  const placedKey = placed.map((c) => c.id).join(",");
  useEffect(() => {
    // 保存前又放回本区域（重新放置或撤销）：保存时不会清除标定，撤掉移出时的提示
    for (const id of placedKey.split(",")) toast.dismiss(clearNotice(id));
  }, [placedKey]);
  const cameras = devices.filter((d) => d.camera);
  // 未放入任何区域的，以及本页刚从本区域移出、尚未保存的
  const free = cameras.filter((d) => !ids.has(d.id) && (!d.camera?.area_id || d.camera.area_id === areaId));
  const here = cameras.filter((d) => ids.has(d.id));
  if (free.length === 0 && here.length === 0) return null;
  function remove(d: Device) {
    removeCamera(d.id);
    // 只有原本就在本区域的摄像头带着本区域的标定；其他摄像头放入前已不属于任何区域，没有标定
    if (d.camera?.area_id === areaId && d.camera.calibration.length >= 4) toast.warning(`保存后 ${d.id} 的地面标定将清除`, { id: clearNotice(d.id) });
  }
  return (
    <div role="group" aria-label="摄像头" className="grid gap-0.5 border-t pt-2">
      <p className="flex items-center gap-2 px-2 text-xs text-subtle-foreground">
        <Cctv aria-hidden className="size-4" />
        摄像头 · 按下放置，拖动设朝向
      </p>
      {free.map((d) => (
        <button key={d.id} type="button" aria-pressed={placing === d.id} onClick={() => (placing === d.id ? selectTool(null) : placingCamera(d.id))} className={cn(OPTION, "justify-between")}>
          {d.name}
          <span className="text-xs text-subtle-foreground">未放置</span>
        </button>
      ))}
      {here.map((d) => (
        <div key={d.id} className="flex items-center gap-1 pl-2">
          <span className="min-w-0 flex-1 truncate">{d.name}</span>
          <Button variant="ghost" size="sm" aria-pressed={placing === d.id} aria-label={`重新放置 ${d.name}`} onClick={() => placingCamera(d.id)}>
            重新放置
          </Button>
          <Button variant="ghost" size="sm" aria-label={`移出区域 ${d.name}`} onClick={() => remove(d)}>
            移出
          </Button>
        </div>
      ))}
    </div>
  );
}
