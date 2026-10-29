"""录制素材帧的场景分割结果，作场景感知的测试快照（TK-118）。

用法：HYD_DEVICE=cpu HYD_MODEL_FILE=<RTMO 模型> HYD_SCENE_MODEL_FILE=<分割模型> \\
      uv run --package vision-engine python tools/dev/record_scene.py <视频> <秒> <输出.npz>

取视频中指定时刻的一帧，经与检测链路相同的分割与类别归并，保存 64×64 的渲染类别编号、类别名与
画面尺寸，以及录制时的 ADE20K 映射表。只含类别编号，不含图像；人员与车辆不在渲染类别中，记为未识别（G-04）。
映射表或阈值变化后须重新录制。
"""

import sys
from collections import Counter

import cv2
import numpy as np

from py_common.config import load_config
from vision_engine.runtime import VisionConfig, create_session
from vision_engine.scene import CLASSES, LUT, Segmenter


def main() -> None:
    source, second, output = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    config = load_config(VisionConfig)
    assert config.scene_model_file is not None, "须配置 HYD_SCENE_MODEL_FILE"
    segmenter = Segmenter(create_session(config, config.scene_model_file))
    capture = cv2.VideoCapture(source)
    capture.set(cv2.CAP_PROP_POS_MSEC, second * 1000)
    ok, frame = capture.read()
    assert ok, f"{source} 在 {second} s 处无帧"
    labels = segmenter(frame)
    np.savez_compressed(
        output,
        labels=labels,
        classes=np.array(CLASSES),
        lut=LUT,
        shape=np.array(frame.shape[:2]),
    )
    names = ["未识别", *CLASSES]
    counts = Counter(labels.ravel().tolist()).most_common()
    print(", ".join(f"{names[i]} {n / labels.size:.0%}" for i, n in counts))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main()
