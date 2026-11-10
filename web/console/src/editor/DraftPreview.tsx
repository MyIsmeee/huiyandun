import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BufferGeometry, Float32BufferAttribute, type LineSegments } from "three";
import { AssetModels } from "../scene/AreaScene";
import { useCatalog } from "../scene/assets";
import { ACCENT } from "../scene/targets";
import { useDraft } from "./draft";
import { extent } from "./placement";

/** 未接受的初稿（设计 150 §7）：半透明模型 + 强调色虚线占地轮廓，不投射阴影、不接收点选 */
export function DraftPreview() {
  const pending = useDraft((s) => s.pending);
  const catalog = useCatalog();
  const ref = useRef<LineSegments>(null);
  const geometry = useMemo(() => {
    const points: number[] = [];
    for (const item of pending) {
      const [x0, y0, x1, y1] = extent(item, catalog);
      points.push(x0, 0, y0, x1, 0, y0, x1, 0, y0, x1, 0, y1, x1, 0, y1, x0, 0, y1, x0, 0, y1, x0, 0, y0);
    }
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
  }, [pending, catalog]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  // 虚线按顶点累计长度绘制
  useLayoutEffect(() => void ref.current?.computeLineDistances(), [geometry]);
  if (pending.length === 0) return null;
  return (
    <>
      <AssetModels items={pending} ghost />
      <lineSegments ref={ref} geometry={geometry} position-y={0.03} raycast={() => undefined}>
        <lineDashedMaterial color={ACCENT} dashSize={0.3} gapSize={0.2} />
      </lineSegments>
    </>
  );
}
