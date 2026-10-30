"""场景感知（TK-118、FR-108）：EfficientViT-Seg 识别环境 → 归并为渲染类别 → 时间平滑 → 投影到平面。

每台已标定摄像头每秒 1 次，取最新帧。输出只含平面坐标（米）的多边形与线段，不含图像（G-04）；
人员与车辆不在场景中，由 track 事件呈现。地面类别取掩码外轮廓；立面与物体取与地面接触的下边缘
（每列最低一格）；树取底部中心；路面标线在路面区域内按白色条纹检出（ADE20K 无此类别）。
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

SCHEMA_VERSION = "1.1.0"  # 1.1：家具细分为桌、椅、柜、沙发、床，立面增加黑板（TK-122）
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
MAX_POLYGONS = 64  # 地面、物体与标线合计，按面积保留最大的
MIN_CELLS = 3  # 小于 3 格的区域视为噪声
MIN_AREA_M2 = 0.1
MIN_LENGTH_M = 0.5  # 墙脚线
JUMP_CELLS = 2  # 相邻列的下边缘相差超过 2 格视为不同立面，断开
# 路面标线：HSV 亮度不低于 WHITE_V、饱和度不高于 WHITE_S 的细长条纹（长宽比 ≥ 3、宽 ≤ 1 m）
WHITE_V, WHITE_S = 190, 50
MIN_STRIPE_PX = 30
STRIPE_RATIO = 3.0
STRIPE_WIDTH_M = 1.0
CROSSWALK_ANGLE_DEG = 15.0  # 斑马线：至少 3 条平行条纹并排（沿条纹方向错开不超过半长）、间距 3 m 内
CROSSWALK_GAP_M = 3.0

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
    # 黑板：ADE20K 150 类无此类别，教室黑板多识别为 bulletin board，投影幕为 screen（D-059）
    "board": [130, 144],
    "table": [15, 33, 64],  # table、desk、coffee table
    "chair": [19, 30, 31, 75, 110],  # chair、armchair、seat、swivel chair、stool
    "cabinet": [10, 24, 35, 44, 62],  # cabinet、shelf、wardrobe、chest of drawers、bookcase
    "sofa": [23],
    "bed": [7],
    "furniture": [45],  # counter：以低矮立体块呈现
    # signboard、bench、streetlight、pole、traffic light、ashcan
    "street_furniture": [43, 69, 87, 93, 136, 138],
    "tree": [4, 72],  # tree、palm
    "plant": [17],  # 盆栽等，以矮树呈现
}
CLASSES = list(ADE20K)  # 格子取值 = 下标 + 1，0 为未识别
SURFACES = ["road", "sidewalk", "floor", "grass", "earth"]
# 黑板取其下方的墙脚线，板高 1.2 m（离地 0.9 m 由大屏绘制）
WALL_HEIGHT_M = {"wall": 2.8, "building": 6.0, "fence": 1.2, "railing": 1.0, "board": 1.2}
# 物体只见正面，向远离摄像头一侧补出底面：(深, 高) 按类别取常见尺寸
OBJECT_SIZE_M = {
    "table": (0.6, 0.75),
    "chair": (0.5, 0.9),
    "cabinet": (0.5, 1.2),  # 台下柜与储物柜的折中
    "sofa": (0.9, 0.85),
    "bed": (1.5, 0.6),
    "furniture": (0.6, 0.8),
    "street_furniture": (0.4, 0.8),
}
TREE_HEIGHT_M = {"tree": 5.0, "plant": 1.0}

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
        walls = [
            {"class": name, "line": _round(line), "height_m": height_m}
            for name, height_m in WALL_HEIGHT_M.items()
            for edge in (
                self._board_edges(labels)
                if name == "board"
                else self._bottom_edges(labels == label(name))
            )
            if len(line := _simplify(edge, closed=False)) >= 2
            and np.linalg.norm(np.diff(line, axis=0), axis=1).sum() >= MIN_LENGTH_M
        ]
        for name, (depth, _) in OBJECT_SIZE_M.items():
            for edge in self._bottom_edges(labels == label(name)):
                away = edge - self._camera
                back = edge + depth * away / np.linalg.norm(away, axis=1, keepdims=True)
                polygons += self._polygon("objects", name, np.concatenate([edge, back[::-1]]))
        trees = [
            {"x": x, "y": y, "height_m": height_m}
            for name, height_m in TREE_HEIGHT_M.items()
            for x, y in self._bases(labels == label(name))
        ]
        polygons += self._markings(frame, labels == label("road"))
        polygons.sort(key=lambda p: -p[0])
        scene: dict[str, list[dict[str, Any]]] = {
            "surfaces": [],
            "walls": walls,
            "objects": [],
            "trees": trees,
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

    def _bottom_edges(self, mask: np.ndarray) -> Iterator[np.ndarray]:
        """各连通区域每列最低一格的底边中点，投影到平面；遇无效点、断列或跳变处分段。"""
        count, components = cv2.connectedComponents(mask.astype(np.uint8))
        for k in range(1, count):
            rows, cols = np.nonzero(components == k)
            if len(rows) < MIN_CELLS:
                continue
            bottom = np.full(GRID, -1)
            np.maximum.at(bottom, cols, rows)
            columns = np.nonzero(bottom >= 0)[0]
            plane = self._plane(np.column_stack([columns + 0.5, bottom[columns] + 1.0]))
            segment: list[np.ndarray] = []
            for j, column in enumerate(columns):
                split = j and (
                    column - columns[j - 1] > 1
                    or abs(bottom[column] - bottom[columns[j - 1]]) > JUMP_CELLS
                )
                if split or not np.isfinite(plane[j, 0]):
                    if len(segment) >= 2:
                        yield np.array(segment)
                    segment = []
                if np.isfinite(plane[j, 0]):
                    segment.append(plane[j])
            if len(segment) >= 2:
                yield np.array(segment)

    def _board_edges(self, labels: np.ndarray) -> Iterator[np.ndarray]:
        """各块黑板所在各列：自黑板底边向下越过墙与未识别的格（如板槽），遇其他类别即止，
        取其中最低的墙或黑板格，即挂黑板那面墙的墙脚线。"""
        wall = (labels == label("wall")) | (labels == label("board"))
        count, boards = cv2.connectedComponents((labels == label("board")).astype(np.uint8))
        for k in range(1, count):
            mask = boards == k
            for column in np.unique(np.nonzero(mask)[1]):
                top = bottom = np.nonzero(mask[:, column])[0].max()
                for row in range(top + 1, GRID):
                    if wall[row, column]:
                        bottom = row
                    elif labels[row, column]:
                        break
                mask[top : bottom + 1, column] = True
            yield from self._bottom_edges(mask)

    def _bases(self, mask: np.ndarray) -> Iterator[tuple[float, float]]:
        """各连通区域最低一行的中点（树干底部）。"""
        count, components = cv2.connectedComponents(mask.astype(np.uint8))
        for k in range(1, count):
            rows, cols = np.nonzero(components == k)
            if len(rows) < MIN_CELLS:
                continue
            bottom = rows.max()
            point = self._plane(np.array([[cols[rows == bottom].mean() + 0.5, bottom + 1.0]]))[0]
            if np.isfinite(point[0]):
                yield round(float(point[0]), 2), round(float(point[1]), 2)

    def _markings(self, frame: np.ndarray, road: np.ndarray) -> list[tuple[float, str, dict]]:
        """路面外轮廓内的白色细长条纹；至少 3 条平行并排的为斑马线，其余为车道线。"""
        height, width = frame.shape[:2]
        area = np.zeros((GRID, GRID), np.uint8)
        contours, _ = cv2.findContours(
            road.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        cv2.drawContours(area, contours, -1, 1, thickness=-1)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        white = (hsv[..., 2] >= WHITE_V) & (hsv[..., 1] <= WHITE_S)
        inside = cv2.resize(area, (width, height), interpolation=cv2.INTER_NEAREST).astype(bool)
        mask = cv2.morphologyEx((white & inside).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3)))
        stripes = []
        for contour in cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
            if cv2.contourArea(contour) < MIN_STRIPE_PX:
                continue
            corners = self._clip(self._mapping.to_plane(cv2.boxPoints(cv2.minAreaRect(contour))))
            if not np.isfinite(corners).all():
                continue
            sides = np.diff(np.vstack([corners, corners[:1]]), axis=0)[:2]
            lengths = np.linalg.norm(sides, axis=1)
            long, short = lengths.argmax(), lengths.argmin()
            if lengths[short] > STRIPE_WIDTH_M or lengths[long] < STRIPE_RATIO * lengths[short]:
                continue
            stripes.append((corners, corners.mean(0), sides[long] / lengths[long], lengths[long]))
        result = []
        for corners, center, direction, length in stripes:
            beside = sum(
                abs(float(direction @ other)) >= np.cos(np.radians(CROSSWALK_ANGLE_DEG))
                and abs(float(direction @ (c - center))) <= length / 2
                and 0 < np.linalg.norm(c - center) <= CROSSWALK_GAP_M
                for _, c, other, _ in stripes
            )
            name = "crosswalk" if beside >= 2 else "lane"
            result.append((_area(corners), "markings", {"class": name, "polygon": _round(corners)}))
        return result

    @staticmethod
    def _polygon(kind: str, name: str, points: np.ndarray) -> list[tuple[float, str, dict]]:
        polygon = _simplify(points, closed=True)
        if len(polygon) < 3 or (area := _area(polygon)) < MIN_AREA_M2:
            return []
        item: dict[str, Any] = {"class": name, "polygon": _round(polygon)}
        if kind == "objects":
            item["height_m"] = OBJECT_SIZE_M[name][1]
        return [(area, kind, item)]


def _simplify(points: np.ndarray, closed: bool) -> np.ndarray:
    curve = points.astype(np.float32).reshape(-1, 1, 2)
    return cv2.approxPolyDP(curve, SIMPLIFY_M, closed)[:, 0].astype(np.float64)


def _area(polygon: np.ndarray) -> float:
    return abs(cv2.contourArea(polygon.astype(np.float32)))


def _round(points: np.ndarray) -> list[list[float]]:
    return np.round(points, 2).tolist()
