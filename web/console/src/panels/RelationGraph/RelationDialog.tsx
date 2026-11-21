import { Crosshair, ListChecks, Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type Device, type Site, useLive } from "../../store/live";
import { select, selectIncident } from "../../store/selection";
import { openInvestigation } from "../InvestigationSheet/sheet";
import {
  KIND_COLOR, KIND_LABEL, REASON_LABEL, analyze, ago, buildGraph, describe, deviceDegree, narrative, nodeId, subgraph,
  type GraphNode, type Relation,
} from "./model";
import { RelationGraph } from "./RelationGraph";

/** 关系图打开的设备（摄像头 ID）；null 为关闭 */
export const useRelation = create<{ deviceId: string | null }>(() => ({ deviceId: null }));
export const openRelation = (deviceId: string) => useRelation.setState({ deviceId });
export const closeRelation = () => useRelation.setState({ deviceId: null });

/** 站点设备叠加推送的最新状态 */
export function useDevices(site: Site): Device[] {
  const pushed = useLive((s) => s.devices);
  return useMemo(() => site.devices.map((d) => pushed[d.id] ?? d), [site.devices, pushed]);
}

/**
 * 摄像头关系图（移植自 aegis 风控关系图）：以摄像头为主体，把近 24 小时攻击它的攻击源、攻击类型与 ATT&CK 技术、
 * 涉及它的关联事件与处置、画面上检测到的事件连成一张图；同一攻击源打过的其他设备、同一起关联事件涉及的设备
 * 作为关联设备列出。数据随推送实时更新
 */
export function RelationDialog({ site }: { site: Site }) {
  const deviceId = useRelation((s) => s.deviceId);
  return (
    <Dialog open={deviceId !== null} onOpenChange={(open) => !open && closeRelation()}>
      <DialogContent className="flex h-[calc(100vh-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1440px,calc(100vw-3rem))]">
        {deviceId !== null && <Body site={site} deviceId={deviceId} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({ site, deviceId }: { site: Site; deviceId: string }) {
  const devices = useDevices(site);
  const alerts = useLive((s) => s.alerts);
  const incidents = useLive((s) => s.incidents);
  const executions = useLive((s) => s.executions);
  const full = useMemo(() => buildGraph({ devices, alerts, incidents, executions }), [devices, alerts, incidents, executions]);
  const center = nodeId.device(deviceId);
  const graph = useMemo(() => subgraph(full, center), [full, center]);
  const stats = useMemo(() => analyze(graph), [graph]);
  const degree = useMemo(() => deviceDegree(graph), [graph]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const me = graph.nodes.find((n) => n.id === center);
  const name = me?.props.device?.name || deviceId;
  // 有记录的设备排在前面，便于切换
  const touched = useMemo(() => new Set(full.links.flatMap((l) => [l.source, l.target])), [full]);
  const options = useMemo(
    () => [...devices].sort((a, b) => Number(touched.has(nodeId.device(b.id))) - Number(touched.has(nodeId.device(a.id))) || a.id.localeCompare(b.id)),
    [devices, touched],
  );

  const recenter = (id: string) => {
    setSelectedId(null);
    openRelation(id);
  };

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b pr-14 pl-5">
        <Waypoints aria-hidden className="size-5 text-primary" />
        <DialogTitle className="text-base">关系图</DialogTitle>
        <DialogDescription className="sr-only">以摄像头为中心的攻击源、关联事件与处置关系</DialogDescription>
        <Select value={deviceId} onValueChange={recenter}>
          <SelectTrigger size="sm" className="ml-2 w-64" aria-label="中心设备">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span className="font-mono">{d.id}</span>
                {d.name && d.name !== d.id && <span className="text-muted-foreground">{d.name}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-meta text-muted-foreground">近 24 小时 · 实时更新</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <RelationGraph
          key={deviceId}
          graph={graph}
          height="100%"
          className="min-w-0 flex-1 rounded-none"
          selectedId={selectedId}
          onSelect={(n) => setSelectedId(n?.id ?? null)}
          onRecenter={(n) => n.props.device && recenter(n.props.device.id)}
        />
        <aside className="flex w-80 shrink-0 flex-col border-l bg-card">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 p-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">摘要</h3>
                <p className="text-sm leading-relaxed text-muted-foreground" data-testid="relation-narrative">
                  {narrative(name, stats)}
                </p>
              </section>
              {selected && <NodeDetail node={selected} degree={degree.get(selected.id) ?? 0} onRecenter={recenter} />}
              <Relations relations={stats.relations} onRecenter={recenter} />
            </div>
          </ScrollArea>
        </aside>
      </div>
    </>
  );
}

function NodeDetail({ node, degree, onRecenter }: { node: GraphNode; degree: number; onRecenter: (id: string) => void }) {
  const d = describe(node, degree);
  const device = node.props.device;
  const incident = node.props.incident;
  return (
    <section className="flex flex-col gap-2.5 border-t pt-4" aria-label="选中的点">
      <div className="flex items-start gap-2">
        <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: KIND_COLOR[node.kind] }} />
        <div className="min-w-0">
          <h3 className="text-sm font-medium break-all">{d.title}</h3>
          <p className="text-xs text-muted-foreground">{d.subtitle}</p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {d.facts.map((f) => (
          <div key={f.label + f.value} className="contents">
            <dt className="text-subtle-foreground">{f.label}</dt>
            <dd
              className={cn(
                "break-all",
                f.tone === "danger" && "font-medium text-[#D03B3B]",
                f.tone === "warning" && "text-[#b7791f]",
                f.tone === "muted" && "text-muted-foreground",
              )}
            >
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        {device && (
          <>
            <Button size="xs" variant="outline" onClick={() => onRecenter(device.id)}>
              <Crosshair aria-hidden />
              以它为中心
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                closeRelationDialog();
                select(device.id);
              }}
            >
              查看设备详情
            </Button>
          </>
        )}
        {incident && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              closeRelationDialog();
              selectIncident(incident);
              openInvestigation(incident.id);
            }}
          >
            <ListChecks aria-hidden />
            打开研判
          </Button>
        )}
      </div>
    </section>
  );
}

const closeRelationDialog = () => closeRelation();

function Relations({ relations, onRecenter }: { relations: Relation[]; onRecenter: (id: string) => void }) {
  return (
    <section className="flex flex-col gap-2 border-t pt-4">
      <h3 className="text-sm font-medium">
        关联设备 <span className="text-muted-foreground tabular-nums">{relations.length}</span>
      </h3>
      {relations.length === 0 ? (
        <p className="text-xs text-muted-foreground">没有其他设备与它有关联</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {relations.map((r) => {
            const id = r.device.props.device?.id;
            const last = Math.max(...r.reasons.map((x) => x.lastSeen));
            return (
              <li key={r.device.id}>
                <button
                  type="button"
                  disabled={!id}
                  onClick={() => id && onRecenter(id)}
                  className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="size-2 rounded-full" style={{ background: KIND_COLOR[r.device.kind] }} />
                    <span className="truncate font-mono">{r.device.label}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{KIND_LABEL[r.device.kind]}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[...new Set(r.reasons.map((x) => `${REASON_LABEL[x.kind]} ${x.via.label}`))].slice(0, 3).join("；")}
                    {last ? ` · ${ago(last)}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
