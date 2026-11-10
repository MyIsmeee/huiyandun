import { ScanEye } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, api, type SceneArea } from "../lib/api";
import { loadCatalog, type SceneItem, useCatalog } from "../scene/assets";
import { acceptDraft, discardDraft, proposeDraft, sameCameras, useDraft } from "./draft";
import { overlaps } from "./placement";
import { draftFromFrames } from "./recognition";

/**
 * 从画面生成初稿（设计 150 §7，FR-909）：取区域内摄像头 10 s 内的识别帧，避开页面上已有的物体（含未保存的）转换为草稿，
 * 叠加预览、不保存。没有识别帧的摄像头提示"暂无识别结果"。按区域挂载（key），换区域后不显示上一个区域的"生成中"
 */
export function DraftButton({ area }: { area: SceneArea }) {
  const [busy, setBusy] = useState(false);
  // 识别帧按已保存的摄像头位置投影到区域平面：页面上的位置与之不同时对不上，须先保存
  const outdated = () => {
    const s = useDraft.getState();
    return s.areaId !== area.id || !sameCameras(s.cameras, s.savedCameras);
  };

  async function generate() {
    if (outdated()) {
      toast.warning("摄像头位置有未保存的修改，请先保存再生成初稿");
      return;
    }
    setBusy(true);
    try {
      const [{ frames, stale }, { assets }] = await Promise.all([api.getSceneAreaFrames(area.id), loadCatalog()]);
      // 请求期间换了区域或又改了摄像头：结果已不对应本页，丢弃
      if (outdated()) return;
      const { items, cameras } = useDraft.getState();
      const draft = draftFromFrames(frames, cameras, [area.width_m, area.depth_m], items, assets);
      if (stale.length > 0) toast.warning(`${stale.join("、")} 暂无识别结果`);
      if (draft.length > 0) proposeDraft(draft);
      else if (frames.length > 0) toast.info("识别结果中没有可转换的物体，或都与已有物体重叠");
      else if (stale.length === 0) toast.info("区域内还没有摄像头");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "无法连接服务器，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void generate()}>
      <ScanEye aria-hidden />
      {busy ? "生成中…" : "从画面生成初稿"}
    </Button>
  );
}

/** 初稿工具条：件数、全部接受、放弃；接受后草稿成为普通物体，可逐个删改，保存时提交 */
export function DraftBar() {
  const catalog = useCatalog();
  const count = useDraft((s) => s.pending.length);
  if (count === 0) return null;

  const accept = () => {
    const { items, pending } = useDraft.getState();
    // 生成之后又放下的物体可能与草稿重叠：重叠的不接受
    const accepted: SceneItem[] = [];
    for (const item of pending) if (!overlaps(item, [...items, ...accepted], catalog)) accepted.push(item);
    acceptDraft(accepted);
    const skipped = pending.length - accepted.length;
    if (skipped > 0) toast.warning(`${skipped} 件与已有物体重叠，未接受`);
  };
  return (
    <div
      role="toolbar"
      aria-label="初稿"
      className="absolute top-3 left-3 flex items-center gap-2 rounded-lg border bg-card/90 py-1 pr-1 pl-3 text-meta text-muted-foreground backdrop-blur-sm"
    >
      <span className="text-foreground">初稿 {count} 件</span>
      <span>接受后可逐个删改，保存后生效</span>
      <Button size="sm" onClick={accept}>
        全部接受
      </Button>
      <Button variant="ghost" size="sm" onClick={discardDraft}>
        放弃
      </Button>
    </div>
  );
}
