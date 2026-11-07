import { MeshLambertMaterial } from "three";
import { describe, expect, it } from "vitest";
import { setNearSide } from "../../src/scene/Sandbox";

describe("近侧墙段半透明（04 §5.1 L0）", () => {
  it("切换时标记重新编译：transparent 写在着色器里，不重编译时半透明不生效", () => {
    const material = new MeshLambertMaterial();
    const version = material.version;
    setNearSide([material], true);
    expect([material.transparent, material.opacity, material.depthWrite]).toEqual([true, 0.25, false]);
    expect(material.version).toBeGreaterThan(version);

    const near = material.version;
    setNearSide([material], false);
    expect([material.transparent, material.opacity, material.depthWrite]).toEqual([false, 1, true]);
    expect(material.version).toBeGreaterThan(near);
  });
});
