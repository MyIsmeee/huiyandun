"""检测（REUSE-05、REUSE-22）：RF-DETR 检出车辆与人员框，rtmlib RTMO 单阶段输出人体框与 COCO 17 关键点；
人员取两者的并集，同一人以 RF-DETR 的框为准、RTMO 提供骨骼（#287）。"""

import contextlib
import io

import cv2
import numpy as np
import onnxruntime as ort
import supervision as sv
from rtmlib import RFDETR, RTMO
from rtmlib.tools.object_detection.post_processings import multiclass_nms

NMS_IOU = 0.45
MIN_SCORE = 0.3  # 低分框交给 ByteTrack 第二阶段关联，不直接建立轨迹
# 横躺在画面中的人（如倒地者）正向推理常得不到骨骼；另以左右各旋转 90° 的画面推理，使其在旋转后直立
# （TK-022）。旋转方向的检出多为把旁人或杂物框住的松散框（#286 实测 92% 没有对应的人）：只在有横躺且没配上
# 骨骼的 RF-DETR 人员时推理，结果只给这些人补骨骼，不新增人员
ROTATIONS = (cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_90_CLOCKWISE)
MATCH_IOU = 0.3  # RTMO 的框比 RF-DETR 的松：IoU 达此值即视为同一人
# RTMO 独有的框把某个 RF-DETR 人员覆盖达此比例时，是把旁人一并框住的松散框，不输出
CONTAINED = 0.8

type Candidates = tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]


def _unrotate(points: np.ndarray, rotation: int, width: int, height: int) -> np.ndarray:
    """旋转后画面中的坐标 [..., 2] 换算回旋转前的画面（宽 width、高 height）。"""
    u, v = points[..., 0], points[..., 1]
    if rotation == cv2.ROTATE_90_COUNTERCLOCKWISE:
        return np.stack([width - 1 - v, u], axis=-1)
    return np.stack([v, height - 1 - u], axis=-1)


class PoseDetector:
    def __init__(self, model_file: str, session: ort.InferenceSession) -> None:
        # rtmlib 构造时自建会话且不支持显存上限：先以 CPU 构造，再换成 runtime.create_session
        # 的会话（C-HW-12、C-CV-11）。构造时向 stdout 打印的加载信息不进入结构化日志
        with contextlib.redirect_stdout(io.StringIO()):
            self._model = RTMO(model_file, backend="onnxruntime", device="cpu")
        self._model.session = session

    def _infer(self, image: np.ndarray) -> Candidates:
        """单次推理的候选：框 (N, 4)、置信度 (N,)、关键点 (N, 17, 2)、关键点置信度 (N, 17)。"""
        padded, ratio = self._model.preprocess(image)
        dets, poses = self._model.inference(padded)
        return dets[0, :, :4] / ratio, dets[0, :, 4], poses[0, :, :, :2] / ratio, poses[0, :, :, 2]

    def __call__(
        self,
        image: np.ndarray,
        offset: tuple[int, int] = (0, 0),
        persons: sv.Detections | None = None,
    ) -> sv.Detections:
        """检测 image（可为整帧的裁剪区域）；offset 为裁剪区域左上角，结果换算回整帧坐标。

        persons 为 RF-DETR 在同一区域检出的人员（整帧坐标），与 RTMO 的正向检出取并集：同一人用 RF-DETR 的
        框与置信度、RTMO 的骨骼；RF-DETR 独有的人关键点置信度为 0；RTMO 独有的框保留，松散框除外。
        None（未配置 RF-DETR）时只有 RTMO 的正向检出。"""
        dx, dy = offset
        boxes, scores, points, point_scores = self._infer(image)
        boxes, points = boxes + (dx, dy, dx, dy), points + (dx, dy)
        _, keep = multiclass_nms(boxes, scores[:, None], nms_thr=NMS_IOU, score_thr=MIN_SCORE)
        own = np.array([] if keep is None else keep, dtype=int)
        if persons is None or len(persons) == 0:
            return _people(boxes[own], scores[own], points[own], point_scores[own])
        found = persons.xyxy
        keypoints, keypoint_scores = np.zeros((len(found), 17, 2)), np.zeros((len(found), 17))
        # 低于 MIN_SCORE 的候选也参与配对：RF-DETR 已确认是人，RTMO 对横躺者的置信度常偏低
        pairs = _match(found, boxes)
        for i, j in pairs.items():
            keypoints[i], keypoint_scores[i] = points[j], point_scores[j]
        lying = [
            i for i, (x1, y1, x2, y2) in enumerate(found) if i not in pairs and x2 - x1 > y2 - y1
        ]
        if lying:
            height, width = image.shape[:2]
            for rotation in ROTATIONS:
                turned, _, turned_points, turned_scores = self._infer(cv2.rotate(image, rotation))
                corners = _unrotate(turned.reshape(-1, 2, 2), rotation, width, height)
                turned = np.concatenate([corners.min(axis=1), corners.max(axis=1)], axis=1)
                turned_points = _unrotate(turned_points, rotation, width, height)
                for k, j in _match(found[lying], turned + (dx, dy, dx, dy)).items():
                    i = lying[k]
                    # 两个方向取骨骼更清楚的
                    if turned_scores[j].mean() > keypoint_scores[i].mean():
                        keypoints[i] = turned_points[j] + (dx, dy)
                        keypoint_scores[i] = turned_scores[j]
        extra = own[~np.isin(own, list(pairs.values()))]
        extra = extra[_alone(boxes[extra], found)]
        return _people(
            np.concatenate([found, boxes[extra]]),
            np.concatenate([persons.confidence, scores[extra]]),
            np.concatenate([keypoints, points[extra]]),
            np.concatenate([keypoint_scores, point_scores[extra]]),
        )


def _people(
    boxes: np.ndarray, scores: np.ndarray, points: np.ndarray, point_scores: np.ndarray
) -> sv.Detections:
    if len(boxes) == 0:
        return sv.Detections.empty()
    return sv.Detections(
        xyxy=boxes,
        confidence=scores,
        data={"keypoints": points, "keypoint_scores": point_scores},
    )


def _match(persons: np.ndarray, boxes: np.ndarray) -> dict[int, int]:
    """按 IoU 从高到低一对一配对（≥ MATCH_IOU）：persons 的下标 → boxes 的下标。"""
    iou = sv.box_iou_batch(persons, boxes)
    pairs: dict[int, int] = {}
    for flat in np.argsort(-iou, axis=None):
        i, j = divmod(int(flat), iou.shape[1])
        if iou[i, j] < MATCH_IOU:
            break
        if i not in pairs and j not in pairs.values():
            pairs[i] = j
    return pairs


def _alone(boxes: np.ndarray, persons: np.ndarray) -> np.ndarray:
    """boxes 中不与任何人员重合（IoU < MATCH_IOU）、也没有把某个人员框住（覆盖 < CONTAINED）的框。"""
    lo = np.maximum(boxes[:, None, :2], persons[None, :, :2])
    hi = np.minimum(boxes[:, None, 2:], persons[None, :, 2:])
    inter = np.prod(np.clip(hi - lo, 0, None), axis=2)
    areas = np.prod(persons[:, 2:] - persons[:, :2], axis=1)
    same = sv.box_iou_batch(boxes, persons).max(axis=1) >= MATCH_IOU
    return ~same & ((inter / areas).max(axis=1) < CONTAINED)


# RF-DETR（REUSE-22）的 COCO 类别号 → 契约 object_class
VEHICLES = {1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
PERSON = 0  # 人员框交给 PoseDetector 与 RTMO 合并（#287）
VEHICLE_MIN_SCORE = 0.3  # 与 MIN_SCORE 相同：低分框只用于 ByteTrack 第二阶段关联
VEHICLE_INPUT = (512, 512)  # RF-DETR-S 导出时的输入尺寸


class VehicleDetector:
    """车辆与人员框检测：rtmlib RFDETR 负责预处理与推理；后处理自行完成，以保留 ByteTrack 需要的置信度
    （rtmlib 的多类别模式不返回置信度）。DETR 每个查询只出一个框，不需要 NMS。"""

    def __init__(self, model_file: str, session: ort.InferenceSession) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            self._model = RFDETR(model_file, model_input_size=VEHICLE_INPUT, device="cpu")
        self._model.session = session

    def __call__(
        self, image: np.ndarray, offset: tuple[int, int] = (0, 0)
    ) -> tuple[sv.Detections, sv.Detections]:
        """检测 image（可为整帧的裁剪区域），返回（车辆, 人员）；offset 为裁剪区域左上角，结果换算回整帧坐标。"""
        resized, (height, width) = self._model.preprocess(image)
        boxes, logits = self._model.inference(resized)
        # 第 0 类为背景；每个查询取前景中概率最高的类别
        probs = 1 / (1 + np.exp(-logits[0, :, 1:]))
        class_ids, scores = probs.argmax(axis=1), probs.max(axis=1)
        cx, cy, w, h = boxes[0].T
        dx, dy = offset
        xyxy = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)
        xyxy = xyxy * (width, height, width, height) + (dx, dy, dx, dy)

        def pick(keep: np.ndarray) -> sv.Detections:
            if not keep.any():
                return sv.Detections.empty()
            return sv.Detections(xyxy=xyxy[keep], confidence=scores[keep], class_id=class_ids[keep])

        return (
            pick(np.isin(class_ids, list(VEHICLES)) & (scores >= VEHICLE_MIN_SCORE)),
            pick((class_ids == PERSON) & (scores >= MIN_SCORE)),
        )
