import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import { bake, shadeOf } from "../../src/scene/vehicles";

/** 车头朝 +z 的玩具车：车身 1 × 0.5 × 2（含车窗材质组），前轮在车头一侧 */
function toyCar() {
  const body = new Mesh(new BoxGeometry(1, 0.5, 2), [
    new MeshBasicMaterial({ name: "Paint" }),
    new MeshBasicMaterial({ name: "Windows" }),
  ]);
  body.geometry.clearGroups();
  body.geometry.addGroup(0, 18, 0); // 前 3 个面（每面 6 个索引）为车身，其余为车窗
  body.geometry.addGroup(18, 18, 1);
  body.name = "Body";
  body.position.set(5, 0.75, 3); // 原始模型不在原点、不落地
  const wheel = new Mesh(new BoxGeometry(0.2, 0.5, 0.5), new MeshBasicMaterial({ name: "Rubber" }));
  wheel.position.set(0, -0.25, 0.7);
  const front = new Group();
  front.name = "FrontWheel";
  front.add(wheel);
  body.add(front);
  const root = new Group();
  root.add(body);
  return root;
}

describe("bake", () => {
  const { geometry, outline } = bake(toyCar(), 4, Math.PI / 2, 0.02);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const color = geometry.getAttribute("color");
  const shade = (i: number) => Math.round(color.getX(i) * 100) / 100; // 顶点色为 float32

  it("车头转到 +x，等比缩放到车长，底面落地、水平居中", () => {
    expect(box?.max.x).toBeCloseTo(2, 5);
    expect(box?.min.x).toBeCloseTo(-2, 5);
    expect(box?.min.y).toBeCloseTo(0, 5);
    expect(box?.max.z).toBeCloseTo(1, 5); // 宽 1 → 等比 ×2
    // 前轮在车头一侧（+x）
    const position = geometry.getAttribute("position");
    const wheelX = [...Array(position.count).keys()].filter((i) => shade(i) === 0.3).map((i) => position.getX(i));
    expect(wheelX.length).toBeGreaterThan(0);
    expect(Math.min(...wheelX)).toBeGreaterThan(0);
  });

  it("按网格、上级节点与材质名写入部件明度：轮胎 0.3、车窗 0.55、车身 1", () => {
    const shades = new Set([...Array(color.count).keys()].map(shade));

    expect([...shades].sort()).toEqual([0.3, 0.55, 1]);
  });

  it("描边外壳沿平滑法线外扩，不超过描边宽度", () => {
    outline.computeBoundingBox();
    const max = outline.boundingBox?.max.x ?? 0;

    expect(max).toBeGreaterThan(2.005);
    expect(max).toBeLessThanOrEqual(2.02 + 1e-6);
    expect(outline.boundingBox?.min.y).toBeLessThan(-0.005);
    expect(outline.getAttribute("color")).toBeUndefined();
  });
});

describe("shadeOf", () => {
  it.each([
    ["NormalCar1_BackWheels_Cube.011 Grey", 0.3],
    ["Bus_Cube.001 Windows", 0.55],
    ["Circle DarkPurple", 0.3],
    ["NormalCar1_Cube.012 Blue", 1],
  ])("%s → %d", (name, shade) => {
    expect(shadeOf(name)).toBe(shade);
  });
});
