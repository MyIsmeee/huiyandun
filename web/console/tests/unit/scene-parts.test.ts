import { BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { bakePart, PARTS, placePart } from "../../src/scene/parts";
import type { Vec3 } from "../../src/scene/pose";

/** 加载后的 glb：物体与网格同名时 GLTFLoader 给物体名加后缀，原名留在 userData.name */
function loaded() {
  const root = new Group();
  const thigh = new Mesh(new BoxGeometry(0.1, 0.42, 0.1).translate(0, 0.21, 0), new MeshBasicMaterial());
  thigh.name = "thigh_1";
  thigh.userData.name = "thigh";
  const shin = new Mesh(new BoxGeometry(0.08, 0.42, 0.08).translate(0, 0.21, 0), new MeshBasicMaterial());
  shin.name = "shin";
  shin.position.set(3, 0, 0); // 物体的变换一并烘焙进零件
  root.add(thigh, shin);
  return root;
}

describe("bakePart", () => {
  it("按原名取零件，只留位置与法线，描边外壳沿法线外扩", () => {
    const { geometry, outline } = bakePart(loaded(), "thigh", 0.02);
    outline.computeBoundingBox();

    expect(Object.keys(geometry.attributes).sort()).toEqual(["normal", "position"]);
    expect(geometry.boundingBox?.min.y).toBeCloseTo(0, 5);
    expect(geometry.boundingBox?.max.y).toBeCloseTo(0.42, 5);
    expect(outline.boundingBox?.max.y).toBeGreaterThan(0.42);
    expect(outline.boundingBox?.max.x).toBeGreaterThan(0.05);
  });

  it("物体的变换烘焙进零件；缺少零件时报错并指出名称", () => {
    expect(bakePart(loaded(), "shin", 0.02).geometry.boundingBox?.min.x).toBeCloseTo(2.96, 5);
    expect(() => bakePart(loaded(), "foot", 0.02)).toThrow("foot");
  });
});

describe("placePart", () => {
  const apply = (m: Matrix4, p: Vec3) => new Vector3(...p).applyMatrix4(m);
  const AT: Vec3 = [10, 0, 20];

  it("原点落在近端关节，+y 指向远端关节；骨长为标准值时不拉伸", () => {
    const m = placePart("thigh", [0, 0.92, 0], [0, 0.5, 0], undefined, AT, new Matrix4());

    expect(apply(m, [0, 0, 0]).toArray()).toEqual([10, 0.92, 20]);
    const knee = apply(m, [0, PARTS.thigh.length ?? 0, 0]);
    expect(knee.x).toBeCloseTo(10, 5);
    expect(knee.y).toBeCloseTo(0.5, 5);
    expect(knee.z).toBeCloseTo(20, 5);
  });

  it("骨长与标准值不同时只沿骨段拉伸，粗细不变", () => {
    const m = placePart("shin", [0, 0.84, 0], [0, 0, 0], undefined, [0, 0, 0], new Matrix4());
    const scale = new Vector3().setFromMatrixScale(m);

    expect(scale.x).toBeCloseTo(1, 5);
    expect(scale.y).toBeCloseTo(2, 5);
    expect(scale.z).toBeCloseTo(1, 5);
  });

  it("躯干自髋中向上；+x 取 side 垂直于骨段的分量", () => {
    // 骨段为肩中 → 髋中；side 斜着给，只取水平分量
    const m = placePart("torso", [0, 1.42, 0], [0, 0.92, 0], [0, 0.3, 2], [0, 0, 0], new Matrix4());

    expect(apply(m, [0, 0, 0]).y).toBeCloseTo(0.92, 5);
    expect(apply(m, [0, 0.5, 0]).y).toBeCloseTo(1.42, 5);
    const left = apply(m, [1, 0, 0]);
    expect(left.x).toBeCloseTo(0, 5);
    expect(left.y).toBeCloseTo(0.92, 5);
    expect(left.z).toBeCloseTo(1, 5);
  });

  it("头不随长度缩放；两端重合时朝上", () => {
    const tilted = placePart("head", [0, 1.6, 0], [0.3, 1.6, 0], undefined, [0, 0, 0], new Matrix4());
    const still = placePart("head", [0, 1.6, 0], [0, 1.6, 0], undefined, [0, 0, 0], new Matrix4());

    expect(new Vector3().setFromMatrixScale(tilted).y).toBeCloseTo(1, 5);
    expect(apply(tilted, [0, 0.1, 0]).x).toBeCloseTo(0.1, 5); // 头顶朝 +x
    expect(apply(still, [0, 0.1, 0]).y).toBeCloseTo(1.7, 5);
  });
});
