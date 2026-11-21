import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { BufferGeometry, DoubleSide, Float32BufferAttribute, SRGBColorSpace, Texture } from "three";
import { create } from "zustand";
import type { SceneFrame } from "../editor/recognition";

/**
 * 实景底图（态势页"实景"视图）：视觉引擎把去除人员后的画面贴在逐点三维位置上（vision_engine/backdrop.py），
 * 场景里有什么就显示什么，不受低模资产库的限制。每台摄像头一张，前后景之间的深度突变、人员所在处留空。
 * 只从拍摄它的摄像头一侧看起来完整，转到背面会看到空洞；需要整洁的示意时切回"白模"。
 */

export type Backdrop = NonNullable<SceneFrame["backdrop"]>;

/**
 * 视图模式：model 为按实测尺寸摆放的白模（默认），photo 为实景底图；选择保存在本机。
 * 实景只从摄像头一侧看起来完整，人员所在处留空，演示时默认白模，实景只作可选
 */
export type SceneMode = "photo" | "model";
const MODE_KEY = "hyd.scene-mode";
const stored = (): SceneMode => {
  try {
    return localStorage.getItem(MODE_KEY) === "photo" ? "photo" : "model";
  } catch {
    return "model";
  }
};
export const useSceneMode = create<{ mode: SceneMode }>()(() => ({ mode: stored() }));
export function toggleSceneMode() {
  const mode: SceneMode = useSceneMode.getState().mode === "photo" ? "model" : "photo";
  useSceneMode.setState({ mode });
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // 无痕模式等不可写时只在本次会话内生效
  }
}

/** base64 位图的第 k 位（每字节高位在前） */
const bit = (bytes: Uint8Array, k: number) => ((bytes[k >> 3] ?? 0) >> (7 - (k & 7))) & 1;

/**
 * 网格几何：点 (i, j) 的位置为 points 中的 (x, 高度, y)，贴图坐标为画面归一化坐标 ((j + 0.5) / cols, (i + 0.5) / rows)
 * （贴图 v 轴朝上，取 1 − 行坐标）；保留的格子各拆成两个三角形
 */
export function backdropGeometry({ cols, rows, points, quads }: Backdrop): BufferGeometry {
  const uv = new Float32Array(rows * cols * 2);
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      uv[(i * cols + j) * 2] = (j + 0.5) / cols;
      uv[(i * cols + j) * 2 + 1] = 1 - (i + 0.5) / rows;
    }
  const bytes = Uint8Array.from(atob(quads), (c) => c.charCodeAt(0));
  const index: number[] = [];
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < cols - 1; j++) {
      if (!bit(bytes, i * (cols - 1) + j)) continue;
      const a = i * cols + j;
      const [b, c, d] = [a + 1, a + cols + 1, a + cols];
      index.push(a, d, b, b, d, c);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(points, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

function BackdropMesh({ backdrop }: { backdrop: Backdrop }) {
  // 按需渲染：画面解码完成后请求一帧
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => backdropGeometry(backdrop), [backdrop]);
  const texture = useMemo(() => {
    const image = new Image();
    const map = new Texture(image);
    map.colorSpace = SRGBColorSpace;
    image.onload = () => {
      map.needsUpdate = true;
      invalidate();
    };
    image.src = `data:image/jpeg;base64,${backdrop.image}`;
    return map;
  }, [backdrop.image, invalidate]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh geometry={geometry} renderOrder={-1}>
      {/* 不受光照：画面本身带着现场的明暗 */}
      <meshBasicMaterial map={texture} side={DoubleSide} toneMapped={false} />
    </mesh>
  );
}

export function BackdropScene({ frames }: { frames: SceneFrame[] }) {
  return (
    <>
      {frames.map((frame) => frame.backdrop && <BackdropMesh key={frame.camera_id} backdrop={frame.backdrop} />)}
    </>
  );
}
