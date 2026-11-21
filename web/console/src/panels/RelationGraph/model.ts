/**
 * 摄像头关系图的数据层（移植自 aegis 风控关系图，主体由账号换成摄像头）。
 *
 * - 取材：全部来自 WS 推送的近 24 小时记录（告警、关联事件、处置执行）与站点设备，不另向服务端请求；
 *   推送到达即重算，攻击发生时图上实时出现新的攻击源与连线。
 * - 建图：先把全部记录整理成一张全站的图，再以选中的摄像头为中心按跳数截取子图。攻击类型、ATT&CK 技术、
 *   画面事件是「说明性」的点，只挂在主体附近，不经由它们把无关的设备连进来（同一种攻击打过的设备不算关联）。
 * - 折叠：只攻击过这一台设备、又没有形成关联事件的攻击源（扫描器换着地址打）合并成一个「N 个攻击源」点，点开再展开。
 * - 归纳：算出哪些设备与主体有关联、为什么（同一攻击源、同一起关联事件），供叙述式摘要和关联设备列表用。
 */
import type { Alert, Device, Execution, Incident, SecurityAlert } from "../../store/live";
import { isPhysical } from "../../store/live";

export type NodeKind = "camera" | "device" | "attacker" | "attack" | "technique" | "incident" | "playbook" | "scene";
export type ViewKind = NodeKind | "attacker_group";

export type LinkKind =
  | "attacked" // 攻击源 → 设备：网络告警
  | "launched" // 攻击源 → 攻击类型
  | "maps_to" // 攻击类型 → ATT&CK 技术
  | "involves" // 关联事件 → 设备
  | "sourced" // 关联事件 → 攻击源
  | "hit" // 关联事件 → 命中的攻击类型 / 画面事件
  | "handled" // 处置 → 关联事件
  | "blocked" // 处置 → 攻击源
  | "detected"; // 设备 → 画面事件

type Severity = Incident["severity"];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** 距中心的跳数；全站图里为 0 */
  depth: number;
  props: NodeProps;
}

/** 各类点的附加信息；字段按类型取用 */
export interface NodeProps {
  device?: Device;
  /** 告警指向的地址没有登记为设备（FR-203） */
  unregistered?: boolean;
  ip?: string;
  severity?: Severity;
  /** 告警条数（攻击源、攻击类型、画面事件） */
  alerts?: number;
  /** 全部告警都是 monitor 模式或疑似：只显示，不参与关联与处置 */
  monitorOnly?: boolean;
  /** 攻击源被处置（封禁）的最新状态 */
  blocked?: Execution["state"];
  ruleId?: string;
  category?: string;
  summary?: string;
  technique?: string;
  incident?: Incident;
  execution?: Execution;
  cameraId?: string;
  /** 画面事件的类别：行为（跌倒…）或规则（区域入侵、越线） */
  sceneKind?: string;
  sceneName?: string | null;
  suspected?: number;
  firstSeen?: number;
  lastSeen?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: LinkKind;
  count: number;
  /** 毫秒；没有时为 0 */
  firstSeen: number;
  lastSeen: number;
  /** monitor 模式或疑似事件：虚线弱化，不作为关联依据 */
  weak: boolean;
}

export interface Subgraph {
  center: string;
  nodes: GraphNode[];
  links: GraphLink[];
}

export interface LiveData {
  devices: Device[];
  alerts: Alert[];
  incidents: Incident[];
  executions: Record<string, Execution>;
}

// ── 文案与配色 ──

export const KIND_LABEL: Record<ViewKind, string> = {
  camera: "摄像头", device: "其他设备", attacker: "攻击源", attacker_group: "攻击源组", attack: "攻击类型",
  technique: "ATT&CK 技术", incident: "关联事件", playbook: "处置", scene: "画面事件",
};

/** 网络攻击为红、物理告警为琥珀、已处置为绿，与场景配色一致（scene/devices.ts 的 STATUS） */
export const KIND_COLOR: Record<ViewKind, string> = {
  camera: "#6366f1", device: "#0ea5e9", attacker: "#D03B3B", attacker_group: "#e06666", attack: "#f97316",
  technique: "#a855f7", incident: "#ec4899", playbook: "#0CA30C", scene: "#FAB219",
};

/** 图例与筛选的顺序 */
export const KIND_ORDER: ViewKind[] = ["camera", "device", "attacker", "attacker_group", "attack", "technique", "incident", "playbook", "scene"];

export const WEAK_COLOR = "#94a3b8";

/** 关系的说法：「A 攻击了 B」 */
export const EDGE_VERB: Record<LinkKind, string> = {
  attacked: "攻击了", launched: "发起了", maps_to: "对应 ATT&CK", involves: "涉及设备", sourced: "的攻击源是",
  hit: "命中了", handled: "处置了", blocked: "封禁了", detected: "检测到",
};

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "严重", high: "高", medium: "中", low: "低" };
const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const TYPE_LABEL: Record<Device["type"], string> = { camera: "摄像头", nvr: "录像机", switch: "交换机" };

/** 自研网络规则的分类（与告警栏 CATEGORY 一致） */
const CATEGORY: Record<string, string> = { auth_bruteforce: "口令暴力破解", stream_hijack: "RTSP 推流劫持", log_tamper: "日志篡改" };
const BEHAVIOR: Record<string, string> = { fall: "跌倒", climb: "攀爬越界", still: "长时间静止", fight: "打架" };
const RULE: Record<string, string> = { intrusion: "区域入侵", line_crossing: "越线" };

export const DEVICE_STATE: Record<Device["state"], string> = {
  normal: "正常", offline: "离线", uncalibrated: "未标定", physical_alert: "物理告警", cyber_alert: "网络攻击",
  both: "网络攻击 + 物理告警", pending_action: "处置中", contained: "已处置", notify_only: "已通知 · 待联动",
};

export const EXECUTION_STATE: Record<Execution["state"], string> = {
  pending: "待确认", executing: "处置中", verifying: "校验中", contained: "已封禁", failed: "处置失败",
  rolled_back: "已解除", notify_only: "已通知 · 待联动", skipped: "未处置", expired: "未确认 · 已过期",
};

const INCIDENT_STATUS: Record<Incident["status"], string> = { open: "未处置", containing: "处置中", contained: "已处置", closed: "已关闭" };

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);

export const nodeId = {
  device: (id: string) => `dev:${id}`,
  dest: (ip: string) => `dst:${ip}`,
  attacker: (ip: string) => `ip:${ip}`,
  attack: (ruleId: string) => `atk:${ruleId}`,
  technique: (t: string) => `tech:${t}`,
  incident: (id: string) => `inc:${id}`,
  playbook: (id: string) => `exe:${id}`,
  scene: (camera: string, key: string) => `scn:${camera}/${key}`,
};

/** 网络告警的攻击类型名称：自研规则按分类给中文名，其余照签名原文 */
export function attackName(a: Pick<SecurityAlert, "source" | "category" | "summary">): string {
  return (a.source === "rule" ? CATEGORY[a.category] : undefined) ?? a.summary;
}

// ── 建图 ──

class Builder {
  nodes = new Map<string, GraphNode>();
  links = new Map<string, GraphLink>();

  node(id: string, kind: NodeKind, label: string, props: NodeProps = {}): GraphNode {
    const cur = this.nodes.get(id);
    if (cur) {
      Object.assign(cur.props, props);
      return cur;
    }
    const n: GraphNode = { id, kind, label, depth: 0, props: { ...props } };
    this.nodes.set(id, n);
    return n;
  }

  link(source: string, target: string, kind: LinkKind, at: number, weak = false, count = 1) {
    const id = `${source}>${target}:${kind}`;
    const cur = this.links.get(id);
    if (cur) {
      cur.count += count;
      if (at) {
        cur.firstSeen = cur.firstSeen ? Math.min(cur.firstSeen, at) : at;
        cur.lastSeen = Math.max(cur.lastSeen, at);
      }
      // 只要有一条不是弱关系，整条就不是
      cur.weak &&= weak;
      return;
    }
    this.links.set(id, { source, target, kind, count, firstSeen: at, lastSeen: at, weak });
  }
}

function seenAt(n: GraphNode, at: number) {
  if (!at) return;
  n.props.firstSeen = n.props.firstSeen ? Math.min(n.props.firstSeen, at) : at;
  n.props.lastSeen = Math.max(n.props.lastSeen ?? 0, at);
}

function raise(n: GraphNode, s: Severity) {
  if (!n.props.severity || SEVERITY_RANK[s] > SEVERITY_RANK[n.props.severity]) n.props.severity = s;
}

/** 全站的关系图：所有设备、攻击源、攻击类型、关联事件、处置与画面事件 */
export function buildGraph(data: LiveData): Omit<Subgraph, "center"> {
  const b = new Builder();
  const byIp = new Map<string, Device>();
  for (const d of data.devices) {
    b.node(nodeId.device(d.id), d.type === "camera" ? "camera" : "device", d.id, { device: d, ip: d.ip });
    byIp.set(d.ip, d);
  }
  const deviceNode = (deviceId: string | null, dstIp: string) => {
    if (deviceId && b.nodes.has(nodeId.device(deviceId))) return nodeId.device(deviceId);
    // 设备 ID 未登记（或摄像头已删除）：按目标地址找，再找不到就作为未登记的地址
    const known = byIp.get(dstIp);
    if (known) return nodeId.device(known.id);
    const id = deviceId ? nodeId.device(deviceId) : nodeId.dest(dstIp);
    b.node(id, "device", deviceId ?? dstIp, { ip: dstIp, unregistered: true });
    return id;
  };

  const byEvent = new Map<string, string>(); // event_id → 攻击类型 / 画面事件的点
  for (const a of data.alerts) {
    const at = ms(a.ts);
    if (isPhysical(a)) {
      const dev = deviceNode(a.camera_id, "");
      const isRule = "rule_type" in a;
      const key = isRule ? `r/${a.rule_id}` : `b/${a.behavior}`;
      const name = isRule ? a.rule_name : null;
      const label = isRule ? `${RULE[a.rule_type] ?? a.rule_type} · ${a.rule_name}` : (BEHAVIOR[a.behavior] ?? a.behavior);
      const id = nodeId.scene(a.camera_id, key);
      const n = b.node(id, "scene", label, { cameraId: a.camera_id, sceneKind: isRule ? a.rule_type : a.behavior, sceneName: name });
      const suspected = a.level === "suspected";
      n.props.alerts = (n.props.alerts ?? 0) + 1;
      if (suspected) n.props.suspected = (n.props.suspected ?? 0) + 1;
      seenAt(n, at);
      b.link(dev, id, "detected", at, suspected);
      byEvent.set(a.event_id, id);
      continue;
    }
    const weak = a.mode === "monitor";
    const dev = deviceNode(a.device_id, a.dst_ip);
    const ip = b.node(nodeId.attacker(a.src_ip), "attacker", a.src_ip, { ip: a.src_ip });
    ip.props.alerts = (ip.props.alerts ?? 0) + 1;
    ip.props.monitorOnly = (ip.props.monitorOnly ?? true) && weak;
    raise(ip, a.severity);
    seenAt(ip, at);
    const atk = b.node(nodeId.attack(a.rule_id), "attack", attackName(a), {
      ruleId: a.rule_id, category: a.category, summary: a.summary, technique: a.technique,
    });
    atk.props.alerts = (atk.props.alerts ?? 0) + 1;
    atk.props.monitorOnly = (atk.props.monitorOnly ?? true) && weak;
    raise(atk, a.severity);
    seenAt(atk, at);
    b.node(nodeId.technique(a.technique), "technique", a.technique, { technique: a.technique });
    b.link(ip.id, dev, "attacked", at, weak);
    b.link(ip.id, atk.id, "launched", at, weak);
    b.link(atk.id, nodeId.technique(a.technique), "maps_to", at, weak);
    byEvent.set(a.event_id, atk.id);
  }

  for (const inc of data.incidents) {
    const at = ms(inc.created_at);
    const id = nodeId.incident(inc.id);
    b.node(id, "incident", inc.title, { incident: inc, severity: inc.severity, firstSeen: at, lastSeen: at });
    for (const d of inc.device_ids) b.link(id, deviceNode(d, ""), "involves", at);
    if (inc.source_ip) {
      b.node(nodeId.attacker(inc.source_ip), "attacker", inc.source_ip, { ip: inc.source_ip });
      b.link(id, nodeId.attacker(inc.source_ip), "sourced", at);
    }
    for (const e of new Set(inc.hit_path)) {
      const hit = byEvent.get(e);
      if (hit) b.link(id, hit, "hit", at);
    }
    // 命中路径里的告警已滚出列表时，至少挂上它的 ATT&CK 技术
    if (![...b.links.values()].some((l) => l.source === id && l.kind === "hit")) {
      for (const t of inc.techniques) {
        b.node(nodeId.technique(t), "technique", t, { technique: t });
        b.link(id, nodeId.technique(t), "hit", at);
      }
    }
  }

  for (const exe of Object.values(data.executions)) {
    const inc = nodeId.incident(exe.incident_id);
    if (!b.nodes.has(inc)) continue; // 关联事件已滚出或被删除：处置单独挂着没有意义
    const at = ms(exe.expires_at) || ms(data.incidents.find((i) => i.id === exe.incident_id)?.created_at);
    const id = nodeId.playbook(exe.id);
    b.node(id, "playbook", `${EXECUTION_STATE[exe.state]} ${exe.target}`, { execution: exe });
    b.link(id, inc, "handled", at);
    const target = nodeId.attacker(exe.target);
    const n = b.nodes.get(target);
    if (n) {
      b.link(id, target, "blocked", at, !["contained", "executing", "verifying", "notify_only"].includes(exe.state));
      // 同一攻击源多次处置：取最近一次（executions 按更新先后排列）
      n.props.blocked = exe.state;
    }
  }
  return { nodes: [...b.nodes.values()], links: [...b.links.values()] };
}

/** 「实体」：可以把别的设备连进来的点；其余是挂在实体旁的说明性的点 */
const ENTITY = new Set<NodeKind>(["camera", "device", "attacker", "incident", "playbook"]);

/**
 * 以 center（设备点 ID）为中心截取子图：实体最多到 maxDepth 跳；说明性的点（攻击类型、技术、画面事件）只挂在
 * 1 跳以内的实体上，且不经由它们连入新的实体
 */
export function subgraph(full: Omit<Subgraph, "center">, center: string, maxDepth = 2): Subgraph {
  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  if (!byId.has(center)) return { center, nodes: [], links: [] };
  const adj = new Map<string, string[]>();
  for (const l of full.links) {
    for (const [a, z] of [[l.source, l.target], [l.target, l.source]] as const) listOf(adj, a).push(z);
  }
  const depth = new Map<string, number>([[center, 0]]);
  const queue = [center];
  for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
    const du = depth.get(u) ?? 0;
    const ku = byId.get(u)?.kind;
    if (!ku) continue;
    for (const v of adj.get(u) ?? []) {
      if (depth.has(v)) continue;
      const kv = byId.get(v)?.kind;
      if (!kv) continue;
      if (ENTITY.has(kv)) {
        if (!ENTITY.has(ku) || du + 1 > maxDepth) continue;
      } else if (ENTITY.has(ku) && du > 1) {
        continue;
      }
      depth.set(v, du + 1);
      queue.push(v);
    }
  }
  const nodes = full.nodes.filter((n) => depth.has(n.id)).map((n) => ({ ...n, depth: depth.get(n.id) ?? 0 }));
  const links = full.links.filter((l) => depth.has(l.source) && depth.has(l.target));
  return { center, nodes, links };
}

// ── 视图（折叠、筛选） ──

export interface ViewNode {
  id: string;
  kind: ViewKind;
  label: string;
  node?: GraphNode;
  /** 折叠点里的攻击源 */
  members?: GraphNode[];
  depth: number;
  center: boolean;
  /** 需要特别留意：高危、未处置 */
  alarm: boolean;
  weak: boolean;
  badges: string[];
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: LinkKind;
  count: number;
  firstSeen: number;
  lastSeen: number;
  weak: boolean;
}

function isAlarm(n: GraphNode): boolean {
  const p = n.props;
  switch (n.kind) {
    case "camera":
    case "device":
      return !!p.device && ["cyber_alert", "both", "physical_alert"].includes(p.device.state);
    case "attacker":
      return !p.monitorOnly && p.blocked !== "contained" && (p.severity === "critical" || p.severity === "high");
    case "incident":
      return p.incident?.status === "open" && (p.severity === "critical" || p.severity === "high");
    default:
      return false;
  }
}

export function badgesOf(n: GraphNode): string[] {
  const p = n.props;
  const out: string[] = [];
  switch (n.kind) {
    case "camera":
    case "device":
      if (p.unregistered) out.push("未登记");
      else if (p.device && p.device.state !== "normal") out.push(DEVICE_STATE[p.device.state]);
      break;
    case "attacker":
      if (p.blocked === "contained") out.push("已封禁");
      else if (p.blocked === "executing" || p.blocked === "verifying") out.push("封禁中");
      else if (p.blocked === "pending") out.push("待确认");
      if (p.alerts) out.push(`${p.alerts} 次`);
      break;
    case "attack":
      if (p.severity) out.push(SEVERITY_LABEL[p.severity]);
      break;
    case "incident":
      if (p.severity) out.push(SEVERITY_LABEL[p.severity]);
      break;
    case "scene":
      if (p.alerts && p.alerts > 1) out.push(`${p.alerts} 次`);
      break;
  }
  return out;
}

/** 点在图上显示的名字 */
export function displayName(n: GraphNode): string {
  const d = n.props.device;
  if (d && d.name && d.name !== d.id) return `${d.name}（${d.id}）`;
  return n.label;
}

const isWeak = (n: GraphNode) => (n.kind === "attacker" || n.kind === "attack") && !!n.props.monitorOnly;

/** 至少这么多个「只攻击过一台设备」的攻击源才折叠 */
export const GROUP_MIN = 5;

/**
 * 整理成可画的点与边。hidden：图例里关掉的类型；expanded：已展开的攻击源组（键是被攻击设备的点 ID）
 */
export function buildView(g: Subgraph, hidden: ReadonlySet<ViewKind>, expanded: ReadonlySet<string>): { nodes: ViewNode[]; edges: ViewEdge[]; groups: number } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const neighbors = new Map<string, Set<string>>();
  for (const l of g.links) {
    for (const [a, z] of [[l.source, l.target], [l.target, l.source]] as const) setOf(neighbors, a).add(z);
  }
  // 每个攻击源的「目标」：只连着一台设备、没有关联事件和处置
  const owned = new Map<string, GraphNode[]>();
  for (const n of g.nodes) {
    if (n.kind !== "attacker") continue;
    const ns = [...(neighbors.get(n.id) ?? [])].map((id) => byId.get(id)?.kind);
    if (ns.some((k) => k === "incident" || k === "playbook")) continue;
    const targets = [...(neighbors.get(n.id) ?? [])].filter((id) => {
      const k = byId.get(id)?.kind;
      return k === "camera" || k === "device";
    });
    const owner = targets[0];
    if (targets.length !== 1 || owner === undefined) continue;
    listOf(owned, owner).push(n);
  }
  const groupOf = new Map<string, string>();
  const groupNodes: ViewNode[] = [];
  for (const [owner, ips] of owned) {
    if (ips.length < GROUP_MIN || expanded.has(owner)) continue;
    const gid = `grp:${owner}`;
    for (const ip of ips) groupOf.set(ip.id, gid);
    const total = ips.reduce((s, ip) => s + (ip.props.alerts ?? 0), 0);
    groupNodes.push({
      id: gid, kind: "attacker_group", label: `${ips.length} 个攻击源`, members: ips, depth: (byId.get(owner)?.depth ?? 0) + 1,
      center: false, alarm: ips.some(isAlarm), weak: ips.every(isWeak), badges: total ? [`${total} 次`] : [],
    });
  }

  const visible = (n: GraphNode) => n.id === g.center || !hidden.has(n.kind);
  const nodes: ViewNode[] = [];
  for (const n of g.nodes) {
    if (groupOf.has(n.id) || !visible(n)) continue;
    nodes.push({
      id: n.id, kind: n.kind, label: displayName(n), node: n, depth: n.depth, center: n.id === g.center,
      alarm: isAlarm(n), weak: isWeak(n) && n.id !== g.center, badges: badgesOf(n),
    });
  }
  if (!hidden.has("attacker_group") && !hidden.has("attacker")) nodes.push(...groupNodes);
  const shown = new Set(nodes.map((n) => n.id));

  const merged = new Map<string, ViewEdge>();
  for (const l of g.links) {
    const s = groupOf.get(l.source) ?? l.source;
    const t = groupOf.get(l.target) ?? l.target;
    if (s === t || !shown.has(s) || !shown.has(t)) continue;
    const id = `${s}>${t}:${l.kind}`;
    const prev = merged.get(id);
    if (prev) {
      prev.count += l.count;
      prev.lastSeen = Math.max(prev.lastSeen, l.lastSeen);
      prev.firstSeen = prev.firstSeen && l.firstSeen ? Math.min(prev.firstSeen, l.firstSeen) : prev.firstSeen || l.firstSeen;
      prev.weak &&= l.weak;
    } else {
      merged.set(id, { id, source: s, target: t, kind: l.kind, count: l.count, firstSeen: l.firstSeen, lastSeen: l.lastSeen, weak: l.weak });
    }
  }
  return { nodes, edges: [...merged.values()], groups: groupNodes.length };
}

// ── 关联归纳 ──

export type ReasonKind = "attacker" | "incident";

export interface Reason {
  kind: ReasonKind;
  /** 经由的攻击源或关联事件 */
  via: GraphNode;
  lastSeen: number;
}

export interface Relation {
  device: GraphNode;
  reasons: Reason[];
  strength: number;
}

export const REASON_LABEL: Record<ReasonKind, string> = { attacker: "同一攻击源", incident: "同一起关联事件" };
const REASON_WEIGHT: Record<ReasonKind, number> = { incident: 100, attacker: 80 };

export interface RelationStats {
  attackers: GraphNode[];
  /** 网络告警总数（攻击源 → 主体的连线计数之和） */
  attacks: number;
  attackTypes: GraphNode[];
  techniques: GraphNode[];
  incidents: GraphNode[];
  blocked: GraphNode[];
  scenes: GraphNode[];
  relations: Relation[];
}

/** 以中心点为主体，归纳攻击情况与关联设备 */
export function analyze(g: Subgraph): RelationStats {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const adj = new Map<string, GraphLink[]>();
  for (const l of g.links) {
    for (const end of [l.source, l.target]) listOf(adj, end).push(l);
  }
  const other = (l: GraphLink, me: string) => (l.source === me ? l.target : l.source);
  const c = g.center;
  const mine = (kind: NodeKind, via?: LinkKind) =>
    uniq((adj.get(c) ?? []).filter((l) => !via || l.kind === via).map((l) => byId.get(other(l, c))).filter((n): n is GraphNode => n?.kind === kind));
  const attackers = mine("attacker", "attacked");
  const attacks = (adj.get(c) ?? []).filter((l) => l.kind === "attacked").reduce((s, l) => s + l.count, 0);
  const attackTypes = uniq(attackers.flatMap((a) => (adj.get(a.id) ?? []).filter((l) => l.kind === "launched").map((l) => byId.get(l.target)))
    .filter((n): n is GraphNode => n?.kind === "attack"));
  const techniques = uniq(attackTypes.flatMap((a) => (adj.get(a.id) ?? []).filter((l) => l.kind === "maps_to").map((l) => byId.get(l.target)))
    .filter((n): n is GraphNode => n?.kind === "technique"));
  const incidents = mine("incident", "involves");
  const blocked = attackers.filter((a) => a.props.blocked === "contained");

  const rel = new Map<string, Relation>();
  const add = (id: string, r: Reason) => {
    const d = byId.get(id);
    if (!d || (d.kind !== "camera" && d.kind !== "device") || id === c) return;
    const cur = rel.get(id) ?? { device: d, reasons: [], strength: 0 };
    if (!cur.reasons.some((x) => x.kind === r.kind && x.via.id === r.via.id)) cur.reasons.push(r);
    cur.strength = Math.max(cur.strength, REASON_WEIGHT[r.kind]);
    rel.set(id, cur);
  };
  for (const a of attackers) {
    if (a.props.monitorOnly) continue;
    for (const l of adj.get(a.id) ?? []) if (l.kind === "attacked") add(other(l, a.id), { kind: "attacker", via: a, lastSeen: l.lastSeen });
  }
  for (const i of incidents) {
    for (const l of adj.get(i.id) ?? []) if (l.kind === "involves") add(other(l, i.id), { kind: "incident", via: i, lastSeen: l.lastSeen });
  }
  const relations = [...rel.values()].sort((a, b) => b.strength - a.strength || b.reasons.length - a.reasons.length);
  return { attackers, attacks, attackTypes, techniques, incidents, blocked, scenes: mine("scene", "detected"), relations };
}

function listOf<K, V>(m: Map<K, V[]>, k: K): V[] {
  let v = m.get(k);
  if (!v) m.set(k, (v = []));
  return v;
}

function setOf<K, V>(m: Map<K, Set<V>>, k: K): Set<V> {
  let v = m.get(k);
  if (!v) m.set(k, (v = new Set()));
  return v;
}

function uniq(xs: GraphNode[]) {
  return [...new Map(xs.map((x) => [x.id, x])).values()];
}

/** 叙述式摘要 */
export function narrative(name: string, s: RelationStats): string {
  const parts: string[] = [];
  if (s.attackers.length) {
    const types = s.attackTypes.slice(0, 3).map((t) => t.label).join("、");
    let line = `近 24 小时，${name} 遭到 ${s.attackers.length} 个攻击源的 ${s.attacks} 次网络攻击`;
    if (types) line += `（${types}${s.attackTypes.length > 3 ? " 等" : ""}）`;
    if (s.techniques.length) line += `，对应 ATT&CK ${s.techniques.map((t) => t.label).join("、")}`;
    parts.push(line);
  } else {
    parts.push(`近 24 小时，${name} 没有网络攻击记录`);
  }
  if (s.incidents.length) {
    const open = s.incidents.filter((i) => i.props.incident?.status === "open").length;
    parts.push(`形成 ${s.incidents.length} 起关联事件${open ? `，${open} 起未处置` : ""}`);
  }
  if (s.blocked.length) parts.push(`已封禁 ${s.blocked.length} 个攻击源`);
  let text = parts.join("，") + "。";
  if (s.scenes.length) {
    text += `画面上检测到${s.scenes.map((n) => `${n.label} ${n.props.alerts ?? 1} 次`).join("、")}。`;
  }
  if (s.relations.length) {
    const viaAttacker = s.relations.filter((r) => r.reasons.some((x) => x.kind === "attacker")).map((r) => r.device.label);
    const viaIncident = s.relations.filter((r) => r.reasons.some((x) => x.kind === "incident")).map((r) => r.device.label);
    const bits: string[] = [];
    if (viaAttacker.length) bits.push(`同一攻击源还攻击了 ${listNames(viaAttacker)}`);
    if (viaIncident.length) bits.push(`与 ${listNames(viaIncident)} 同在一起关联事件中`);
    text += bits.join("；") + "。";
  } else if (s.attackers.length) {
    text += "没有发现攻击波及其他设备。";
  }
  return text;
}

function listNames(xs: string[]) {
  return xs.length > 4 ? `${xs.slice(0, 4).join("、")} 等 ${xs.length} 台设备` : xs.join("、");
}

// ── 点与边的说明 ──

export interface Fact {
  label: string;
  value: string;
  tone?: "danger" | "warning" | "muted";
}

export function formatAt(t: number): string {
  if (!t) return "";
  const d = new Date(t);
  const today = new Date();
  const time = d.toLocaleTimeString("zh-CN", { hour12: false });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }).replace("/", "-")} ${time}`;
}

export function ago(t: number, now = Date.now()): string {
  if (!t) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 点的说明：标题、副标题、若干条事实。degree：连着多少台设备 */
export function describe(n: GraphNode, degree: number): { title: string; subtitle: string; facts: Fact[] } {
  const p = n.props;
  const facts: Fact[] = [];
  const push = (label: string, value: string | undefined, tone?: Fact["tone"]) => {
    if (value) facts.push({ label, value, tone });
  };
  let subtitle: string = KIND_LABEL[n.kind];
  switch (n.kind) {
    case "camera":
    case "device": {
      const d = p.device;
      if (!d) {
        subtitle = "未登记的地址";
        push("地址", p.ip);
        push("说明", "告警指向的地址没有登记为设备", "muted");
        break;
      }
      subtitle = `${TYPE_LABEL[d.type]} · ${d.id}`;
      push("名称", d.name);
      push("地址", d.ip);
      push("状态", DEVICE_STATE[d.state], d.state === "normal" ? undefined : d.state === "contained" ? undefined : "danger");
      if (d.alert_severity) push("告警等级", SEVERITY_LABEL[d.alert_severity], "danger");
      push("部署方式", d.mode === "bypass" ? "旁路" : "主机探针");
      break;
    }
    case "attacker":
      subtitle = "外部攻击源";
      push("地址", p.ip);
      push("网络告警", p.alerts ? `${p.alerts} 条` : undefined);
      if (degree > 1) push("攻击过的设备", `${degree} 台`, "warning");
      push("最高等级", p.severity && SEVERITY_LABEL[p.severity], p.severity === "critical" || p.severity === "high" ? "danger" : undefined);
      if (p.blocked) push("处置", EXECUTION_STATE[p.blocked], p.blocked === "contained" ? undefined : "warning");
      if (p.monitorOnly) push("说明", "全部来自监视模式的规则：只显示，不参与关联与处置", "muted");
      break;
    case "attack":
      subtitle = `网络攻击 · ${p.ruleId}`;
      push("签名", p.summary !== n.label ? p.summary : undefined);
      push("ATT&CK", p.technique);
      push("告警", p.alerts ? `${p.alerts} 条` : undefined);
      push("最高等级", p.severity && SEVERITY_LABEL[p.severity]);
      if (p.monitorOnly) push("说明", "监视模式的规则：只显示，不参与关联与处置", "muted");
      break;
    case "technique":
      subtitle = "MITRE ATT&CK 技术";
      push("编号", p.technique);
      break;
    case "incident": {
      const i = p.incident;
      if (!i) break;
      subtitle = `关联事件 · ${i.rule_id}`;
      push("等级", SEVERITY_LABEL[i.severity], i.severity === "critical" || i.severity === "high" ? "danger" : undefined);
      push("状态", INCIDENT_STATUS[i.status], i.status === "open" ? "warning" : undefined);
      push("攻击源", i.source_ip ?? "无（纯视觉规则）");
      push("涉及设备", i.device_ids.join("、"));
      push("ATT&CK", i.techniques.join("、"));
      push("战术", i.tactics.join("、"));
      if (i.requires_confirmation) push("处置", "命中路径含模型判定，须人工确认", "warning");
      push("命中事件", `${i.hit_path.length} 条`);
      break;
    }
    case "playbook": {
      const e = p.execution;
      if (!e) break;
      subtitle = `处置 · ${e.playbook_id}`;
      push("目标", e.target);
      push("状态", EXECUTION_STATE[e.state], e.state === "failed" || e.state === "expired" ? "danger" : undefined);
      push("原因", e.reason ?? undefined, "muted");
      if (e.verify_result) push("效果校验", e.verify_result.passed ? "通过" : `未通过${e.verify_result.reason ? `：${e.verify_result.reason}` : ""}`, e.verify_result.passed ? undefined : "danger");
      push("到期", e.expires_at ? formatAt(ms(e.expires_at)) : undefined);
      break;
    }
    case "scene":
      subtitle = `画面事件 · ${p.cameraId}`;
      push("次数", p.alerts ? `${p.alerts} 次` : undefined);
      if (p.suspected) push("其中疑似", `${p.suspected} 次`, "muted");
      break;
  }
  const first = p.firstSeen ?? 0;
  const last = p.lastSeen ?? 0;
  if (first) push("第一次出现", `${ago(first)}（${formatAt(first)}）`);
  if (last && last !== first) push("最近一次", `${ago(last)}（${formatAt(last)}）`);
  return { title: displayName(n), subtitle, facts };
}

/** 关系的说明：「10.0.0.66 攻击了 cam-01，共 37 次，最近一次 3 分钟前」 */
export function describeEdge(e: ViewEdge, from?: string, to?: string): string {
  const verb = EDGE_VERB[e.kind] ?? "关联";
  const times = e.count > 1 ? `，共 ${e.count} 次` : "";
  const when = e.lastSeen ? `，最近一次 ${ago(e.lastSeen)}` : "";
  const weak = e.weak ? "（监视模式或疑似，不作为关联依据）" : "";
  return `${from ?? e.source} ${verb} ${to ?? e.target}${times}${when}${weak}`;
}

/** 每个点连着多少台设备（攻击源打过几台、关联事件涉及几台） */
export function deviceDegree(g: Subgraph): Map<string, number> {
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const out = new Map<string, Set<string>>();
  for (const l of g.links) {
    for (const [a, z] of [[l.source, l.target], [l.target, l.source]] as const) {
      const k = kind.get(z);
      if (k === "camera" || k === "device") setOf(out, a).add(z);
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.size]));
}
