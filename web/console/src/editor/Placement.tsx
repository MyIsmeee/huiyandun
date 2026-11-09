import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useState } from "react";
import { DoubleSide } from "three";
import { AssetModels } from "../scene/AreaScene";
import { type SceneItem, useCatalog } from "../scene/assets";
import type { Camera } from "../scene/devices";
import { ACCENT } from "../scene/targets";
import { CameraPlacing } from "./CameraPlacing";
import { cameraTool, placeItem, useDraft } from "./draft";
import { BLOCKED, extent, inside, overlaps, snap, stroke } from "./placement";

type Rot = SceneItem["rot"];
const point = (e: ThreeEvent<PointerEvent | MouseEvent>): [number, number] => [e.point.x, e.point.z];

/**
 * 放置（设计 150 E-2、E-3）：选中模型后，指针处显示吸附网格的半透明预览与占地。
 * 普通物体单击放下，可连续放置，R 旋转 90°；线状资产（墙、围栏、道路）按下拖动画一段直线，松开时按网格分段生成。
 * 超出区域或与同层已有物体重叠时占地转灰，不放置
 */
export function Placement({ size, items, registry }: { size: [number, number]; items: SceneItem[]; registry: Camera[] }) {
  const catalog = useCatalog();
  const tool = useDraft((s) => s.tool);
  const asset = catalog.get(tool ?? "");
  const camera = registry.find((c) => c.id === cameraTool(tool));
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [rot, setRot] = useState<Rot>(0);
  /** 线状资产按下的位置；松开前为拖动中 */
  const [from, setFrom] = useState<[number, number] | null>(null);
  const preview = asset && (from && hover ? stroke(asset, from, hover) : hover && snap(asset, asset.line ? 0 : rot, hover, size));
  const valid = (item: SceneItem) => inside(item, catalog, size) && !overlaps(item, items, catalog);

  useEffect(() => {
    if (asset?.line) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || (e.target as Element).closest("input, textarea")) return;
      if (e.key === "r" || e.key === "R") setRot((r) => ((r + 90) % 360) as Rot);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asset]);
  // 线状资产在画布外松开同样结束：按松开前的预览生成
  useEffect(() => {
    if (!from) return;
    const end = () => {
      if (preview && valid(preview)) placeItem(preview);
      setFrom(null);
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  });
  if (camera) return <CameraPlacing camera={camera} size={size} />;
  if (!asset) return null;

  const box = preview && extent(preview, catalog);
  return (
    <>
      {/* 接收指针的地面：完全透明，比区域大一圈，拖动线状资产时指针移出区域也能跟随 */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[size[0] / 2, 0, size[1] / 2]}
        onPointerMove={(e) => setHover(point(e))}
        onPointerOut={() => !from && setHover(null)}
        onPointerDown={(e) => {
          if (e.button !== 0 || !asset.line) return;
          e.stopPropagation();
          setFrom(point(e));
          setHover(point(e));
        }}
        onClick={(e) => {
          // 按单击处计算，不依赖上一次指针移动的预览：直接单击同样放在指针下
          const placed = snap(asset, rot, point(e), size);
          if (e.button !== 0 || asset.line || !valid(placed)) return;
          e.stopPropagation();
          placeItem(placed);
        }}
      >
        <planeGeometry args={[size[0] + 40, size[1] + 40]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {preview && box && (
        <>
          <AssetModels items={[preview]} ghost />
          <mesh rotation-x={-Math.PI / 2} position={[(box[0] + box[2]) / 2, 0.01, (box[1] + box[3]) / 2]} raycast={() => undefined}>
            <planeGeometry args={[box[2] - box[0], box[3] - box[1]]} />
            <meshBasicMaterial color={valid(preview) ? ACCENT : BLOCKED} transparent opacity={0.3} depthWrite={false} />
          </mesh>
        </>
      )}
    </>
  );
}
