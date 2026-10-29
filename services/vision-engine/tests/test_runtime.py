"""推理会话与设备断言（C-CV-11、C-HW-12）：声明 cuda 而 CUDAExecutionProvider 未生效时拒绝运行。"""

import re
from pathlib import Path
from typing import Any

import onnxruntime as ort
import pytest
from onnxruntime.datasets import get_example
from pydantic import ValidationError

from py_common.config import load_config
from vision_engine import runtime
from vision_engine.runtime import (
    CPU,
    CUDA,
    DeviceError,
    VisionConfig,
    create_session,
    model_files,
)

MODEL = get_example("sigmoid.onnx")  # onnxruntime 自带的最小模型


def config(**env: str) -> VisionConfig:
    return load_config(
        VisionConfig, {"HYD_MODEL_FILE": MODEL, "HYD_VEHICLE_MODEL_FILE": MODEL} | env
    )


class FakeSession:
    """记录请求的 providers，并返回预设的实际生效 providers。"""

    active: list[str] = []
    requested: list[Any] = []

    def __init__(self, path: str, providers: list[Any]) -> None:
        FakeSession.requested = providers

    def get_providers(self) -> list[str]:
        return FakeSession.active


@pytest.fixture
def fake_session(monkeypatch: pytest.MonkeyPatch) -> type[FakeSession]:
    monkeypatch.setattr(ort, "InferenceSession", FakeSession)
    return FakeSession


def test_image_disables_onnxruntime_telemetry() -> None:
    """G-05：未关闭时 import onnxruntime 即连接 mobile.events.data.microsoft.com（抓包确认）。"""
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text(encoding="utf-8")

    assert re.search(r"^ENV .*\bORT_DISABLE_TELEMETRY=1\b", dockerfile, re.MULTILINE)


def test_cpu_mode_uses_only_cpu() -> None:
    session = create_session(config(HYD_DEVICE="cpu"), Path(MODEL))

    assert session.get_providers() == [CPU]


def test_cuda_active(fake_session: type[FakeSession]) -> None:
    fake_session.active = [CUDA, CPU]

    create_session(config(HYD_DEVICE="cuda", HYD_GPU_MEM_LIMIT_MB="1024"), Path(MODEL))

    assert fake_session.requested[0] == (CUDA, {"gpu_mem_limit": 1024 * 2**20})


def test_memory_limit_is_shared_by_loaded_models(fake_session: type[FakeSession]) -> None:
    """C-HW-12：HYD_GPU_MEM_LIMIT_MB 是整个服务的上限，加载的模型平分，总占用不超过该值。"""
    fake_session.active = [CUDA, CPU]
    cfg = config(HYD_DEVICE="cuda", HYD_GPU_MEM_LIMIT_MB="2048")
    limits = []
    for model_file in model_files(cfg):
        create_session(cfg, model_file, models=len(model_files(cfg)))
        limits.append(fake_session.requested[0][1]["gpu_mem_limit"])

    assert limits == [1024 * 2**20, 1024 * 2**20]


def test_vehicle_model_is_optional() -> None:
    """未配置车辆模型时只检测人员（如关键点录制工具），只加载一个模型、独占显存上限。"""
    cfg = load_config(VisionConfig, {"HYD_DEVICE": "cpu", "HYD_MODEL_FILE": MODEL})

    assert model_files(cfg) == [Path(MODEL)]


def test_cuda_fallback_to_cpu_is_refused(fake_session: type[FakeSession]) -> None:
    fake_session.active = [CPU]

    with pytest.raises(DeviceError, match="回退"):
        create_session(config(HYD_DEVICE="cuda"), Path(MODEL))


def test_device_must_be_declared() -> None:
    with pytest.raises(ValidationError, match="device"):
        config()


def test_model_file_must_exist(tmp_path: Path) -> None:
    with pytest.raises(ValidationError, match="model_file"):
        config(HYD_DEVICE="cpu", HYD_MODEL_FILE=str(tmp_path / "missing.onnx"))


def test_gpu_check_exits_on_fallback(
    fake_session: type[FakeSession], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_session.active = [CPU]
    monkeypatch.setenv("HYD_DEVICE", "cuda")
    monkeypatch.setenv("HYD_MODEL_FILE", MODEL)
    monkeypatch.setenv("HYD_VEHICLE_MODEL_FILE", MODEL)

    with pytest.raises(SystemExit) as exited:
        runtime.gpu_check()

    assert exited.value.code == 1


def test_gpu_check_passes_in_declared_cpu_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HYD_DEVICE", "cpu")
    monkeypatch.setenv("HYD_MODEL_FILE", MODEL)
    monkeypatch.setenv("HYD_VEHICLE_MODEL_FILE", MODEL)

    runtime.gpu_check()
