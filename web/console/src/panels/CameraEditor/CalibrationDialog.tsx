import { CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { components } from "../../api/schema";
import { ApiError, api } from "../../lib/api";
import { useLive } from "../../store/live";
import type { Snapshot } from "./CameraEditor";
import { CalibrationFrame, GroundPlan, type Pair } from "./CalibrationViews";

type Camera = components["schemas"]["Camera"];
type Fit = components["schemas"]["CalibrationFit"];
/** 对某一版标定点的检查结果：拟合误差，或拟合不了的原因 */
type Check = { pairs: Pair[]; outcome: Fit | string };

const MIN_PAIRS = 4;
const SUGGESTED_PAIRS = 6;
const MAX_PAIRS = 20;
/** 均方根误差超过 1 m 提示偏大，与定位误差的提示阈值一致（V-U1、D-025） */
const LARGE_ERROR_M = 1;
const CHECK_DELAY_MS = 300;
const button = buttonVariants({ variant: "outline", size: "sm" });
const failure = (e: unknown) => (e instanceof ApiError ? e.message : "无法连接服务器，请重试");

/**
 * 地面标定（V-CAM10、FR-910）：先在画面上点地面点，再在区域俯视图上点对应位置，两侧同一编号为一组。
 * 组数或数值变化 300 ms 后请服务端拟合，显示各组偏差与均方根误差；拟合不了时显示原因，不可保存。
 */
export function CalibrationDialog(props: {
  camera: Camera;
  areaId: string;
  snapshot: Snapshot;
  onClose: () => void;
  onSaved: (camera: Camera) => void;
}) {
  const { camera, areaId } = props;
  const site = useLive((s) => s.site);
  const area = site?.areas.find((a) => a.id === areaId) ?? null;
  const [pairs, setPairs] = useState<Pair[]>(() => camera.calibration as Pair[]);
  const [pending, setPending] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (pairs.length < MIN_PAIRS) return;
    let current = true;
    const timer = setTimeout(() => {
      api.checkCameraCalibration(camera.id, { area_id: areaId, points: pairs }).then(
        (fit) => current && setCheck({ pairs, outcome: fit }),
        (e: unknown) => current && setCheck({ pairs, outcome: failure(e) }),
      );
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [camera.id, areaId, pairs]);

  async function save(points: Pair[]) {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.saveCameraCalibration(camera.id, { area_id: areaId, points });
      toast.success("已保存标定");
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setMessage(failure(e)); // 409 等失败时保留已点的点
      setSaving(false);
    }
  }

  /** 未配对时再点画面即替换这个点 */
  function pickPixel(pixel: [number, number]) {
    if (pairs.length >= MAX_PAIRS) return setMessage(`最多 ${MAX_PAIRS} 组`);
    setPending(pixel);
  }

  /** 点有变化时，上一次的提示（如"最多 20 组"、保存失败的原因）已不再适用 */
  function update(next: Pair[]) {
    setPairs(next);
    setMessage(null);
  }

  function pickGround(ground: [number, number]) {
    if (!pending) return;
    update([...pairs, [...pending, ...ground]]);
    setPending(null);
  }

  function setGround(i: number, k: 2 | 3, value: number) {
    update(pairs.map((p, j) => (j === i ? (p.map((n, m) => (m === k ? value : n)) as Pair) : p)));
  }

  // 结果只对检查时的那一版点有效：点有变化时为 null，表示检查中
  const outcome = check?.pairs === pairs ? check.outcome : null;
  const fit = outcome !== null && typeof outcome !== "string" ? outcome : null;
  const worst = fit && fit.reproj_error_m > LARGE_ERROR_M ? fit.residuals_m.indexOf(Math.max(...fit.residuals_m)) : -1;
  const missing = MIN_PAIRS - pairs.length;
  const notice =
    missing > 0
      ? `还差 ${missing} 组`
      : typeof outcome === "string"
        ? outcome
        : !fit
          ? "正在检查…"
          : worst >= 0
            ? "误差偏大：检查偏差最大的一组"
            : pairs.length < SUGGESTED_PAIRS
              ? "建议 6 组以上，分散在画面远近、左右各处"
              : null;

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (!pending) return;
          e.preventDefault(); // Esc 先撤销未配对的点
          setPending(null);
        }}
        className="max-h-[calc(100%-2rem)] overflow-y-auto p-0 sm:max-w-6xl"
      >
        <div className="flex flex-col gap-3 p-6 text-sm">
          <header className="flex items-center justify-between">
            <DialogTitle className="text-base font-medium">
              地面标定 {camera.id}
              {area && ` · ${area.name}`}
            </DialogTitle>
            <button type="button" aria-label="关闭" onClick={props.onClose} className="grid size-8 place-items-center rounded-full hover:bg-secondary">
              <X aria-hidden className="size-4" />
            </button>
          </header>
          <p className="text-xs text-subtle-foreground">
            {pending ? `第 ${pairs.length + 1} 组：在右侧俯视图上点对应位置（Esc 撤销）` : "在左侧画面上点地面上的明显位置，如地砖角、路沿、立柱脚"}
          </p>

          <div className="grid grid-cols-2 items-start gap-4">
            <CalibrationFrame snapshot={props.snapshot} pairs={pairs} pending={pending} hover={hover} onPick={pickPixel} />
            {area ? (
              <GroundPlan area={area} pairs={pairs} hover={hover} onPick={pickGround} />
            ) : (
              <p className="grid aspect-video place-items-center rounded-lg border border-dashed border-border text-subtle-foreground">区域未载入</p>
            )}
          </div>

          <Table aria-label="标定点">
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>画面 (u, v)</TableHead>
                <TableHead>地面 x (m)</TableHead>
                <TableHead>地面 y (m)</TableHead>
                <TableHead>偏差</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {pairs.map(([u, v, x, y], i) => (
                <TableRow key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} className={i === worst ? "font-semibold" : undefined}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="tabular-nums">
                    {u}, {v}
                  </TableCell>
                  {([2, 3] as const).map((k) => (
                    <TableCell key={k}>
                      <Input
                        type="number"
                        step={0.1}
                        aria-label={`第 ${i + 1} 组地面 ${k === 2 ? "x" : "y"}`}
                        value={k === 2 ? x : y}
                        onChange={(e) => setGround(i, k, Number(e.target.value))}
                        className="h-8 w-24"
                      />
                    </TableCell>
                  ))}
                  <TableCell className="tabular-nums">{fit ? `${fit.residuals_m[i]?.toFixed(2)} m` : "—"}</TableCell>
                  <TableCell>
                    <button type="button" aria-label={`删除第 ${i + 1} 组`} onClick={() => update(pairs.filter((_, j) => j !== i))} className="grid size-7 place-items-center rounded-full hover:bg-secondary">
                      <X aria-hidden className="size-3.5" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p role="status" className="text-xs">
            {fit && `均方根误差 ${fit.reproj_error_m.toFixed(2)} m`}
            {fit && notice && " · "}
            {notice}
          </p>
          {message && (
            <p role="alert" className="flex items-center gap-1">
              <CircleAlert aria-hidden className="size-4" />
              {message}
            </p>
          )}
          <footer className="flex gap-2">
            <button type="button" onClick={props.onClose} className={`${button} ml-auto`}>
              取消
            </button>
            <button type="button" disabled={!fit || saving} onClick={() => void save(pairs)} className={buttonVariants({ size: "sm" })}>
              {saving ? "保存中…" : "保存"}
            </button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
