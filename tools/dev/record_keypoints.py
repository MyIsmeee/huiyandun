"""录制素材片段的骨骼轨迹，作行为判定的测试数据（TK-022）。

用法：HYD_DEVICE=cpu HYD_MODEL_FILE=<RTMO 模型> HYD_VEHICLE_MODEL_FILE=<RF-DETR 模型> \\
      uv run --package vision-engine python tools/dev/record_keypoints.py <视频> <输出.npz>

按固定 5 FPS 抽帧，经与检测链路相同的门控、检测与跟踪，保存每帧已确认轨迹的时刻、轨迹 ID、
关键点与置信度。只含数字，不含图像与人员裁剪（G-04）；坐标为视频原始分辨率的像素坐标。
"""

import os
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

from py_common.config import load_config
from vision_engine.detector import PoseDetector, TopDownPose, VehicleDetector
from vision_engine.pipeline import FPS, CameraPipeline
from vision_engine.runtime import VisionConfig, create_session


def main() -> None:
    record(sys.argv[1], sys.argv[2])


def record(source: str, output: str, max_s: float | None = None) -> None:
    """录制 source 的骨骼轨迹到 output（.npz）；模型与设备取 HYD_ 环境变量（VisionConfig）。
    source 为视频文件，或 RTSP 地址（如视觉引擎容器内的 rtsp://go2rtc:8554/<摄像头编号>）；
    实时流没有结尾，须给 max_s。"""
    if not source.startswith("rtsp://"):
        _record(source, output, max_s)
        return
    if max_s is None:
        raise SystemExit("实时流须指定录制时长")
    # 实时流先按墙上时钟抽成 FPS 帧/秒的临时视频，再离线检测：边取流边检测时 CPU 跟不上实时，转发端丢帧，
    # 按帧序号推算的时刻随之失真（倒地 10 s 可能只算出几秒）。临时视频含画面，检测完立即删除（G-04）
    handle, clip = tempfile.mkstemp(suffix=".mp4", dir=Path(output).parent)
    os.close(handle)
    try:
        times = _snapshot(source, clip, max_s)
        _record(clip, output, None, times)
    finally:
        os.unlink(clip)
    print(f"{source}: 按墙上时钟录 {max_s:g} s，临时视频已删除")


def _snapshot(source: str, clip: str, max_s: float) -> list[float]:
    """按墙上时钟每 1/FPS 秒存一帧到 clip，返回各帧的取得时刻（秒）：取流卡顿时如实留出间隔，不补帧。"""
    # 经 TCP 取流：UDP 丢包时解码出花屏帧，关键点随之失准，诊断会误判为"看不到"
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")
    capture = cv2.VideoCapture(source)
    ok, frame = capture.read()
    if not ok:
        raise SystemExit(f"无法读取实时流 {source}")
    height, width = frame.shape[:2]
    writer = cv2.VideoWriter(clip, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (width, height))
    start, times = time.monotonic(), []
    while ok and (elapsed := time.monotonic() - start) < max_s:
        if not times or elapsed - times[-1] >= 1 / FPS:
            writer.write(frame)
            times.append(elapsed)
        ok, frame = capture.read()
    writer.release()
    capture.release()
    return times


def _record(
    source: str, output: str, max_s: float | None, times: list[float] | None = None
) -> None:
    """times 为各帧的取得时刻（实时流暂存的临时视频）；不给时按帧序号与帧率推算。"""
    config = load_config(VisionConfig)
    assert config.vehicle_model_file is not None  # 人员框来自 RF-DETR 与 RTMO 的合并（#287）
    detector = PoseDetector(str(config.model_file), create_session(config, config.model_file, 2))
    if config.topdown_model_file:
        # 与检测链路一致：配置了 RTMPose 时按人员框逐人重新估计骨骼
        detector.topdown = TopDownPose(
            str(config.topdown_model_file), create_session(config, config.topdown_model_file, 2)
        )
    camera = CameraPipeline(
        "record",
        None,
        detector,
        vehicles=VehicleDetector(
            str(config.vehicle_model_file), create_session(config, config.vehicle_model_file, 2)
        ),
    )
    capture = cv2.VideoCapture(source)
    source_fps = capture.get(cv2.CAP_PROP_FPS)
    if not capture.isOpened() or not source_fps > 0:
        raise SystemExit(f"无法读取视频 {source}（须为带帧率的视频文件或可访问的 RTSP 地址）")
    rows: dict[str, list] = {"t": [], "track_id": [], "keypoints": [], "keypoint_scores": []}
    frame_t: list[float] = []  # 每个抽样帧的时刻，含画面中没有人的帧：回放时据此判定原地消失
    index, sampled = 0, 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        t = times[index] if times is not None else index / source_fps
        if max_s is not None and t >= max_s:
            break
        index += 1
        if t < sampled / FPS:
            continue
        sampled += 1
        frame_t.append(t)
        tracked, _ = camera.track(frame, t)
        for i in range(len(tracked)):
            rows["t"].append(t)
            rows["track_id"].append(tracked.tracker_id[i])
            rows["keypoints"].append(tracked.data["keypoints"][i])
            rows["keypoint_scores"].append(tracked.data["keypoint_scores"][i])
    np.savez_compressed(
        output,
        t=np.array(rows["t"], np.float32),
        frame_t=np.array(frame_t, np.float32),
        track_id=np.array(rows["track_id"], np.int32),
        keypoints=np.array(rows["keypoints"], np.float16).reshape(-1, 17, 2),
        keypoint_scores=np.array(rows["keypoint_scores"], np.float16).reshape(-1, 17),
        # 画面宽、高（像素）：诊断据此说明人在画面中的位置与大小（tools/dev/explain_behavior.py）
        frame_size=np.array(
            [capture.get(cv2.CAP_PROP_FRAME_WIDTH), capture.get(cv2.CAP_PROP_FRAME_HEIGHT)],
            np.int32,
        ),
    )
    print(f"{source}: {sampled} 帧，{len(rows['t'])} 条轨迹记录 → {output}")


if __name__ == "__main__":
    main()
