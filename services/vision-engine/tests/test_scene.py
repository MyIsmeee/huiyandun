"""场景感知（TK-118、FR-108）：分割结果归并、演示帧快照、投影、平滑与无效帧。

scenes/*.npz 由 tools/dev/record_scene.py 从 demo/media/src/ 的素材帧录制，只含 64×64 的渲染类别编号；
映射表或阈值变化后须按下表重新录制（快照名：素材 秒）——fire-1：ebike-fire-1 129；indoor-1：fall-1 2；
indoor-2：moto-fire-1 3；rural-1：climb-1 1；street-1：crowd-1 10；street-2：fall-2 1；
classroom-1：classroom-1 20；lab-1：actions-1 0。投影以已知单应矩阵检验平面坐标；分割以假会话代替模型。
"""

import asyncio
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import cv2
import numpy as np
import pytest

from py_common.bus import Bus
from py_contracts.events.hyd_vision_scene_v1_schema import VisionSceneV1
from vision_engine.geometry import GroundMapping
from vision_engine.pipeline import SCENE_SUBJECT, FrameReader, run_scene
from vision_engine.scene import (
    CLASSES,
    GRID,
    LUT,
    MAX_POLYGONS,
    ScenePerception,
    Segmenter,
    label,
    smooth,
)

SCENES = Path(__file__).parent / "scenes"
SIZE = 640  # 测试画面 640×640：每格 10 像素
# 正视地面：1 像素 = 1 cm，即每格 0.1 m
TOP_DOWN = GroundMapping.fit([[u, v, u / 100, v / 100] for u in (0, 1000) for v in (0, 700)])
POSE = {"x": 3.2, "y": 10.0, "range_m": 50.0}  # 摄像头位于画面下方之外


def mapping(m: GroundMapping | None) -> GroundMapping:
    assert m is not None
    return m


def perception(
    pose: dict[str, float] = POSE, ground: GroundMapping | None = TOP_DOWN, segmenter: Any = None
) -> ScenePerception:
    return ScenePerception("cam-01", mapping(ground), pose, cast(Segmenter, segmenter))


def grid(**blocks: list[tuple[slice, slice]]) -> np.ndarray:
    labels = np.zeros((GRID, GRID), np.uint8)
    for name, regions in blocks.items():
        for rows, cols in regions:
            labels[rows, cols] = label(name)
    return labels


def blank(value: int = 100) -> np.ndarray:
    return np.full((SIZE, SIZE, 3), value, np.uint8)


def snapshot(name: str) -> tuple[np.ndarray, tuple[int, int]]:
    data = np.load(SCENES / f"{name}.npz")
    # 类别名或 ADE20K 编号映射任一变化，录制结果即失效
    assert data["classes"].tolist() == CLASSES, "映射表已变化，须重新录制"
    assert (data["lut"] == LUT).all(), "映射表已变化，须重新录制"
    return data["labels"], tuple(data["shape"].tolist())


def share(labels: np.ndarray, *names: str) -> float:
    return float(np.isin(labels, [label(n) for n in names]).mean())


# --- 演示帧快照 ---


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        # 步行街俯拍：路面与人行道分开，两侧建筑
        ("street-1", {("road",): 0.3, ("sidewalk",): 0.2, ("building",): 0.1}),
        # 路口与斑马线：路面与建筑
        ("street-2", {("road",): 0.3, ("building",): 0.15}),
        # 客厅：地面、墙、茶几（桌）与塑料椅
        ("indoor-1", {("floor",): 0.1, ("wall",): 0.4, ("table",): 0.03, ("chair",): 0.01}),
        # 车行：地面与墙（摩托车不在场景中，记为未识别）
        ("indoor-2", {("floor",): 0.15, ("wall",): 0.15}),
        # 乡村路：路面多被识别为泥地，栏杆与树检出
        ("rural-1", {("road", "earth"): 0.2, ("railing", "fence"): 0.1, ("tree",): 0.03}),
        # 空教室：课桌逐张检出，后墙黑板识别为公告板（D-059）
        ("classroom-1", {("floor",): 0.15, ("wall",): 0.25, ("table",): 0.1, ("board",): 0.02}),
        # 实验室：实验台、椅、台下柜与投影幕（实验台另有部分被识别为床，D-059）
        ("lab-1", {("table",): 0.02, ("chair",): 0.005, ("cabinet",): 0.02, ("board",): 0.05}),
    ],
)
def test_demo_frame_classes(name: str, expected: dict[tuple[str, ...], float]) -> None:
    labels, _ = snapshot(name)

    found = {names: round(share(labels, *names), 2) for names in expected}
    assert all(found[names] >= least for names, least in expected.items()), found


def test_dark_fire_frame_is_not_recognized() -> None:
    """浓烟与火光画面识别不可靠：几乎全部不输出，没有地面与立面（设计 §3.7）。"""
    labels, shape = snapshot("fire-1")

    assert (labels == 0).mean() >= 0.95
    scene = perception().project(labels, np.zeros((*shape, 3), np.uint8))
    assert scene["surfaces"] == scene["walls"] == []


def test_street_projects_road_sidewalk_and_building() -> None:
    """斜视的街道画面：画面下方 0.4 高以上为远处，超出视距的部分丢弃。"""
    labels, (h, w) = snapshot("street-1")
    oblique = GroundMapping.fit(
        [[0, h, -3, 2], [w, h, 3, 2], [w * 0.25, h * 0.4, -6, 15], [w * 0.75, h * 0.4, 6, 15]]
    )
    pose = {"x": 0.0, "y": 0.0, "range_m": 30.0}

    scene = perception(pose, oblique).project(labels, np.full((h, w, 3), 100, np.uint8))

    surfaces = {s["class"] for s in scene["surfaces"]}
    assert {"road", "sidewalk"} <= surfaces
    assert "building" in {w["class"] for w in scene["walls"]}
    points = [p for s in scene["surfaces"] for p in s["polygon"]]
    assert max(np.hypot(*p) for p in points) <= 30.0 + 0.2


def test_classroom_projects_tables_and_board() -> None:
    """斜视的教室画面：课桌为物体，黑板为立面中的 board。"""
    labels, (h, w) = snapshot("classroom-1")
    oblique = GroundMapping.fit(
        [[0, h, -3, 2], [w, h, 3, 2], [w * 0.25, h * 0.2, -4, 12], [w * 0.75, h * 0.2, 4, 12]]
    )
    pose = {"x": 0.0, "y": 0.0, "range_m": 30.0}

    scene = perception(pose, oblique).project(labels, np.full((h, w, 3), 100, np.uint8))

    assert "table" in {o["class"] for o in scene["objects"]}
    assert "board" in {w["class"] for w in scene["walls"]}


# --- 投影 ---


def test_surface_outline_on_known_homography() -> None:
    labels = grid(road=[(slice(10, 30), slice(10, 30))])

    (surface,) = perception().project(labels, blank())["surfaces"]

    polygon = np.array(surface["polygon"])
    assert surface["class"] == "road"
    assert polygon.min(0) == pytest.approx([1.05, 1.05])  # 格中心：(10 + 0.5) × 0.1 m
    assert polygon.max(0) == pytest.approx([2.95, 2.95])


def test_surface_holes_are_filled() -> None:
    """路面上的人与车辆不在场景中，其遮挡处不留孔洞。"""
    labels = grid(road=[(slice(10, 30), slice(10, 30))])
    labels[15:20, 15:20] = 0

    (surface,) = perception().project(labels, blank())["surfaces"]

    assert len(surface["polygon"]) == 4


def test_ground_beyond_range_and_above_horizon_is_dropped() -> None:
    """地平线 v = 200 px：x = 10 (u − 320) / (v − 200)，y = 1000 / (v − 200)。"""
    horizon = GroundMapping(
        homography=np.array([[10.0, 0, -3200], [0, 0, 1000], [0, 1, -200]]),
        reproj_error_m=0.0,
    )
    pose = {"x": 0.0, "y": 0.0, "range_m": 15.0}
    labels = grid(road=[(slice(0, GRID), slice(0, GRID))])

    (surface,) = perception(pose, horizon).project(labels, blank())["surfaces"]

    polygon = np.array(surface["polygon"])
    assert np.isfinite(polygon).all()
    assert np.hypot(polygon[:, 0], polygon[:, 1]).max() <= 15.0
    assert polygon[:, 1].min() == pytest.approx(1000 / (SIZE - 5 - 200), abs=0.01)  # 最低一行格中心


def test_wall_follows_bottom_edge() -> None:
    labels = grid(wall=[(slice(0, 20), slice(5, 41))], floor=[(slice(20, GRID), slice(0, GRID))])

    (wall,) = perception().project(labels, blank())["walls"]

    assert wall["class"] == "wall"
    assert wall["height_m"] == 2.8
    assert wall["line"] == [[0.55, 2.0], [4.05, 2.0]]  # 第 19 行格底边 y = 20 × 0.1 m


def test_wall_splits_where_bottom_jumps() -> None:
    labels = grid(building=[(slice(0, 20), slice(5, 21)), (slice(0, 40), slice(21, 41))])

    walls = perception().project(labels, blank())["walls"]

    assert sorted(w["line"][0][1] for w in walls) == [2.0, 4.0]
    assert all(w["height_m"] == 6.0 for w in walls)


def test_object_footprint_extends_away_from_camera() -> None:
    """家具只见正面：底边向远离摄像头一侧补出 0.6 m 深的底面。"""
    labels = grid(furniture=[(slice(20, 30), slice(30, 40))])

    (item,) = perception().project(labels, blank())["objects"]

    polygon = np.array(item["polygon"])
    assert item["height_m"] == 0.8
    assert polygon[:, 1].max() == pytest.approx(3.0)
    assert polygon[:, 1].min() == pytest.approx(2.4, abs=0.02)


@pytest.mark.parametrize(
    ("name", "depth", "height"),
    [
        ("table", 0.6, 0.75),
        ("chair", 0.5, 0.9),
        ("cabinet", 0.5, 1.2),
        ("sofa", 0.9, 0.85),
        ("bed", 1.5, 0.6),
    ],
)
def test_furniture_classes_have_own_depth_and_height(
    name: str, depth: float, height: float
) -> None:
    """桌、椅、柜、沙发、床分别输出，底面深度与高度按类别取常见尺寸（D-059）。"""
    labels = grid(**{name: [(slice(20, 30), slice(30, 40))]})

    (item,) = perception().project(labels, blank())["objects"]

    polygon = np.array(item["polygon"])
    assert (item["class"], item["height_m"]) == (name, height)
    assert polygon[:, 1].max() - polygon[:, 1].min() == pytest.approx(depth, abs=0.02)


def test_board_sits_on_wall_foot_below() -> None:
    """黑板挂在墙上：取其所在各列的墙脚线，墙本身照常输出（D-059）。"""
    labels = grid(wall=[(slice(0, 20), slice(5, 41))], floor=[(slice(20, GRID), slice(0, GRID))])
    labels[2:9, 15:30] = label("board")

    walls = perception().project(labels, blank())["walls"]

    assert {"class": "wall", "line": [[0.55, 2.0], [4.05, 2.0]], "height_m": 2.8} in walls
    assert {"class": "board", "line": [[1.55, 2.0], [2.95, 2.0]], "height_m": 1.2} in walls


def test_board_reaches_wall_foot_across_unrecognized_gap() -> None:
    """黑板与下方的墙之间隔着未识别的格（如板槽）仍取墙脚线；遇到其他类别即止。"""
    labels = grid(wall=[(slice(10, 20), slice(5, 41))], floor=[(slice(20, GRID), slice(0, GRID))])
    labels[2:8, 15:30] = label("board")
    labels[2:8, 45:55] = label("board")  # 下方直接是地面：取黑板自身的底边

    lines = [
        w["line"] for w in perception().project(labels, blank())["walls"] if w["class"] == "board"
    ]

    assert sorted(lines) == [[[1.55, 2.0], [2.95, 2.0]], [[4.55, 0.8], [5.45, 0.8]]]


def test_board_stops_at_furniture_in_front_of_wall() -> None:
    """黑板下方的墙被桌子挡住：取桌子以上最低的墙格，不越过桌子取更下方的墙。"""
    labels = grid(wall=[(slice(8, 20), slice(5, 41))], floor=[(slice(20, GRID), slice(0, GRID))])
    labels[2:8, 15:30] = label("board")
    labels[12:14, 10:35] = label("table")

    (board,) = [w for w in perception().project(labels, blank())["walls"] if w["class"] == "board"]

    assert board["line"] == [[1.55, 1.2], [2.95, 1.2]]  # 第 11 行格底边


def test_tree_at_bottom_center() -> None:
    labels = grid(tree=[(slice(10, 20), slice(30, 34))], plant=[(slice(40, 45), slice(5, 8))])

    trees = perception().project(labels, blank())["trees"]

    assert {"x": 3.2, "y": 2.0, "height_m": 5.0} in trees
    assert {"x": 0.65, "y": 4.5, "height_m": 1.0} in trees


def test_polygons_capped_by_area() -> None:
    """每帧多边形合计不超过 64 个，保留面积最大的。"""
    blocks = [(slice(r, r + 5), slice(c, c + 5)) for r in range(0, 63, 7) for c in range(0, 63, 7)]
    labels = grid(road=blocks)  # 81 块，每块 0.16 m²
    labels[0:12, 0:12] = label("sidewalk")

    surfaces = perception().project(labels, blank())["surfaces"]

    assert len(surfaces) == MAX_POLYGONS
    assert "sidewalk" in {s["class"] for s in surfaces}


def test_crosswalk_and_lane_markings() -> None:
    """路面内的白色条纹：4 条并排的为斑马线；与其垂直、单独的一条为车道线。"""
    frame = blank()
    for x in range(60, 360, 80):
        cv2.rectangle(frame, (x, 50), (x + 40, 250), (255, 255, 255), -1)
    cv2.rectangle(frame, (100, 450), (400, 470), (255, 255, 255), -1)
    labels = grid(road=[(slice(0, GRID), slice(0, GRID))])

    markings = perception().project(labels, frame)["markings"]

    assert sorted(m["class"] for m in markings) == ["crosswalk"] * 4 + ["lane"]


def test_white_outside_road_is_not_marking() -> None:
    frame = blank()
    cv2.rectangle(frame, (60, 50), (100, 250), (255, 255, 255), -1)
    labels = grid(sidewalk=[(slice(0, GRID), slice(0, GRID))])

    assert perception().project(labels, frame)["markings"] == []


# --- 分割、平滑与无效帧 ---


class FakeSession:
    """左半边路面（logit 10），右半边各类相同（概率 1/150，低于阈值）。"""

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="input")]

    def run(self, names: None, feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        assert feed["input"].shape == (1, 3, 512, 512)
        logits = np.zeros((1, 150, GRID, GRID), np.float32)
        logits[0, 6, :, : GRID // 2] = 10  # ADE20K 6 = road
        return [logits]


def test_segmenter_maps_classes_and_drops_low_confidence_and_dark() -> None:
    frame = blank(128)
    frame[: SIZE // 4] = 10  # 上方 1/4 过暗

    labels = Segmenter(cast(Any, FakeSession()))(frame)

    assert (labels[GRID // 4 :, : GRID // 2] == label("road")).all()
    assert (labels[: GRID // 4] == 0).all()
    assert (labels[:, GRID // 2 :] == 0).all()


def test_single_change_does_not_flip_two_do() -> None:
    old, new = np.full((2, 2), 1), np.full((2, 2), 2)

    assert (smooth(deque([old, old, new])) == old).all()
    assert (smooth(deque([old, new, new])) == new).all()
    assert (smooth(deque([np.full((2, 2), 3), old, new])) == new).all()  # 各不相同取最新


class SequenceSegmenter:
    def __init__(self, *labels: np.ndarray) -> None:
        self._labels = list(labels)

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        return self._labels.pop(0)


def test_process_publishes_smoothed_scene() -> None:
    road = grid(road=[(slice(10, 30), slice(10, 30))])
    grass = grid(grass=[(slice(10, 30), slice(10, 30))])
    camera = perception(segmenter=SequenceSegmenter(road, road, grass, grass))

    classes = []
    for _ in range(4):
        event = camera.process(blank())
        assert event is not None
        classes.append(event.surfaces[0].class_)

    assert classes == ["road", "road", "road", "grass"]  # 连续 2 次才翻转
    assert event.camera_id == "cam-01"


def test_nothing_recognized_is_not_published() -> None:
    """无有效识别时不发布：大屏保留上一帧，超过 10 s 未更新即标为陈旧（设计 §3.7）。"""
    camera = perception(segmenter=SequenceSegmenter(np.zeros((GRID, GRID), np.uint8)))

    assert camera.process(blank()) is None


class Reader:
    """new=True 时每次取用都是新帧；否则一直是同一帧（如断流）。"""

    def __init__(self, new: bool) -> None:
        self.new = new
        self.seq = 1

    def latest(self) -> tuple[int, np.ndarray]:
        self.seq += self.new
        return self.seq, blank()


class SceneBus:
    def __init__(self) -> None:
        self.events: list[VisionSceneV1] = []

    async def publish(self, subject: str, event: VisionSceneV1) -> None:
        assert subject == SCENE_SUBJECT
        self.events.append(event)


@pytest.mark.parametrize(("new", "published"), [(True, 2), (False, 1)])
def test_scene_published_once_per_second_for_new_frames(new: bool, published: int) -> None:
    road = grid(road=[(slice(10, 30), slice(10, 30))])
    camera = perception(segmenter=SequenceSegmenter(*[road] * 5))
    bus = SceneBus()

    run = run_scene(camera, cast(FrameReader, Reader(new)), cast(Bus, bus))
    with pytest.raises(TimeoutError):
        asyncio.run(asyncio.wait_for(run, 2.5))

    assert len(bus.events) == published
