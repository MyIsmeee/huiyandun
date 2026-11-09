import { BrickWall, Building2, DoorOpen, type LucideIcon, Package, Route, Search, Sofa, Trees } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useCatalog, useCategories } from "../scene/assets";
import { selectTool, useDraft } from "./draft";

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

/** 模型库（设计 150 §6）：按类别或名称查找模型，选中后在地面上放置（E-2），再点一次取消 */
export function Library() {
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
    </aside>
  );
}
