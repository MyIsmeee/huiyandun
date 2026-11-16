import { toast } from "sonner";
import { create } from "zustand";
import { api, ApiError } from "../lib/api";
import type { components } from "../api/schema";
import { useDraft } from "./draft";

export type CameraRule = components["schemas"]["CameraRule"];
type RuleType = CameraRule["type"];

/**
 * 场景页的轨迹规则（区域入侵、有向越线）：几何为区域平面坐标（米），与目标位置同一坐标系。
 * 规则属于摄像头，经 PATCH /api/cameras/{id} 整体保存、立即生效（随登记表下发给 vision-engine），不随场景草稿保存
 */
interface RuleState {
  /** 规则面板是否打开 */
  open: boolean;
  /** 正在编辑规则的摄像头及其已保存的规则 */
  cameraId: string | null;
  rules: CameraRule[];
  loading: boolean;
  /** 规则读取失败：rules 不是该摄像头的实际规则，任何修改都会整体覆盖它们，须重读成功后才能编辑 */
  failed: boolean;
  /** 正在绘制的规则：类型与已点下的顶点 */
  drawing: { type: RuleType; points: [number, number][] } | null;
  saving: boolean;
}

export const useRules = create<RuleState>(() => ({
  open: false,
  cameraId: null,
  rules: [],
  loading: false,
  failed: false,
  drawing: null,
  saving: false,
}));

/** 顶点吸附到 0.1 m；相邻两点至少相隔这么远（服务端 MIN_EDGE_M） */
const SNAP_M = 0.1;
/** 越线与区域的最少顶点数 */
export const MIN_POINTS: Record<RuleType, number> = { intrusion: 3, line_crossing: 2 };
/** 每台摄像头的规则数与每条规则的顶点数上限（契约 CameraUpdate.rules、camera_rule.points 的 maxItems） */
export const MAX_RULES = 32;
export const MAX_POINTS = 32;
export const RULE_TYPE: Record<RuleType, string> = { intrusion: "区域入侵", line_crossing: "越线" };

export const snap = (v: number) => Math.round(v / SNAP_M) * SNAP_M;

/** 打开面板时重读所选摄像头的规则：面板关着期间别人可能改过，按旧列表修改会整体覆盖对方的修改 */
export function toggleRules(open?: boolean) {
  const { open: was, cameraId } = useRules.getState();
  const next = open ?? !was;
  useRules.setState({ open: next, drawing: null });
  if (next && !was && cameraId) void selectRuleCamera(cameraId);
}

/** 选择摄像头并载入其规则；null 为不选（区域内没有摄像头） */
export async function selectRuleCamera(cameraId: string | null) {
  useRules.setState({ cameraId, rules: [], drawing: null, loading: cameraId !== null, failed: false });
  if (cameraId === null) return;
  try {
    const camera = (await api.listCameras()).items.find((c) => c.id === cameraId);
    if (useRules.getState().cameraId === cameraId) useRules.setState({ rules: camera?.rules ?? [], loading: false });
  } catch {
    if (useRules.getState().cameraId !== cameraId) return;
    useRules.setState({ loading: false, failed: true });
    toast.error("规则读取失败");
  }
}

/** 规则已载入、可以修改：读取中或读取失败时的列表不是实际规则，保存会覆盖掉它们 */
export const editable = (s: RuleState) => s.cameraId !== null && !s.loading && !s.failed && !s.saving;

/** 开始绘制：退出模型与摄像头放置、取消选中物体，绘制时点地面只加顶点 */
export function startDrawing(type: RuleType) {
  if (!editable(useRules.getState())) return;
  useDraft.setState({ tool: null, selected: null });
  useRules.setState({ drawing: { type, points: [] } });
}

// 绘制中又从模型库选了模型或摄像头：以放置为准，取消绘制，两种操作不同时生效
useDraft.subscribe((s, prev) => {
  if (s.tool !== null && prev.tool === null && useRules.getState().drawing) cancelDrawing();
});

const far = (a: readonly number[] | undefined, b: readonly number[]) =>
  !a || Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0)) >= SNAP_M - 1e-9;

/** 加一个顶点：与上一点重合（服务端拒收）时忽略；到达顶点上限时不再加并提示 */
export function addPoint(x: number, y: number) {
  const { drawing } = useRules.getState();
  if (!drawing) return;
  if (drawing.points.length >= MAX_POINTS) {
    toast.warning(`每条规则最多 ${MAX_POINTS} 个顶点`, { id: "rule-max-points" });
    return;
  }
  const point: [number, number] = [snap(x), snap(y)];
  if (!far(drawing.points.at(-1), point)) return;
  useRules.setState({ drawing: { ...drawing, points: [...drawing.points, point] } });
}

export function undoPoint() {
  useRules.setState((s) => (s.drawing ? { drawing: { ...s.drawing, points: s.drawing.points.slice(0, -1) } } : {}));
}

export function cancelDrawing() {
  useRules.setState({ drawing: null });
}

/** 新规则的编号：类型前缀加最小未用序号 */
function nextId(rules: CameraRule[], type: RuleType): string {
  const prefix = type === "intrusion" ? "zone" : "line";
  for (let i = 1; ; i += 1) if (!rules.some((r) => r.id === `${prefix}-${i}`)) return `${prefix}-${i}`;
}

/** 多边形面积（鞋带公式，取绝对值） */
const area = (points: [number, number][]) =>
  Math.abs(points.reduce((sum, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length] as [number, number];
    return sum + x * ny - nx * y;
  }, 0)) / 2;

/** 两线段是否相交（含端点接触与共线重叠） */
function crosses(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const side = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const within = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 && Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  const [d1, d2, d3, d4] = [side(c, d, a), side(c, d, b), side(a, b, c), side(a, b, d)];
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (d1 === 0 && within(c, d, a)) || (d2 === 0 && within(c, d, b)) || (d3 === 0 && within(a, b, c)) || (d4 === 0 && within(a, b, d));
}

/**
 * 区域多边形能否作为规则：顶点不共线（面积不为 0）、边不自交，首尾两点不重合。
 * 共线的区域永远判不到"在区内"；自交时控制台的填充与视觉引擎的判定范围不一致。返回不合格的原因，合格为 null
 */
export function polygonProblem(points: [number, number][]): string | null {
  if (!far(points[0], points.at(-1) ?? [0, 0]) && points.length > 1) return "区域的首尾两点不能重合";
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // 相邻两边共用顶点，不算相交
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const [a, b, c, d] = [points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]] as [number, number][];
      if (a && b && c && d && crosses(a, b, c, d)) return "区域的边不能交叉";
    }
  }
  // 自交在前判断：对称的"8"字形面积相消为 0，按共线提示会说错原因
  if (area(points) < 1e-3) return "区域的顶点不能在一条直线上";
  return null;
}

/** 完成绘制：按名称加入规则并保存；顶点不足时不保存，区域不合格或规则数已满时提示原因、不保存 */
export async function finishDrawing(name: string): Promise<boolean> {
  const { drawing, rules, saving } = useRules.getState();
  if (!drawing || saving || drawing.points.length < MIN_POINTS[drawing.type]) return false;
  const problem =
    rules.length >= MAX_RULES ? `每台摄像头最多 ${MAX_RULES} 条规则` : drawing.type === "intrusion" ? polygonProblem(drawing.points) : null;
  if (problem) {
    toast.error(problem);
    return false;
  }
  const rule: CameraRule = {
    id: nextId(rules, drawing.type),
    name: name.trim() || `${RULE_TYPE[drawing.type]} ${rules.length + 1}`,
    type: drawing.type,
    points: drawing.points,
    direction: "any",
    classes: ["person"],
    min_duration_s: 1,
  };
  const saved = await save([...rules, rule]);
  if (saved) useRules.setState({ drawing: null });
  return saved;
}

export const removeRule = (id: string) => save(useRules.getState().rules.filter((r) => r.id !== id));

/** 越线方向依次切换：双向 → 正向 → 反向 */
const NEXT: Record<CameraRule["direction"], CameraRule["direction"]> = { any: "forward", forward: "backward", backward: "any" };
export const cycleDirection = (id: string) => save(useRules.getState().rules.map((r) => (r.id === id ? { ...r, direction: NEXT[r.direction] } : r)));

async function save(rules: CameraRule[]): Promise<boolean> {
  const state = useRules.getState();
  const { cameraId } = state;
  if (!cameraId || !editable(state)) return false;
  useRules.setState({ saving: true });
  try {
    const camera = await api.updateCamera(cameraId, { rules });
    // 保存期间换了摄像头：返回的是原摄像头的规则，不写进当前摄像头的列表
    useRules.setState(useRules.getState().cameraId === cameraId ? { rules: camera.rules, saving: false } : { saving: false });
    toast.success("规则已保存，视觉引擎随即生效");
    return true;
  } catch (e) {
    useRules.setState({ saving: false });
    toast.error(e instanceof ApiError ? e.message : "规则保存失败");
    return false;
  }
}

/** 越线的正方向箭头：每段中点，指向正向穿越的目标一侧：平面 (dy, −dx)，即视觉引擎左法向 (−dy, dx) 的反侧；俯视 y 向下时为前进方向的左侧，长度 len 米 */
export function directionArrows(points: [number, number][], len = 0.8): { from: [number, number]; to: [number, number] }[] {
  return points.slice(1).flatMap((b, i) => {
    const a = points[i] as [number, number];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const n = Math.hypot(dx, dy);
    if (n === 0) return [];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return [{ from: mid, to: [mid[0] + (dy / n) * len, mid[1] - (dx / n) * len] as [number, number] }];
  });
}
