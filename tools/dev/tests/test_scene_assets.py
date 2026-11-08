"""场景资产库脚本（设计 150 §8）：重新上色与占地格数的换算。"""

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "assets.py"
_spec = importlib.util.spec_from_file_location("assets", SCRIPT)
assert _spec and _spec.loader
assets = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(assets)


def test_recolor_maps_lightness_into_palette() -> None:
    """深色取暗端、浅色取亮端，中间按明度过渡；鲜艳的原色也只落在两端之间（去掉色相）。"""
    dark, light = (assets.hex_rgb(c) for c in assets.PALETTES["building"])
    assert assets.recolor((0, 0, 0), "building") == dark
    assert assets.recolor((255, 255, 255), "building") == light
    mid = assets.recolor((119, 119, 119), "building")  # L* 约 50
    assert all(lo < m < hi for lo, m, hi in zip(dark, mid, light, strict=True))
    for vivid in ((230, 40, 40), (40, 200, 60), (60, 90, 230), (250, 180, 25)):
        out = assets.recolor(vivid, "building")
        assert all(lo <= o <= hi for lo, o, hi in zip(dark, out, light, strict=True))
    assert assets.recolor((230, 40, 40), "plaza") == assets.hex_rgb("#E6E8EC")


def test_palettes_are_scene_materials() -> None:
    """色板两端只用设计 150 §4 的场景材质色（配色校验 V-S5 已覆盖这些颜色）。"""
    materials = {
        "#EEF0F3", "#DCDFE5", "#FFFFFF", "#E6E8EC", "#DDE5DA",
        "#E5E7EB", "#CBD5E1", "#D4D4D8", "#B7C4B0",
    }  # fmt: skip
    assert {c for pair in assets.PALETTES.values() for c in pair} <= materials


def test_footprint_rounds_up_and_follows_yaw() -> None:
    assert assets.footprint((0.9, 0.94), 8, 0) == [8, 8]  # 7.2 m、7.52 m → 8 格
    assert assets.footprint((0.1, 2.0), 1, 90) == [2, 1]  # 墙沿 z，转 90° 后长边沿 x
    assert assets.footprint((1.0, 1.0), 2.02, 0) == [2, 2]  # 2.02 m 在 5 cm 容差内
    assert assets.footprint((0.01, 0.01), 1, 0) == [1, 1]
