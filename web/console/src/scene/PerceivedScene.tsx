import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { SceneFrame } from "../store/live";
import { useTheme } from "../theme/store";
import { useMotion } from "./DeviceMarkers";
import type { Camera } from "./devices";
import { FADE_MS, PALETTE, type Palette, type SceneGeometry, STALE_OPACITY, sceneGeometry, useScenes } from "./perceived";

/** 各摄像头实时识别并投影的环境（§5.1 L1）；无识别结果即空白（UP-1） */
export function PerceivedScene({ cameras }: { cameras: Camera[] }) {
  const palette = PALETTE[useTheme((s) => s.theme)];
  return useScenes(cameras).map(({ frame, stale }) => (
    <CameraScene key={frame.camera_id} frame={frame} palette={palette} stale={stale} />
  ));
}

interface Layer {
  /** 递增编号，作渲染键：被取代的层保持挂载、继续淡出 */
  id: number;
  geometry: SceneGeometry;
  /** 已被新一帧取代，正在淡出 */
  retired: boolean;
}

/** 一台摄像头的场景：新帧到达时新旧两层交叉渐变 300 ms；降低动效或断线时瞬时替换（V-A4、V-U3） */
function CameraScene({ frame, palette, stale }: { frame: SceneFrame; palette: Palette; stale: boolean }) {
  const geometry = useMemo(() => sceneGeometry(frame, palette), [frame, palette]);
  const motion = useMotion();
  const [layers, setLayers] = useState<Layer[]>([{ id: 0, geometry, retired: false }]);
  // 帧变化时在渲染中调整状态（React 推荐的"随属性变化调整状态"写法），不经副作用
  const last = layers.at(-1);
  if (last?.geometry !== geometry) {
    const kept = motion ? layers.map((l) => ({ ...l, retired: true })) : [];
    setLayers([...kept, { id: (last?.id ?? 0) + 1, geometry, retired: false }]);
  }
  const remove = (gone: SceneGeometry) => setLayers((ls) => ls.filter((l) => l.geometry !== gone));
  return layers.map(({ id, ...layer }) => (
    <FadingLayer
      key={id}
      {...layer}
      opacity={stale ? STALE_OPACITY : 1}
      fade={motion && layers.length > 1}
      onGone={remove}
    />
  ));
}

function FadingLayer(props: Omit<Layer, "id"> & { opacity: number; fade: boolean; onGone: (geometry: SceneGeometry) => void }) {
  const { geometry, retired, opacity, fade, onGone } = props;
  const flat = useRef<MeshBasicMaterial>(null);
  const solid = useRef<MeshLambertMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  /** 渐变起点（秒，渲染时钟）：首次绘制或被取代后的首帧记录 */
  const start = useRef<number | null>(null);
  useEffect(() => {
    start.current = null;
    invalidate();
  }, [retired, opacity, fade, invalidate]);
  useEffect(() => () => {
    geometry.flat?.dispose();
    geometry.solid?.dispose();
  }, [geometry]);
  useFrame(({ clock }) => {
    start.current ??= clock.elapsedTime;
    const k = fade ? Math.min(1, ((clock.elapsedTime - start.current) * 1000) / FADE_MS) : 1;
    const value = opacity * (retired ? 1 - k : k);
    for (const material of [flat.current, solid.current]) if (material) material.opacity = value;
    if (k < 1) invalidate();
    else if (retired) onGone(geometry);
  });
  return (
    <>
      {geometry.flat && (
        // 先于阴影与视场绘制：地面色块不写深度，阴影与视场叠在其上
        <mesh geometry={geometry.flat} renderOrder={-1}>
          <meshBasicMaterial ref={flat} vertexColors transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      {geometry.solid && (
        <mesh geometry={geometry.solid} castShadow receiveShadow>
          <meshLambertMaterial ref={solid} vertexColors transparent opacity={0} />
        </mesh>
      )}
    </>
  );
}
