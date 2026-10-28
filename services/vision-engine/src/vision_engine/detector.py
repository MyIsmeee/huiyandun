"""人体检测与骨骼（REUSE-05）：rtmlib RTMO 单阶段输出人体框与 COCO 17 关键点。"""

import contextlib
import io

import cv2
import numpy as np
import onnxruntime as ort
import supervision as sv
from rtmlib import RTMO
from rtmlib.tools.object_detection.post_processings import multiclass_nms

NMS_IOU = 0.45
MIN_SCORE = 0.3  # 低分框交给 ByteTrack 第二阶段关联，不直接建立轨迹
# 横躺在画面中的人（如倒地者）正向推理的置信度常低于 MIN_SCORE；另以左右各旋转 90° 的画面推理，
# 使横躺者在旋转后直立，三次结果合并后统一 NMS（TK-022）。推理耗时约为单次的 3 倍
ROTATIONS = (cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_90_CLOCKWISE)

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

    def __call__(self, image: np.ndarray, offset: tuple[int, int] = (0, 0)) -> sv.Detections:
        """检测 image（可为整帧的裁剪区域）；offset 为裁剪区域左上角，结果换算回整帧坐标。"""
        height, width = image.shape[:2]
        candidates = [self._infer(image)]
        for rotation in ROTATIONS:
            boxes, scores, points, point_scores = self._infer(cv2.rotate(image, rotation))
            corners = _unrotate(boxes.reshape(-1, 2, 2), rotation, width, height)
            boxes = np.concatenate([corners.min(axis=1), corners.max(axis=1)], axis=1)
            points = _unrotate(points, rotation, width, height)
            candidates.append((boxes, scores, points, point_scores))
        boxes, scores, points, point_scores = (
            np.concatenate(c) for c in zip(*candidates, strict=True)
        )
        dx, dy = offset
        boxes = boxes + (dx, dy, dx, dy)
        _, keep = multiclass_nms(boxes, scores[:, None], nms_thr=NMS_IOU, score_thr=MIN_SCORE)
        if keep is None:
            return sv.Detections.empty()
        keep = np.asarray(keep)
        return sv.Detections(
            xyxy=boxes[keep],
            confidence=scores[keep],
            data={"keypoints": points[keep] + (dx, dy), "keypoint_scores": point_scores[keep]},
        )
