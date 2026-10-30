import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BufferGeometry, MeshBasicMaterial, MeshLambertMaterial } from "three";
import type { SceneFrame } from "../store/live";
import { useTheme } from "../theme/store";
import { useMotion } from "./DeviceMarkers";
import type { Camera } from "./devices";
import { type Furniture, useFurnitureModels } from "./furniture";
import {
  FADE_MS,
  layerOpacity,
  PALETTE,
  type Palette,
  type SceneGeometry,
  STALE_OPACITY,
  sceneGeometry,
  useScenes,
} from "./perceived";

/** 各摄像头实时识别并投影的环境（§5.1 L1）；无识别结果即空白（UP-1） */
export function PerceivedScene({ cameras }: { cameras: Camera[] }) {
  const palette = PALETTE[useTheme((s) => s.theme)];
  const models = useFurnitureModels();
  return useScenes(cameras).map(({ frame, stale }) => {
    // useScenes 只返回已登记摄像头的场景
    const { pose } = cameras.find((c) => c.id === frame.camera_id) as Camera;
    return (
      <CameraScene
        key={frame.camera_id}
        frame={frame}
        palette={palette}
        stale={stale}
        models={models}
        x={pose.x}
        y={pose.y}
      />
    );
  });
}

interface Layer {
  /** 递增编号，作渲染键：被取代的层保持挂载、继续淡出 */
  id: number;
  geometry: SceneGeometry;
  /** 已被新一帧取代，正在淡出 */
  retired: boolean;
}

/** 一台摄像头的场景：新帧到达时新旧两层交叉渐变 300 ms；降低动效或断线时瞬时替换（V-A4、V-U3）。x、y 为摄像头平面位置 */
function CameraScene(props: {
  frame: SceneFrame;
  palette: Palette;
  stale: boolean;
  models: Record<Furniture, BufferGeometry>;
  x: number;
  y: number;
}) {
  const { frame, palette, stale, models, x, y } = props;
  const geometry = useMemo(() => sceneGeometry(frame, palette, { models, camera: [x, y] }), [frame, palette, models, x, y]);
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
  /** 最近一帧绘制的不透明度；被取代时由此开始淡出 */
  const shown = useRef(0);
  const from = useRef<number | null>(null);
  // 在下一帧绘制前更新起点：否则被取代的层可能先按旧起点画出一帧而直接消失
  useLayoutEffect(() => {
    start.current = null;
    from.current = retired ? shown.current : null;
    invalidate();
  }, [retired, opacity, fade, invalidate]);
  useEffect(() => () => {
    geometry.flat?.dispose();
    geometry.solid?.dispose();
  }, [geometry]);
  useFrame(({ clock }) => {
    start.current ??= clock.elapsedTime;
    const k = fade ? Math.min(1, ((clock.elapsedTime - start.current) * 1000) / FADE_MS) : 1;
    const value = layerOpacity(opacity, k, from.current);
    shown.current = value;
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
