"""RTMO 输出换算：模型输入坐标 → 裁剪区域 → 整帧坐标；低分框丢弃；与 RF-DETR 的人员框合并（#287）。

以假会话代替模型；有横躺且没配上骨骼的 RF-DETR 人员时，另推理逆时针 90°、顺时针 90° 两次（ROTATIONS）。
"""

import importlib.util
from types import SimpleNamespace
from typing import cast

import numpy as np
import onnxruntime as ort
import pytest
import supervision as sv
from onnxruntime.datasets import get_example

from vision_engine.detector import PoseDetector, VehicleDetector


class FakeSession:
    """按 RTMO 导出模型的输出格式返回 dets (1, N, 5) 与 keypoints (1, N, 17, 3)。

    dets 只在第 on_call 次推理（0 为原画面）返回，其余推理无人。
    """

    def __init__(self, dets: list[list[float]], on_call: int = 0) -> None:
        self.dets = np.array([dets], np.float32)
        keypoints = np.zeros((1, len(dets), 17, 3), np.float32)
        keypoints[0, :, :, 0], keypoints[0, :, :, 1], keypoints[0, :, :, 2] = 150, 250, 0.8
        self.keypoints = keypoints
        self.on_call = on_call
        self.calls = 0

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="input")]

    def get_outputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="dets"), SimpleNamespace(name="keypoints")]

    def run(self, names: list[str], feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        assert feed["input"].shape == (1, 3, 640, 640)
        self.calls += 1
        if self.calls - 1 != self.on_call:
            return [self.dets[:, :0], self.keypoints[:, :0]]
        return [self.dets, self.keypoints]


def detector(dets: list[list[float]]) -> PoseDetector:
    return PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, FakeSession(dets)))


def test_maps_to_full_frame() -> None:
    # 1280×720 的裁剪区域缩放为 0.5 送入模型；区域左上角位于整帧 (100, 40)
    image = np.zeros((720, 1280, 3), np.uint8)

    result = detector([[100, 100, 200, 300, 0.9], [400, 100, 450, 200, 0.1]])(image, (100, 40))

    assert len(result) == 1  # 低分框丢弃
    assert result.xyxy[0].tolist() == [300, 240, 500, 640]
    assert result.confidence is not None
    assert result.confidence[0] == np.float32(0.9)
    assert result.data["keypoints"].shape == (1, 17, 2)
    assert result.data["keypoints"][0, 0].tolist() == [400, 540]
    assert result.data["keypoint_scores"][0, 0] == np.float32(0.8)


def test_keypoints_follow_their_box_when_low_score_comes_first() -> None:
    # NMS 返回的 keep 须为原始数组下标；低分框排在前面时，关键点不得配给别人
    session = FakeSession([[400, 100, 450, 200, 0.1], [100, 100, 200, 300, 0.9]])
    session.keypoints[0, 0, :, 0] = 10  # 低分者
    session.keypoints[0, 1, :, 0] = 150  # 高分者
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8))

    assert result.xyxy[0].tolist() == [200, 200, 400, 600]
    assert result.data["keypoints"][0, 0, 0] == 300


@pytest.mark.parametrize(
    ("on_call", "box", "keypoint"),
    [
        (1, [679, 200, 1079, 400], [779, 300]),  # 逆时针 90°：旋转画面 (u, v) → (1279 - v, u)
        (2, [200, 319, 600, 519], [500, 419]),  # 顺时针 90°：旋转画面 (u, v) → (v, 719 - u)
    ],
)
def test_lying_person_gets_skeleton_from_rotated_pass(
    on_call: int, box: list[int], keypoint: list[int]
) -> None:
    """RF-DETR 检出的横躺者正向没有骨骼时，旋转画面中的骨骼换算回原画面（1280×720，旋转后缩放 0.5）。"""
    session = FakeSession([[100, 100, 200, 300, 0.9]], on_call=on_call)
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([box]))

    assert session.calls == 3
    assert result.xyxy.tolist() == [box]
    assert result.data["keypoints"][0, 0].tolist() == keypoint
    assert result.data["keypoint_scores"][0, 0] == np.float32(0.8)


def people(boxes: list[list[int]], score: float = 0.7) -> sv.Detections:
    """RF-DETR 检出的人员（整帧坐标）。"""
    return sv.Detections(xyxy=np.array(boxes, float), confidence=np.full(len(boxes), score))


def test_same_person_takes_detr_box_and_rtmo_skeleton() -> None:
    """同一人（IoU ≥ 0.3）：RF-DETR 的框与置信度，RTMO 的骨骼；RTMO 的框偏松，不输出。"""
    session = FakeSession([[100, 100, 200, 300, 0.9]])  # 整帧 [200, 200, 400, 600]
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[220, 230, 380, 590]]))

    assert session.calls == 1  # 没有缺骨骼的横躺者，不做旋转推理
    assert result.xyxy.tolist() == [[220, 230, 380, 590]]
    assert result.confidence.tolist() == [0.7]
    assert result.data["keypoints"][0, 0].tolist() == [300, 500]
    assert result.data["keypoint_scores"][0, 0] == np.float32(0.8)


def test_low_score_rtmo_candidate_still_gives_skeleton() -> None:
    """RTMO 对横躺者的置信度常低于 MIN_SCORE：RF-DETR 已确认是人时，低分候选的骨骼照用。"""
    session = FakeSession([[100, 100, 200, 300, 0.1]])
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[200, 200, 400, 600]]))

    assert len(result) == 1
    assert result.data["keypoint_scores"][0, 0] == np.float32(0.8)


def test_detr_only_person_kept_without_skeleton() -> None:
    """远处的小人 RTMO 检不出：仍输出，关键点置信度为 0（不参与行为判定，大屏按标准姿态显示）。"""
    session = FakeSession([[100, 100, 200, 300, 0.9]], on_call=1)  # 正向推理无人
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[600, 100, 630, 180]]))

    assert session.calls == 1  # 竖直的框不是横躺者
    assert result.xyxy.tolist() == [[600, 100, 630, 180]]
    assert result.data["keypoints"].shape == (1, 17, 2)
    assert not result.data["keypoint_scores"].any()


def test_rtmo_only_person_kept() -> None:
    """RF-DETR 漏掉的人（如被家具挡住的倒地者）由 RTMO 补上，用 RTMO 的框。"""
    session = FakeSession([[100, 100, 200, 300, 0.9]])  # 整帧 [200, 200, 400, 600]
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[800, 100, 900, 400]]))

    assert sorted(result.xyxy.tolist()) == [[200, 200, 400, 600], [800, 100, 900, 400]]
    assert result.confidence.tolist() == pytest.approx([0.7, 0.9])


def test_rtmo_box_wrapping_detr_person_dropped() -> None:
    """RTMO 把旁人一并框住的松散大框（与其中的人 IoU 不足 0.3）不输出。"""
    loose = [[50, 50, 400, 350, 0.8]]  # 整帧 [100, 100, 800, 700]
    session = FakeSession(loose)
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[300, 200, 420, 600]]))

    assert result.xyxy.tolist() == [[300, 200, 420, 600]]
    assert not result.data["keypoint_scores"].any()


def test_second_rtmo_box_on_matched_person_dropped() -> None:
    """同一人身上 RTMO 的第二个框（NMS 没合掉）不另算一人。"""
    session = FakeSession([[100, 100, 200, 300, 0.9], [100, 100, 200, 180, 0.6]])
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[200, 200, 400, 600]]))

    assert len(result) == 1


def test_no_detr_persons_falls_back_to_rtmo() -> None:
    """RF-DETR 没有检出人员时，RTMO 的正向检出照常输出。"""
    session = FakeSession([[100, 100, 200, 300, 0.9]])
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=sv.Detections.empty())

    assert session.calls == 1
    assert result.xyxy.tolist() == [[200, 200, 400, 600]]


def test_no_person() -> None:
    result = detector([[100, 100, 200, 300, 0.1]])(np.zeros((720, 1280, 3), np.uint8))

    assert len(result) == 0


def test_pyav_and_matplotlib_not_installed() -> None:
    """REUSE-07：supervision 声明但不需要；PyAV 自带 GPL 的 x264 / x265，不得进程内加载（G-08）。"""
    assert importlib.util.find_spec("av") is None
    assert importlib.util.find_spec("matplotlib") is None


class FakeDetrSession:
    """按 RF-DETR 导出模型的输出格式返回框 (1, Q, 4)（归一化 cx cy w h）与分类 logits (1, Q, 91)。

    queries：每个查询为 (cx, cy, w, h, COCO 类别号, 概率)；logits 第 0 列为背景。
    """

    def __init__(self, queries: list[tuple[float, float, float, float, int, float]]) -> None:
        self.boxes = np.array([[q[:4] for q in queries]], np.float32)
        self.logits = np.full((1, len(queries), 91), -10.0, np.float32)
        for i, (*_, coco, prob) in enumerate(queries):
            self.logits[0, i, coco + 1] = np.log(prob / (1 - prob))

    def get_inputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="input")]

    def get_outputs(self) -> list[SimpleNamespace]:
        return [SimpleNamespace(name="dets"), SimpleNamespace(name="labels")]

    def run(self, names: list[str], feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        assert feed["input"].shape == (1, 3, 512, 512)
        return [self.boxes, self.logits]


def vehicles(queries: list[tuple[float, float, float, float, int, float]]) -> VehicleDetector:
    session = cast(ort.InferenceSession, FakeDetrSession(queries))
    return VehicleDetector(get_example("sigmoid.onnx"), session)


def test_vehicles_mapped_to_full_frame_with_class_and_score() -> None:
    """裁剪区域 400×200、左上角 (100, 50)：归一化框按区域尺寸放大后平移回整帧。"""
    detections, _ = vehicles([(0.5, 0.5, 0.5, 0.5, 2, 0.9)])(
        np.zeros((200, 400, 3), np.uint8), offset=(100, 50)
    )

    assert detections.xyxy[0].tolist() == pytest.approx([200, 100, 400, 200])
    assert detections.class_id.tolist() == [2]  # car
    assert detections.confidence.tolist() == pytest.approx([0.9])


def test_only_vehicle_classes_above_threshold_kept() -> None:
    """车辆只取五类，低于 0.3 的框丢弃；人员另行返回。"""
    detections, _ = vehicles(
        [
            (0.2, 0.2, 0.1, 0.1, 0, 0.95),  # person
            (0.5, 0.5, 0.2, 0.2, 5, 0.8),  # bus
            (0.8, 0.8, 0.1, 0.1, 7, 0.2),  # truck，低分
            (0.3, 0.7, 0.1, 0.1, 14, 0.9),  # bird
        ]
    )(np.zeros((100, 100, 3), np.uint8))

    assert detections.class_id.tolist() == [5]


def test_no_vehicles_returns_empty() -> None:
    detections, _ = vehicles([(0.5, 0.5, 0.2, 0.2, 0, 0.9)])(np.zeros((100, 100, 3), np.uint8))

    assert len(detections) == 0


def test_persons_returned_separately_in_full_frame() -> None:
    """同一次推理的人员类一并返回（#287），供与 RTMO 合并；低于 0.3 的丢弃。"""
    _, persons = vehicles(
        [(0.5, 0.5, 0.5, 0.5, 0, 0.9), (0.2, 0.2, 0.1, 0.1, 0, 0.2), (0.8, 0.8, 0.1, 0.1, 2, 0.9)]
    )(np.zeros((200, 400, 3), np.uint8), offset=(100, 50))

    assert len(persons) == 1
    assert persons.xyxy[0].tolist() == pytest.approx([200, 100, 400, 200])
    assert persons.confidence.tolist() == pytest.approx([0.9])


class PassSession(FakeSession):
    """每次推理（0 原画面、1 逆时针、2 顺时针）各自返回 dets_by_call 中的框。"""

    def __init__(self, dets_by_call: list[list[list[float]]]) -> None:
        super().__init__([d for dets in dets_by_call for d in dets])
        self.counts = [len(dets) for dets in dets_by_call]

    def run(self, names: list[str], feed: dict[str, np.ndarray]) -> list[np.ndarray]:
        call = self.calls
        self.calls += 1
        start = sum(self.counts[:call])
        end = start + self.counts[call]
        return [self.dets[:, start:end], self.keypoints[:, start:end]]


def test_rotated_pass_never_adds_persons() -> None:
    """#286：旋转方向的检出多为把旁人或杂物框住的松散框，只用于给缺骨骼的横躺者补骨骼，不新增人员。"""
    ghost = [[75, 339.5, 350, 564.5, 0.9]]  # 逆时针画面中，换算回整帧为 [150, 150, 600, 700]
    session = PassSession([[], ghost, []])
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[700, 500, 1100, 600]]))

    assert session.calls == 3  # 有缺骨骼的横躺者
    assert result.xyxy.tolist() == [[700, 500, 1100, 600]]
    assert not result.data["keypoint_scores"].any()


def test_lying_person_with_low_score_upright_match_still_rotated() -> None:
    """横躺者正向只配上低于 MIN_SCORE 的候选时仍做旋转推理，取骨骼更清楚的（TK-022）。"""
    weak = [[339.5, 100, 539.5, 200, 0.1]]  # 正向：整帧 [679, 200, 1079, 400]
    turned = [[100, 100, 200, 300, 0.9]]  # 逆时针画面中，换算回整帧为同一个框
    session = PassSession([weak, turned, []])
    session.keypoints[0, 0, :, 2] = 0.4
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[679, 200, 1079, 400]]))

    assert session.calls == 3
    assert result.data["keypoints"][0, 0].tolist() == [779, 300]
    assert result.data["keypoint_scores"][0, 0] == np.float32(0.8)


@pytest.mark.parametrize(
    ("scores", "keypoint"),
    [((0.8, 0.5), [779, 300]), ((0.5, 0.8), [500, 419])],  # (逆时针, 顺时针) 的关键点置信度
)
def test_clearer_rotation_gives_skeleton(scores: tuple[float, float], keypoint: list[int]) -> None:
    """横躺者在两个旋转方向都配上框时，取关键点置信度高的一方，与推理先后无关。"""
    ccw = [[100, 100, 200, 300, 0.9]]  # 两个方向换算回整帧都是 [679, 200, 1079, 400]
    cw = [[159.5, 339.5, 259.5, 539.5, 0.9]]
    session = PassSession([[], ccw, cw])
    session.keypoints[0, 0, :, 2], session.keypoints[0, 1, :, 2] = scores
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[679, 200, 1079, 400]]))

    assert result.data["keypoints"][0, 0].tolist() == keypoint
    assert result.data["keypoint_scores"][0, 0] == np.float32(max(scores))


def test_high_score_candidate_preferred_over_closer_low_score() -> None:
    """同一人身上重合度更高的低分候选不抢走高分候选：骨骼取自高分者。"""
    session = FakeSession([[100, 100, 200, 300, 0.1], [100, 100, 200, 280, 0.9]])
    session.keypoints[0, 0, :, 0] = 10  # 低分者，与人员框完全重合
    session.keypoints[0, 1, :, 0] = 150  # 高分者，IoU 0.9
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8), persons=people([[200, 200, 400, 600]]))

    assert len(result) == 1
    assert result.data["keypoints"][0, 0, 0] == 300


def test_without_detr_only_upright_pass() -> None:
    """未配置 RF-DETR（persons=None）时只有 RTMO 的正向检出。"""
    session = PassSession([[[100, 100, 200, 300, 0.9]], [[100, 100, 200, 300, 0.9]], []])
    pose = PoseDetector(get_example("sigmoid.onnx"), cast(ort.InferenceSession, session))

    result = pose(np.zeros((720, 1280, 3), np.uint8))

    assert session.calls == 1
    assert result.xyxy.tolist() == [[200, 200, 400, 600]]
