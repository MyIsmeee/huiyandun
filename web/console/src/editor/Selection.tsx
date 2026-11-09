import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import { BufferGeometry, Float32BufferAttribute, Plane, Vector3 } from "three";
import { AreaScene, type OnPick } from "../scene/AreaScene";
import { type SceneItem, useCatalog } from "../scene/assets";
import type { Area } from "../scene/layout";
import { ACCENT } from "../scene/targets";
import { replaceItem, selectItem, useDraft } from "./draft";
import { BLOCKED, extent, inside, overlaps } from "./placement";

const GROUND = new Plane(new Vector3(0, 1, 0), 0);
/** 指针射线与地面的交点（平面坐标）：按在楼顶上也取其下方的地面点，拖动不跳 */
function groundPoint(e: ThreeEvent<PointerEvent>): [number, number] | null {
  const hit = e.ray.intersectPlane(GROUND, new Vector3());
  return hit && [hit.x, hit.z];
}

/**
 * 可选中、拖动的区域场景（设计 150 E-4）：未在放置时，按下物体即选中，按住拖动按整米移动；
 * 松开时位置变了且不与其他物体重叠才算一步，重叠时回到原处。选中的物体四角显示强调色括框，重叠时转灰
 */
export function EditableScene({ area, items }: { area: Area; items: SceneItem[] }) {
  const catalog = useCatalog();
  const placing = useDraft((s) => s.tool !== null);
  const selected = useDraft((s) => s.selected);
  const [drag, setDrag] = useState<{ index: number; from: [number, number]; item: SceneItem } | null>(null);
  const shown = drag ? items.map((it, i) => (i === drag.index ? drag.item : it)) : items;
  const blocked = drag !== null && overlaps(drag.item, items, catalog, drag.index);
  const size: [number, number] = [area.width_m, area.height_m];

  // 在画布外松开同样结束拖动
  useEffect(() => {
    if (!drag) return;
    const end = () => {
      const original = items[drag.index];
      if (!blocked && original && JSON.stringify(drag.item) !== JSON.stringify(original)) replaceItem(drag.index, drag.item);
      setDrag(null);
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, [drag, blocked, items]);

  const pick: OnPick = (index, e) => {
    const item = items[index];
    const from = groundPoint(e);
    if (e.button !== 0 || !item || !from) return;
    e.stopPropagation();
    selectItem(index);
    setDrag({ index, from, item });
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    const original = drag && items[drag.index];
    const to = groundPoint(e);
    if (!drag || !original || !to) return;
    const next = { ...original, x: original.x + Math.round(to[0] - drag.from[0]), y: original.y + Math.round(to[1] - drag.from[1]) };
    if (inside(next, catalog, size)) setDrag({ ...drag, item: next });
  };

  const current = selected === null ? undefined : shown[selected];
  return (
    <>
      <AreaScene area={area} items={shown} onPick={placing ? undefined : pick} />
      {drag && (
        // 拖动中接收指针的地面：比区域大一圈，指针移出区域也能跟随
        <mesh rotation-x={-Math.PI / 2} position={[size[0] / 2, 0, size[1] / 2]} onPointerMove={move}>
          <planeGeometry args={[size[0] + 100, size[1] + 100]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {current && <Brackets item={current} color={blocked ? BLOCKED : ACCENT} />}
    </>
  );
}

/** 四角括框：围住物体全部占地，每角两段，长度取边长的四分之一（不超过 1 m） */
function Brackets({ item, color }: { item: SceneItem; color: string }) {
  const catalog = useCatalog();
  const geometry = useMemo(() => {
    const [x0, y0, x1, y1] = extent(item, catalog);
    const arm = Math.min(1, (x1 - x0) / 4, (y1 - y0) / 4);
    const points: number[] = [];
    const corners: [number, number, number, number][] = [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]];
    for (const [cx, cy, dx, dy] of corners) {
      points.push(cx, 0, cy, cx + dx * arm, 0, cy, cx, 0, cy, cx, 0, cy + dy * arm);
    }
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
  }, [item, catalog]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <lineSegments geometry={geometry} position-y={0.03} raycast={() => undefined}>
      <lineBasicMaterial color={color} />
    </lineSegments>
  );
}
