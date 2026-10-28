"""CV 模型权重的下载与校验（C-CV-01、C-CV-07、C-RU-06）：以本地 file:// 压缩包代替上游地址。"""

import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
import yaml

SCRIPT = Path(__file__).resolve().parents[1] / "models.py"
WEIGHTS = b"onnx weights"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def models(tmp_path: Path) -> Path:
    archive = tmp_path / "upstream.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("export/end2end.onnx", WEIGHTS)
        z.writestr("export/detail.json", "{}")
    models = tmp_path / "models"
    (models / "cards").mkdir(parents=True)
    (models / "cards/demo.md").write_text("# demo\n", encoding="utf-8")
    write_registry(
        models,
        name="demo",
        version="demo@1+hyd.1",
        task="pose",
        file="demo.onnx",
        sha256=sha256(WEIGHTS),
        source=archive.as_uri(),
        source_sha256=sha256(archive.read_bytes()),
        source_member="export/end2end.onnx",
        license="Apache-2.0",
        card="cards/demo.md",
        purpose="测试",
        owner="tester",
    )
    return models


def write_registry(models: Path, **entry: str) -> None:
    (models / "registry.yaml").write_text(yaml.safe_dump({"models": [entry]}), encoding="utf-8")


def update(models: Path, **changes: str) -> None:
    registry = yaml.safe_load((models / "registry.yaml").read_text(encoding="utf-8"))
    write_registry(models, **(registry["models"][0] | changes))


def run(command: str, models: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), command, str(models)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_fetch_then_verify(models: Path) -> None:
    fetched = run("fetch", models)

    assert fetched.returncode == 0, fetched.stderr
    assert (models / "weights/demo.onnx").read_bytes() == WEIGHTS
    assert run("verify", models).returncode == 0


def test_fetch_skips_valid_weights(models: Path) -> None:
    run("fetch", models)
    update(models, source="file:///nonexistent.zip")

    assert run("fetch", models).returncode == 0


def test_fetch_rejects_tampered_archive(models: Path) -> None:
    update(models, source_sha256="0" * 64)

    result = run("fetch", models)

    assert result.returncode == 1
    assert "压缩包哈希不符" in result.stderr
    assert not (models / "weights/demo.onnx").exists()


def test_fetch_rejects_unexpected_weights(models: Path) -> None:
    update(models, sha256="0" * 64)

    result = run("fetch", models)

    assert result.returncode == 1
    assert "权重哈希不符" in result.stderr
    assert not (models / "weights/demo.onnx").exists()


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"task": "face_recognition"}, "类别 face_recognition 不在白名单"),
        ({"license": "AGPL-3.0"}, "许可证 AGPL-3.0 不在白名单"),
        ({"card": "cards/missing.md"}, "缺少模型卡"),
        ({"sha256": "0" * 64}, "权重哈希不符"),
    ],
)
def test_verify_rejects(models: Path, changes: dict[str, str], message: str) -> None:
    run("fetch", models)
    update(models, **changes)

    result = run("verify", models)

    assert result.returncode == 1
    assert message in result.stderr


def test_verify_requires_fetched_weights(models: Path) -> None:
    result = run("verify", models)

    assert result.returncode == 1
    assert "make fetch-models" in result.stderr


def test_verify_requires_fields(models: Path) -> None:
    registry = yaml.safe_load((models / "registry.yaml").read_text(encoding="utf-8"))
    del registry["models"][0]["owner"]
    write_registry(models, **registry["models"][0])

    result = run("verify", models)

    assert result.returncode == 1
    assert "缺少字段 owner" in result.stderr


def test_fetch_bare_weights_file(models: Path, tmp_path: Path) -> None:
    """上游直接发布 .onnx 文件时不填 source_member，下载内容即权重（如 RF-DETR）。"""
    bare = tmp_path / "rfdetr.onnx"
    bare.write_bytes(WEIGHTS)
    update(models, source=bare.as_uri(), source_sha256=sha256(WEIGHTS), source_member="")

    assert run("fetch", models).returncode == 0
    assert (models / "weights/demo.onnx").read_bytes() == WEIGHTS
    assert run("verify", models).returncode == 0


def test_detection_task_allowed(models: Path) -> None:
    """人员与车辆检测（只到类别）在白名单内；人脸、ReID、属性识别仍不允许（G-04）。"""
    run("fetch", models)
    update(models, task="detection")

    assert run("verify", models).returncode == 0
