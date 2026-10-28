"""录制素材片段的骨骼轨迹，作行为判定的测试数据（TK-022）。

用法：HYD_DEVICE=cpu HYD_MODEL_FILE=<RTMO 模型> uv run --package vision-engine \\
      python tools/dev/record_keypoints.py <视频> <输出.npz>

按固定 5 FPS 抽帧，经与检测链路相同的门控、检测与跟踪，保存每帧已确认轨迹的时刻、轨迹 ID、
关键点与置信度。只含数字，不含图像与人员裁剪（G-04）；坐标为视频原始分辨率的像素坐标。
"""

import sys

import cv2
import numpy as np

from py_common.config import load_config
from vision_engine.detector import PoseDetector
from vision_engine.pipeline import FPS, CameraPipeline
from vision_engine.runtime import VisionConfig, create_session


def main() -> None:
    source, output = sys.argv[1], sys.argv[2]
    config = load_config(VisionConfig)
    camera = CameraPipeline(
        "record", None, PoseDetector(str(config.model_file), create_session(config))
    )
    capture = cv2.VideoCapture(source)
    source_fps = capture.get(cv2.CAP_PROP_FPS)
    rows: dict[str, list] = {"t": [], "track_id": [], "keypoints": [], "keypoint_scores": []}
    index, sampled = 0, 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        t = index / source_fps
        index += 1
        if t < sampled / FPS:
            continue
        sampled += 1
        tracked = camera.track(frame, t)
        for i in range(len(tracked)):
            rows["t"].append(t)
            rows["track_id"].append(tracked.tracker_id[i])
            rows["keypoints"].append(tracked.data["keypoints"][i])
            rows["keypoint_scores"].append(tracked.data["keypoint_scores"][i])
    np.savez_compressed(
        output,
        t=np.array(rows["t"], np.float32),
        track_id=np.array(rows["track_id"], np.int32),
        keypoints=np.array(rows["keypoints"], np.float16).reshape(-1, 17, 2),
        keypoint_scores=np.array(rows["keypoint_scores"], np.float16).reshape(-1, 17),
    )
    print(f"{source}: {sampled} 帧，{len(rows['t'])} 条轨迹记录 → {output}")


if __name__ == "__main__":
    main()
