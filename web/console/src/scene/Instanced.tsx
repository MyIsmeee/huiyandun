import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useRef } from "react";
import { type BufferGeometry, Color, type InstancedMesh, Object3D } from "three";
import type { Vec3 } from "./layout";

/** 一个实例：场景坐标、绕竖轴的旋转（弧度）、缩放与颜色 */
export interface Instance {
  position: Vec3;
  rotationY?: number;
  scale?: Vec3;
  color: string;
}

/** 同一几何体的全部实例合并为一次绘制（V-P1） */
export function Instanced(props: { geometry: BufferGeometry; items: Instance[]; opacity?: number; castShadow?: boolean }) {
  const { geometry, items, opacity = 1, castShadow = true } = props;
  const ref = useRef<InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new Object3D();
    items.forEach(({ position, rotationY = 0, scale = [1, 1, 1], color }, i) => {
      o.position.set(...position);
      o.rotation.set(0, rotationY, 0);
      o.scale.set(...scale);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, new Color(color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    invalidate();
  }, [items, invalidate]);
  if (items.length === 0) return null;
  return (
    // 实例数变化时重建：InstancedMesh 的容量在创建时确定
    <instancedMesh key={items.length} ref={ref} args={[geometry, undefined, items.length]} castShadow={castShadow}>
      <meshLambertMaterial transparent={opacity < 1} opacity={opacity} depthWrite={opacity === 1} />
    </instancedMesh>
  );
}
