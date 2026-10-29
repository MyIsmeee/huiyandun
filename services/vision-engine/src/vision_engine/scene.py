"""场景感知（TK-118、FR-108）：EfficientViT-Seg 识别环境 → 归并为渲染类别 → 时间平滑 → 投影到平面。

每台已标定摄像头每秒 1 次，取最新帧。输出只含平面坐标（米）的多边形与线段，不含图像（G-04）；
人员与车辆不在场景中，由 track 事件呈现。地面类别取掩码外轮廓。
"""

import uuid
from collections import deque
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import cv2
import numpy as np
import onnxruntime as ort

from py_contracts.events.hyd_vision_scene_v1_schema import VisionSceneV1
from vision_engine.geometry import GroundMapping

SCHEMA_VERSION = "1.0.0"
INPUT = 512  # 模型输入 512×512，输出 64×64 格
GRID = 64
MEAN = np.array([0.485, 0.456, 0.406]) * 255  # ImageNet 归一化，与上游评测一致
STD = np.array([0.229, 0.224, 0.225]) * 255
# 格子最大类别概率低于此值不输出；演示帧街道、室内的中位数为 0.75～0.91（模型卡）
MIN_CONFIDENCE = 0.5
# 灰度均值超出此范围的格子不输出：暗光、过曝与画面黑边（黑边会被识别为墙）
DARK, BRIGHT = 40, 250
HISTORY = 3  # 近 3 次的多数类别：画面变化后连续 2 次识别即翻转（约 2 s）
SIMPLIFY_M = 0.2
MAX_POLYGONS = 64  # 按面积保留最大的
MIN_CELLS = 3  # 小于 3 格的区域视为噪声
MIN_AREA_M2 = 0.1

# 渲染类别 → ADE20K 类别编号（从 0 起，顺序见上游 eval_efficientvit_seg_model.py），随代码版本化
ADE20K = {
    "road": [6, 52, 91],  # road、path、dirt track
    "sidewalk": [11],
    "floor": [3, 28],  # floor、rug
    "grass": [9, 29],  # grass、field
    "earth": [13, 46, 94],  # earth、sand、land
    "wall": [0, 8, 14, 42, 58],  # wall、windowpane、door、column、screen door
    "building": [1, 25, 48, 79, 84],  # building、house、skyscraper、hovel、tower
    "fence": [32],
    "railing": [38, 95],  # railing、bannister
    # bed、cabinet、table、chair、sofa、shelf、armchair、seat、desk、wardrobe、chest of drawers、
    # counter、bookcase、coffee table、stool
    "furniture": [7, 10, 15, 19, 23, 24, 30, 31, 33, 35, 44, 45, 62, 64, 110],
    # signboard、bench、streetlight、pole、traffic light、ashcan
    "street_furniture": [43, 69, 87, 93, 136, 138],
    "tree": [4, 72],  # tree、palm
    "plant": [17],  # 盆栽等，以矮树呈现
}
CLASSES = list(ADE20K)  # 格子取值 = 下标 + 1，0 为未识别
SURFACES = ["road", "sidewalk", "floor", "grass", "earth"]

LUT = np.zeros(150, np.uint8)
for _i, _name in enumerate(CLASSES, 1):
    LUT[ADE20K[_name]] = _i


def label(name: str) -> int:
    return CLASSES.index(name) + 1


class Segmenter:
    """BGR 帧 → GRID×GRID 的渲染类别编号；多路共用一个会话。"""

    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._input = session.get_inputs()[0].name

    def __call__(self, frame: np.ndarray) -> np.ndarray:
        rgb = cv2.cvtColor(cv2.resize(frame, (INPUT, INPUT)), cv2.COLOR_BGR2RGB)
        x = ((rgb - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)
        logits = self._session.run(None, {self._input: x})[0][0]
        confidence = 1 / np.exp(logits - logits.max(0)).sum(0)  # softmax 的最大值
        labels = LUT[logits.argmax(0)]
        gray = cv2.resize(
            cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (GRID, GRID), interpolation=cv2.INTER_AREA
        )
        labels[(confidence < MIN_CONFIDENCE) | (gray < DARK) | (gray > BRIGHT)] = 0
        return labels


def smooth(history: deque[np.ndarray]) -> np.ndarray:
    """每格取近 3 次的多数；三次各不相同时取最新一次。"""
    if len(history) < HISTORY:
        return history[-1]
    a, b, latest = history
    return np.where((a == b) & (a != latest), a, latest)


class ScenePerception:
    """单路摄像头的分割、平滑与投影；状态只在本路串行调用的 process 中使用。"""

    def __init__(
        self,
        camera_id: str,
        mapping: GroundMapping,
        pose: dict[str, Any],
        segmenter: Segmenter,
    ) -> None:
        self._camera_id = camera_id
        self._mapping = mapping
        self._camera = np.array([pose["x"], pose["y"]], dtype=np.float64)
        self._range_m = pose["range_m"]
        self._segmenter = segmenter
        self._history: deque[np.ndarray] = deque(maxlen=HISTORY)
        self._cell = np.ones(2)  # 每格的像素尺寸，随画面尺寸在 project 中更新

    def process(self, frame: np.ndarray) -> VisionSceneV1 | None:
        """无任何有效识别时返回 None：不发布，大屏保留上一帧并标为陈旧（设计 §3.7）。"""
        self._history.append(self._segmenter(frame))
        scene = self.project(smooth(self._history), frame)
        if not any(scene.values()):
            return None
        return VisionSceneV1.model_validate(
            {
                "schema_version": SCHEMA_VERSION,
                "event_id": uuid.uuid4(),
                "ts": datetime.now(UTC),
                "camera_id": self._camera_id,
            }
            | scene
        )

    def project(self, labels: np.ndarray, frame: np.ndarray) -> dict[str, list[dict[str, Any]]]:
        height, width = frame.shape[:2]
        self._cell = np.array([width / GRID, height / GRID])
        rows, cols = np.mgrid[0:GRID, 0:GRID]
        centers = self._plane(np.column_stack([cols.ravel(), rows.ravel()]) + 0.5)
        valid = np.isfinite(centers[:, 0]).reshape(GRID, GRID)
        polygons: list[tuple[float, str, dict[str, Any]]] = []
        for name in SURFACES:
            for points in self._outlines((labels == label(name)) & valid):
                polygons += self._polygon("surfaces", name, centers.reshape(GRID, GRID, 2)[points])
        polygons.sort(key=lambda p: -p[0])
        scene: dict[str, list[dict[str, Any]]] = {
            "surfaces": [],
            "walls": [],
            "objects": [],
            "trees": [],
            "markings": [],
        }
        for _, kind, item in polygons[:MAX_POLYGONS]:
            scene[kind].append(item)
        return scene

    def _plane(self, cells: np.ndarray) -> np.ndarray:
        """格坐标 (N, 2)（列, 行，可为小数）→ 平面；地平线以上或超出视距 range_m 的为 NaN。"""
        return self._clip(self._mapping.to_plane(cells * self._cell))

    def _clip(self, plane: np.ndarray) -> np.ndarray:
        far = np.linalg.norm(plane - self._camera, axis=1) > self._range_m
        plane[far] = np.nan
        return plane

    @staticmethod
    def _outlines(mask: np.ndarray) -> Iterator[tuple[np.ndarray, np.ndarray]]:
        """各区域的外轮廓（不含孔洞：人与车辆遮挡的路面一并填满），以格下标 (行, 列) 给出。"""
        contours, _ = cv2.findContours(
            mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        for contour in contours:
            if cv2.contourArea(contour) >= MIN_CELLS - 1:
                yield contour[:, 0, 1], contour[:, 0, 0]

    @staticmethod
    def _polygon(kind: str, name: str, points: np.ndarray) -> list[tuple[float, str, dict]]:
        polygon = _simplify(points, closed=True)
        if len(polygon) < 3 or (area := _area(polygon)) < MIN_AREA_M2:
            return []
        return [(area, kind, {"class": name, "polygon": _round(polygon)})]


def _simplify(points: np.ndarray, closed: bool) -> np.ndarray:
    curve = points.astype(np.float32).reshape(-1, 1, 2)
    return cv2.approxPolyDP(curve, SIMPLIFY_M, closed)[:, 0].astype(np.float64)


def _area(polygon: np.ndarray) -> float:
    return abs(cv2.contourArea(polygon.astype(np.float32)))


def _round(points: np.ndarray) -> list[list[float]]:
    return np.round(points, 2).tolist()
