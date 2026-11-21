import { afterEach, describe, expect, it } from "vitest";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { sceneHandlesEscape } from "../../src/scene/SceneViewport";
import { placeMarker } from "../../src/scene/TargetModels";
import { useNav } from "../../src/store/nav";

afterEach(() => {
  useNav.setState(useNav.getInitialState());
  document.body.innerHTML = "";
});

describe("场景的 Esc（回到总览）", () => {
  it("态势页、没有弹层时由场景处理", () => {
    expect(sceneHandlesEscape()).toBe(true);
  });

  it("有打开的对话框或下拉时让弹层先关", () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(sceneHandlesEscape()).toBe(false);
    document.body.innerHTML = '<div data-radix-popper-content-wrapper=""></div>';
    expect(sceneHandlesEscape()).toBe(false);
  });

  it("被管理页盖住时不处理", () => {
    useNav.setState({ page: "cameras" });
    expect(sceneHandlesEscape()).toBe(false);
  });
});

describe("placeMarker：选中括框", () => {
  const size = { width: 800, height: 600 };
  const camera = () => {
    const c = new PerspectiveCamera(50, size.width / size.height, 0.5, 1000);
    c.position.set(0, 1.6, 0);
    c.lookAt(0, 1.6, -10); // 看向 −z
    c.updateMatrixWorld();
    return c;
  };
  const box = (z: number) => new Box3(new Vector3(-0.3, 0, z - 0.3), new Vector3(0.3, 1.8, z + 0.3));

  it("目标在视点前方：显示并落在画面中部", () => {
    const el = document.createElement("div");
    placeMarker(el, box(-5), camera(), size);
    expect(el.hidden).toBe(false);
    const left = parseFloat(/translate\(([-\d.]+)px/.exec(el.style.transform)?.[1] ?? "NaN");
    const width = parseFloat(el.style.getPropertyValue("--w"));
    expect(left + width / 2).toBeCloseTo(size.width / 2, 0);
  });

  it("目标在视点身后或跨过近裁面：隐藏，不把身后的点反射到画面上", () => {
    for (const z of [5, 0]) {
      const el = document.createElement("div");
      placeMarker(el, box(z), camera(), size);
      expect(el.hidden).toBe(true);
    }
  });
});
