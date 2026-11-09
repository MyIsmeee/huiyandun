import { Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError, api, type SceneArea } from "../lib/api";
import { applySite } from "../store/live";
import { areaPlacements } from "./cameras";
import { isDirty, loadDraft, savedDraft, useDraft } from "./draft";

/** 重新读取站点并载入该区域的最新内容，丢弃未保存的修改 */
async function reload(areaId: string) {
  const site = await api.getSite();
  applySite(site);
  const area = site.areas.find((a) => a.id === areaId);
  if (area) loadDraft(area, areaPlacements(site.devices, areaId));
}

/**
 * 保存（设计 150 E-7）：整体 PUT 名称、尺寸、物体与草稿中本区域全部摄像头的位置朝向（未列出的移出区域），带回载入时的 updated_at。
 * 409 提示"场景已被其他人修改"并可重新载入；放置点超出区域等 400 原样显示服务端指出的原因（D-125）
 */
export function SaveButton({ area }: { area: SceneArea }) {
  const dirty = useDraft(isDirty);
  const [pending, setPending] = useState(false);

  async function save() {
    const { items, cameras, updatedAt } = useDraft.getState();
    setPending(true);
    try {
      const saved = await api.saveSceneArea(area.id, {
        name: area.name,
        width_m: area.width_m,
        depth_m: area.depth_m,
        items,
        cameras,
        updated_at: updatedAt,
      });
      savedDraft(saved, cameras);
      toast.success("已保存，态势页随后更新");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error("场景已被其他人修改", {
          description: "重新载入会丢弃本页未保存的修改",
          action: { label: "重新载入", onClick: () => void reload(area.id).catch(() => toast.error("无法连接服务器，请重试")) },
        });
      } else toast.error(e instanceof ApiError ? e.message : "无法连接服务器，请重试");
    }
    setPending(false);
  }

  return (
    <Button size="sm" disabled={!dirty || pending} onClick={() => void save()}>
      <Save aria-hidden />
      {pending ? "保存中…" : "保存"}
    </Button>
  );
}
