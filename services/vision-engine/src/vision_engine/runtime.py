"""推理会话（C-CV-11、C-HW-12、C-RU-06）：从本地模型文件创建 ONNX Runtime 会话并断言推理设备。

ONNX Runtime 在 CUDA 不可用时只记录警告并回退到 CPU；声明 cuda 时必须检查实际生效的 provider，
回退即报错退出，禁止静默降速运行。cpu 为 D0-min 显式声明的 CPU 模式（DP-06）。
"""

import logging
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import onnxruntime as ort
from pydantic import Field, FilePath

from py_common.config import ServiceConfig, load_config
from py_common.log import configure_logging

TENSORRT = "TensorrtExecutionProvider"
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
        description="RF-DETR ONNX 模型文件的本地路径，检出车辆与人员框（REUSE-22、C-RU-06）；"
        "未配置时没有车辆，人员只有 RTMO 的正向检出",
    )
    topdown_model_file: FilePath | None = Field(
        None,
        description="RTMPose ONNX 模型文件的本地路径：按人员框逐人裁剪放大后重新估计骨骼（两阶段），"
        "远处、偏小的人关键点更准；未配置时骨骼只来自 RTMO",
    )
    action_model_file: FilePath | None = Field(
        None,
        description="STGCN++ ONNX 模型文件的本地路径：以骨骼序列复核跌倒与打架（action.py）；"
        "未配置时跌倒、打架只按骨骼几何规则判定",
    )
    violence_model_file: FilePath | None = Field(
        None,
        description="VideoMAE（RWF-2000 微调）ONNX 模型文件的本地路径：画面里两人贴近时按整幅画面判定打架"
        "（violence.py）；未配置时打架只按骨骼判定",
    )
    scene_model_file: FilePath | None = Field(
        None,
        description="EfficientViT-Seg ONNX 模型文件的本地路径，生成场景初稿时识别摄像头画面中的环境"
        "（REUSE-25、FR-909、D-133）；未配置时初稿提示未配置环境识别模型",
    )
    integrity_model_file: FilePath | None = Field(
        None,
        description="DINOv2 ONNX 模型文件的本地路径，判定画面重放（REUSE-23、FR-302）；"
        "未配置时只做冻结判定",
    )
    geometry_model_file: FilePath | None = Field(
        None,
        description="MoGe-2 ONNX 模型文件的本地路径，从画面拟合地面、建议摄像头安装几何；"
        "未配置时安装参数自检只靠站立行人",
    )
    gpu_mem_limit_mb: int = Field(
        2048,
        gt=0,
        description="整个识别服务的 CUDA 显存上限，单位 MiB，由加载的模型平分；"
        "与同机其他 GPU 进程共存（C-HW-12）",
    )
    go2rtc_rtsp: str = Field(
        "rtsp://go2rtc:8554",
        description="go2rtc 的 RTSP 地址，流名即摄像头编号，取自登记表（C-CV-10、D-101）",
    )
    heartbeat_file: Path = Field(
        Path("/tmp/hyd-vision-alive"),
        description="全部循环与读帧线程都有进展时每秒更新其修改时间，供健康检查判断（#79）",
    )
    tensorrt: bool = Field(
        False,
        description="device 为 cuda 时以 TensorRT 推理 RTMPose、RF-DETR、DINOv2、STGCN++（见 TRT_*）；"
        "首次启动按本机显卡构建引擎（每个模型 1～3 分钟），缓存在 trt_cache_dir",
    )
    trt_cache_dir: Path = Field(
        Path("/var/cache/hyd-trt"),
        description="TensorRT 引擎与计时缓存的目录，须可写并持久化：引擎按显卡与模型构建，换卡或换模型时自动重建",
    )


class DeviceError(RuntimeError):
    """声明 cuda 但 CUDAExecutionProvider 未生效（C-CV-11）。"""


# 逐人骨骼模型（RTMPose）单独的显存上限，不参与平分：它输入只有 192×256、逐人推理，所需远小于平分所得；
# 计入平分会让 RF-DETR 等大模型的份额从 1/4 降到 1/5，两路画面同时识别时 RF-DETR 申请不到显存（2026-11-17 实测）
TOPDOWN_MEM_MB = 256
# 动作模型（STGCN++）同样单独设上限：每路每秒推理一次，每批至多 action.MAX_BATCH 个片段。
# 2026-11-17 在 RTX 4060 上实测：128 MiB 时单个片段即申请不到（图卷积一次要约 40 MiB），192 MiB 批量 8 失败，
# 256 MiB 批量 4 约 16 ms
ACTION_MEM_MB = 256
# GPU 会话的 CPU 线程数：算子都在 GPU 上，留在 CPU 的只有形状运算（Gather、Concat 等，每次合计约 1 ms）。
# 默认每个会话按核数开线程池并自旋等待，8 个会话、5 路并发时数百个线程空转抢核，取流与前后处理被挤占
CUDA_CPU_THREADS = 1
# 画面级打架模型（VideoMAE-base，16 帧 224×224）单独设上限：只在两人贴近时每秒推理一次
VIOLENCE_MEM_MB = 512  # 半精度导出，实测 512 MiB 可用、单次约 38 ms（RTX 4060）


@dataclass(frozen=True)
class Trt:
    """以 TensorRT 推理的模型：输入名、输入形状的范围（固定形状时最小与最大相同；引擎按最大形状优化）与精度。"""

    name: str
    min_shape: tuple[int, ...]
    max_shape: tuple[int, ...]
    fp16: bool = True

    def shapes(self, shape: tuple[int, ...]) -> str:
        return f"{self.name}:{'x'.join(map(str, shape))}"


# TensorRT 与 CUDA 单精度的对照（2026-11-18，RTX 4060，人流素材实拍画面）：
# - RTMPose 半精度：16 人一批 17.6 → 5.1 ms，关键点与单精度绝大多数逐格相同
# - RF-DETR 只用单精度：16.8 → 12.4 ms，检测框与 CUDA 一致（IoU 中位 0.999）；半精度 4.7 ms，但框偏移
#   （IoU 中位 0.96）、阈值附近多出框、个别分数差 0.39，层归一化保持单精度也一样
# - DINOv2 半精度：3.7 → 1.0 ms，画面嵌入余弦相似度 0.99996
# - STGCN++ 半精度：一批 4 个 18.7 → 9.9 ms，动作概率相差不到 0.002
# RTMO 不用：后处理子图（TopK 等）TensorRT 建不出引擎，留在 CUDA 上；VideoMAE 已在导出时转为半精度，也留在 CUDA
TRT_TOPDOWN = Trt(
    "input", (1, 3, 256, 192), (16, 3, 256, 192)
)  # 批量上限即 detector.TOPDOWN_BATCHES[-1]
TRT_VEHICLE = Trt("input", (1, 3, 512, 512), (1, 3, 512, 512), fp16=False)  # detector.VEHICLE_INPUT
TRT_INTEGRITY = Trt("pixel_values", (1, 3, 224, 224), (1, 3, 224, 224))  # integrity.EMBED_INPUT
TRT_ACTION = Trt("keypoints", (4, 2, 100, 17, 3), (4, 2, 100, 17, 3))  # action.MAX_BATCH 个片段
# 构建引擎时可用的临时显存：4 个模型实测 512 MiB 都能选到最快的实现
TRT_WORKSPACE_MB = 512


def model_files(config: VisionConfig) -> list[Path]:
    """平分显存的模型：RTMO，以及配置了的 RF-DETR、DINOv2。"""
    # MoGe-2、EfficientViT-Seg 不在其中：每 10 分钟或生成场景初稿时才跑一次，固定用 CPU，不分显存
    # （pipeline.serve）。场景分割原也平分显存，常驻占一份额度；三路摄像头加上画面级打架模型后整卡显存耗尽、
    # 检测线程申请不到 cuBLAS 资源而反复重启（2026-11-18 实测），改到 CPU 腾出这一份。
    # RTMPose、STGCN++、VideoMAE 也不在其中：单独上限 TOPDOWN_MEM_MB、ACTION_MEM_MB、VIOLENCE_MEM_MB
    optional = [config.vehicle_model_file, config.integrity_model_file]
    return [config.model_file] + [f for f in optional if f]


def create_session(
    config: VisionConfig,
    model_file: Path,
    models: int = 1,
    limit_mb: int | None = None,
    threads: int | None = None,
    trt: Trt | None = None,
) -> ort.InferenceSession:
    """models 为平分显存的模型数：每个会话的显存上限取总上限的 1/models（C-HW-12）；limit_mb 给出时按它，不平分。
    threads 限制 CPU 推理的线程数；不给时 ONNX Runtime 按物理核数开满。

    trt 给出且配置了 tensorrt 时以 TensorRT 推理，它不支持的算子仍在 CUDA 上：显存上限只约束 CUDA 上的部分，
    TensorRT 引擎另占显存（比同一模型在 CUDA 上所需的少）。首次构建引擎在此完成，之后从 trt_cache_dir 读取。"""
    providers: list[str | tuple[str, dict[str, Any]]]
    if config.device == "cuda":
        limit = (limit_mb * 2**20) if limit_mb else config.gpu_mem_limit_mb * 2**20 // models
        providers = [(CUDA, {"gpu_mem_limit": limit}), CPU]
        if config.tensorrt and trt is not None:
            providers.insert(0, (TENSORRT, _trt_options(config, trt)))
    else:
        providers = [CPU]
    options = ort.SessionOptions()
    if config.device == "cuda" and threads is None:
        threads = CUDA_CPU_THREADS
    if threads is not None:
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
    if config.device == "cuda":
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    started = time.monotonic()
    session = ort.InferenceSession(str(model_file), sess_options=options, providers=providers)
    active = session.get_providers()
    expected = providers[0][0] if isinstance(providers[0], tuple) else providers[0]
    if config.device == "cuda" and active[0] != expected:
        # TensorRT 运行库缺失时 ONNX Runtime 同样只记警告、退回 CUDA：声明了就须生效（同 C-CV-11）
        raise DeviceError(f"要求 {expected}，但 ONNX Runtime 回退到 {active}，拒绝降速运行")
    log.info(
        "vision.session_ready",
        extra={
            "model": Path(model_file).name,
            "provider": active[0],
            "seconds": round(time.monotonic() - started, 1),
        },
    )
    return session


def _trt_options(config: VisionConfig, trt: Trt) -> dict[str, Any]:
    cache = str(config.trt_cache_dir)
    config.trt_cache_dir.mkdir(parents=True, exist_ok=True)
    return {
        "trt_fp16_enable": trt.fp16,
        "trt_engine_cache_enable": True,
        "trt_engine_cache_path": cache,
        "trt_timing_cache_enable": True,
        "trt_timing_cache_path": cache,
        "trt_max_workspace_size": TRT_WORKSPACE_MB * 2**20,
        "trt_profile_min_shapes": trt.shapes(trt.min_shape),
        "trt_profile_max_shapes": trt.shapes(trt.max_shape),
        "trt_profile_opt_shapes": trt.shapes(trt.max_shape),
    }


def gpu_check() -> None:
    """hyd-gpu-check：按配置加载全部模型并断言推理设备；声明 cuda 而未生效时以 1 退出。"""
    config = load_config(VisionConfig)
    configure_logging("vision-engine", config.log_level)
    try:
        files = model_files(config)
        engines = {
            config.vehicle_model_file: TRT_VEHICLE,
            config.integrity_model_file: TRT_INTEGRITY,
        }
        sessions = [create_session(config, f, len(files), trt=engines.get(f)) for f in files]
        if config.topdown_model_file:
            sessions.append(
                create_session(
                    config, config.topdown_model_file, limit_mb=TOPDOWN_MEM_MB, trt=TRT_TOPDOWN
                )
            )
        if config.action_model_file:
            sessions.append(
                create_session(
                    config, config.action_model_file, limit_mb=ACTION_MEM_MB, trt=TRT_ACTION
                )
            )
        if config.violence_model_file:
            sessions.append(
                create_session(config, config.violence_model_file, limit_mb=VIOLENCE_MEM_MB)
            )
    except DeviceError as e:
        log.error("vision.device_unavailable", extra={"error": str(e)})
        sys.exit(1)
    log.info(
        "vision.device_ready",
        extra={"device": config.device, "providers": [s.get_providers() for s in sessions]},
    )
