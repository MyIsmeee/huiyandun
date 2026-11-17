import { useEffect, useState } from "react";
import { areaPlacements } from "../editor/cameras";
import { draftFromFrames, type SceneFrame } from "../editor/recognition";
import { api, type Site } from "../lib/api";
import { loadCatalog, type SceneItem } from "./assets";
import type { Area } from "./areas";

/** 自动识别结果的重新读取间隔：后台每 10 分钟识别一次，这里只读缓存，读得勤些以便首次识别后尽快显示 */
export const AUTO_POLL_MS = 60_000;

/**
 * 场景自动识别（态势页）：区域没有手工搭建的物体时，按 api-server 后台自动识别的结果生成物体直接显示，
 * 不写入区域、不必在场景页手动生成初稿。区域有了手工物体即以手工为准，返回 null
 */
export function useAutoItems(area: Area | null, devices: Site["devices"]): SceneItem[] | null {
  return useAutoScene(area, devices)?.items ?? null;
}

/** 自动识别的场景：识别帧（3D 按实测尺寸画白模）与转换出的物体（2D 降级视图用） */
export function useAutoScene(area: Area | null, devices: Site["devices"]): { frames: SceneFrame[]; items: SceneItem[] } | null {
  const [items, setItems] = useState<{ areaId: string; items: SceneItem[]; frames: SceneFrame[] } | null>(null);
  const manual = !area || area.items.length > 0;
  const areaId = area?.id ?? null;
  const size: [number, number] = [area?.width_m ?? 0, area?.depth_m ?? 0];
  const placements = areaId ? JSON.stringify(areaPlacements(devices, areaId)) : "";
  useEffect(() => {
    if (manual || !areaId) return;
    let alive = true;
    const load = async () => {
      try {
        const [{ frames }, { assets }] = await Promise.all([api.getSceneAreaAuto(areaId), loadCatalog()]);
        if (!alive) return;
        const cameras = JSON.parse(placements) as ReturnType<typeof areaPlacements>;
        setItems({ areaId, frames, items: draftFromFrames(frames, cameras, size, [], assets) });
      } catch {
        // 读取失败时保留上一次的结果，下个周期再试
      }
    };
    void load();
    const timer = setInterval(() => void load(), AUTO_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // size 以数值参与比较：区域尺寸变化时重新换算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, areaId, placements, size[0], size[1]]);
  if (manual || !items || items.areaId !== areaId) return null;
  return items;
}
