"""推理会话（C-CV-11、C-HW-12、C-RU-06）：从本地模型文件创建 ONNX Runtime 会话并断言推理设备。

ONNX Runtime 在 CUDA 不可用时只记录警告并回退到 CPU；声明 cuda 时必须检查实际生效的 provider，
回退即报错退出，禁止静默降速运行。cpu 为 D0-min 显式声明的 CPU 模式（DP-06）。
"""

import logging
import sys
from pathlib import Path
from typing import Literal

import onnxruntime as ort
from pydantic import Field, FilePath

from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging

CUDA = "CUDAExecutionProvider"
CPU = "CPUExecutionProvider"

log = logging.getLogger(__name__)


class VisionConfig(ServiceConfig):
    device: Literal["cuda", "cpu"] = Field(
        description="推理设备，无默认值、须显式声明；cpu 为 D0-min 的 CPU 模式（C-CV-11、DP-06）"
    )
    model_file: FilePath = Field(description="RTMO ONNX 模型文件的本地路径（C-RU-06、DP-08）")
    vehicle_model_file: FilePath | None = Field(
        None,
        description="RF-DETR ONNX 模型文件的本地路径，检出车辆（REUSE-22、C-RU-06）；"
        "未配置时只检测人员（如关键点录制工具）",
    )
    gpu_mem_limit_mb: int = Field(
        2048,
        gt=0,
        description="整个识别服务的 CUDA 显存上限，单位 MiB，由加载的模型平分；"
        "与同机其他 GPU 进程共存（C-HW-12）",
    )
    site_file: Path = Field(
        Path("/etc/hyd/site.yaml"), description="站点配置 site.yaml：摄像头流名与标定点（FR-901）"
    )
    go2rtc_rtsp: str = Field(
        "rtsp://go2rtc:8554", description="go2rtc 的 RTSP 地址，流名取自 site.yaml（C-CV-10）"
    )
    heartbeat_file: Path = Field(
        Path("/tmp/hyd-vision-alive"), description="检测循环每个周期更新其修改时间，供健康检查判断"
    )


class DeviceError(RuntimeError):
    """声明 cuda 但 CUDAExecutionProvider 未生效（C-CV-11）。"""


def model_files(config: VisionConfig) -> list[Path]:
    """服务加载的全部模型：RTMO，以及配置了的 RF-DETR。"""
    return [config.model_file] + ([config.vehicle_model_file] if config.vehicle_model_file else [])


def create_session(config: VisionConfig, model_file: Path, models: int = 1) -> ort.InferenceSession:
    """models 为服务共加载的模型数：每个会话的显存上限取总上限的 1/models（C-HW-12）。"""
    if config.device == "cuda":
        providers: list[str | tuple[str, dict[str, int]]] = [
            (CUDA, {"gpu_mem_limit": config.gpu_mem_limit_mb * 2**20 // models}),
            CPU,
        ]
    else:
        providers = [CPU]
    session = ort.InferenceSession(str(model_file), providers=providers)
    active = session.get_providers()
    if config.device == "cuda" and active[0] != CUDA:
        raise DeviceError(f"HYD_DEVICE=cuda，但 ONNX Runtime 回退到 {active}，拒绝以 CPU 运行")
    return session


def gpu_check() -> None:
    """hyd-gpu-check：按配置加载全部模型并断言推理设备；声明 cuda 而未生效时以 1 退出。"""
    config = load_config(VisionConfig)
    configure_logging("vision-engine", config.log_level)
    try:
        files = model_files(config)
        sessions = [create_session(config, f, models=len(files)) for f in files]
    except DeviceError as e:
        log.error("vision.device_unavailable", extra={"error": str(e)})
        sys.exit(1)
    log.info(
        "vision.device_ready",
        extra={"device": config.device, "providers": [s.get_providers() for s in sessions]},
    )
