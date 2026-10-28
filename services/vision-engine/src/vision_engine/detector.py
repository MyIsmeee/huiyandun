"""人体检测与骨骼（REUSE-05）：rtmlib RTMO 单阶段输出人体框与 COCO 17 关键点。"""

import contextlib
import io

import numpy as np
import onnxruntime as ort
import supervision as sv
from rtmlib import RTMO
from rtmlib.tools.object_detection.post_processings import multiclass_nms

NMS_IOU = 0.45
MIN_SCORE = 0.3  # 低分框交给 ByteTrack 第二阶段关联，不直接建立轨迹


class PoseDetector:
    def __init__(self, model_file: str, session: ort.InferenceSession) -> None:
        # rtmlib 构造时自建会话且不支持显存上限：先以 CPU 构造，再换成 runtime.create_session
        # 的会话（C-HW-12、C-CV-11）。构造时向 stdout 打印的加载信息不进入结构化日志
        with contextlib.redirect_stdout(io.StringIO()):
            self._model = RTMO(model_file, backend="onnxruntime", device="cpu")
        self._model.session = session

    def __call__(self, image: np.ndarray, offset: tuple[int, int] = (0, 0)) -> sv.Detections:
        """检测 image（可为整帧的裁剪区域）；offset 为裁剪区域左上角，结果换算回整帧坐标。"""
        padded, ratio = self._model.preprocess(image)
        dets, poses = self._model.inference(padded)
        dx, dy = offset
        boxes = dets[0, :, :4] / ratio + (dx, dy, dx, dy)
        kept, keep = multiclass_nms(boxes, dets[0, :, 4:5], nms_thr=NMS_IOU, score_thr=MIN_SCORE)
        if keep is None:
            return sv.Detections.empty()
        return sv.Detections(
            xyxy=kept[:, :4],
            confidence=kept[:, 4],
            data={
                "keypoints": poses[0, keep, :, :2] / ratio + (dx, dy),
                "keypoint_scores": poses[0, keep, :, 2],
            },
        )
