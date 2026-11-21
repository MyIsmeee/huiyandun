import { ArrowLeftRight, CircleAlert, MoveRight, Pentagon, Spline, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import type { Device } from "../store/live";
import {
  type CameraRule,
  cancelDrawing,
  cycleDirection,
  editable,
  finishDrawing,
  MAX_RULES,
  MIN_POINTS,
  RULE_TYPE,
  removeRule,
  selectRuleCamera,
  startDrawing,
  toggleRules,
  undoPoint,
  useRules,
} from "./rules";

const DIRECTION: Record<CameraRule["direction"], string> = { any: "双向", forward: "正向", backward: "反向" };

/**
 * 场景页右侧的轨迹规则面板：选择区域内的摄像头，列出其区域入侵与越线规则，新建（在地面上逐点绘制）、
 * 切换越线方向、删除；每次修改立即保存到该摄像头。未标定（按安装参数估算地面映射）的摄像头上，规则事件只作提示
 */
export function RulesPanel({ devices, areaId }: { devices: Device[]; areaId: string }) {
  const { cameraId, rules, loading, failed, drawing, saving } = useRules();
  const canEdit = useRules(editable);
  const cameras = devices.filter((d) => d.camera?.area_id === areaId);
  const camera = cameras.find((d) => d.id === cameraId);
  const first = cameras[0]?.id ?? null;
  const [name, setName] = useState("");

  // 打开时默认选第一台；换区域后所选摄像头不在区域内时重选，区域内没有摄像头时不选：
  // 不留上一区域摄像头的规则与绘制，否则它们画在本区域的地面上，完成绘制还会存到那台摄像头上
  useEffect(() => {
    if (!camera && cameraId !== first) void selectRuleCamera(first);
  }, [camera, cameraId, first]);

  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      // 输入法组合中的 Enter 是上屏，不是完成
      if (e.isComposing || e.key === "Process") return;
      const field = e.target instanceof Element ? e.target.closest("input, textarea, select, [contenteditable=true]") : null;
      const inName = field instanceof HTMLInputElement && field.dataset.ruleName !== undefined;
      // 其他输入框（模型搜索、新建区域对话框等）里的按键与绘制无关
      if (field && !inName) return;
      if (e.key === "Escape") {
        // 已处理：底下态势页的详情面板不再响应这次 Esc
        e.preventDefault();
        cancelDrawing();
      }
      if (e.key === "Backspace" && !inName) {
        e.preventDefault();
        undoPoint();
      }
      if (e.key === "Enter" && !useRules.getState().saving) void finishDrawing(name).then((ok) => ok && setName(""));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawing, name]);

  const enough = drawing ? drawing.points.length >= MIN_POINTS[drawing.type] : false;
  return (
    <aside aria-label="轨迹规则" className="absolute top-3 right-3 bottom-3 flex w-72 flex-col gap-3 rounded-lg border bg-card/95 p-3 text-sm shadow-sm backdrop-blur-sm">
      <header className="flex items-center gap-2">
        <h2 className="font-semibold">轨迹规则</h2>
        <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label="关闭规则面板" onClick={() => toggleRules(false)}>
          <X aria-hidden />
        </Button>
      </header>
      {cameras.length === 0 ? (
        <p className="text-muted-foreground">本区域还没有摄像头。规则按摄像头判定：先把摄像头放进区域。</p>
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-meta text-muted-foreground">摄像头</span>
            <select
              aria-label="摄像头"
              className="h-8 rounded-md border bg-background px-2"
              value={cameraId ?? ""}
              disabled={drawing !== null || saving}
              onChange={(e) => void selectRuleCamera(e.target.value)}
            >
              {cameras.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}（{d.id}）
                </option>
              ))}
            </select>
          </label>
          {camera?.camera?.mapping === "estimated" && (
            <p className="rounded-md border border-dashed border-uncertain px-2 py-1.5 text-meta text-muted-foreground">
              这台摄像头未标定，位置按安装参数估算：规则事件只在告警栏提示"疑似"，不触发物理告警。完成地面标定后才按确认告警。
            </p>
          )}
          {drawing ? (
            <div className="flex flex-col gap-2 rounded-md border p-2">
              <p className="font-medium">新建{RULE_TYPE[drawing.type]}</p>
              <p className="text-meta text-muted-foreground">
                在地面上单击依次点下{drawing.type === "intrusion" ? "区域顶点（至少 3 个）" : "线的各点（至少 2 个）"}，已点 {drawing.points.length} 个 ·{" "}
                <Kbd>Enter</Kbd> 完成 · <Kbd>⌫</Kbd> 撤销一点 · <Kbd>Esc</Kbd> 取消
              </p>
              {drawing.type === "line_crossing" && <p className="text-meta text-muted-foreground">沿箭头方向穿越为正向，逆着箭头穿越为反向。</p>}
              <input
                aria-label="规则名称"
                data-rule-name=""
                className="h-8 rounded-md border bg-background px-2"
                placeholder={`名称，如"${drawing.type === "intrusion" ? "库区" : "大门"}"`}
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={!enough || saving} onClick={() => void finishDrawing(name).then((ok) => ok && setName(""))}>
                  {saving && <Spinner />}完成
                </Button>
                <Button size="sm" variant="outline" disabled={drawing.points.length === 0} onClick={undoPoint}>
                  <Undo2 aria-hidden />
                  撤销一点
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelDrawing}>
                  取消
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!camera || !canEdit || rules.length >= MAX_RULES} onClick={() => startDrawing("intrusion")}>
                <Pentagon aria-hidden />
                新建区域
              </Button>
              <Button size="sm" variant="outline" disabled={!camera || !canEdit || rules.length >= MAX_RULES} onClick={() => startDrawing("line_crossing")}>
                <Spline aria-hidden />
                新建越线
              </Button>
              {rules.length >= MAX_RULES && <p className="text-meta text-muted-foreground">每台摄像头最多 {MAX_RULES} 条规则</p>}
            </div>
          )}
          {failed && (
            // 读取失败时不显示"没有规则"：列表不是实际规则，修改会整体覆盖它们
            <p role="alert" className="flex items-center gap-2 text-muted-foreground">
              <CircleAlert aria-hidden className="size-4" />
              规则读取失败
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => void selectRuleCamera(cameraId)}>
                重试
              </Button>
            </p>
          )}
          <ul aria-label="规则列表" className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
            {loading && <Spinner aria-label="规则读取中" />}
            {!loading && !failed && rules.length === 0 && <li className="text-muted-foreground">这台摄像头还没有规则</li>}
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{rule.name}</span>
                  <span className="block text-meta text-subtle-foreground">
                    {RULE_TYPE[rule.type]}
                    {rule.type === "intrusion" ? ` · 停留 ${rule.min_duration_s} s 告警` : ` · ${DIRECTION[rule.direction]}`}
                  </span>
                </span>
                {rule.type === "line_crossing" && (
                  <Button variant="ghost" size="icon" className="size-7" aria-label={`切换方向：${rule.name}`} disabled={!canEdit} onClick={() => void cycleDirection(rule.id)}>
                    {rule.direction === "any" ? <ArrowLeftRight aria-hidden /> : <MoveRight aria-hidden className={rule.direction === "backward" ? "rotate-180" : ""} />}
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="size-7" aria-label={`删除：${rule.name}`} disabled={!canEdit} onClick={() => void removeRule(rule.id)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}
