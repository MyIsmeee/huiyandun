"""tools/dev 下 make doctor 与 make demo-health 调用的脚本（HYD-DEP-005 §2、§5.2）。"""

import os
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "tools/dev/doctor.sh"
WAIT_HEALTHY = ROOT / "tools/dev/wait-healthy.sh"


def stub(bin_dir: Path, name: str, body: str) -> Path:
    path = bin_dir / name
    path.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def run(cmd: list[str], bin_dir: Path, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", **env},
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


@pytest.mark.parametrize(
    ("failing", "hint"),
    [
        ("nvidia-smi", "NVIDIA 驱动"),
        ("docker info", "Docker Engine"),
        ("docker run", "NVIDIA Container Toolkit"),
    ],
)
def test_doctor_stops_with_fix_hint(tmp_path: Path, failing: str, hint: str) -> None:
    stub(tmp_path, "nvidia-smi", "exit 1" if failing == "nvidia-smi" else "exit 0")
    stub(tmp_path, "docker", f'[ "docker $1" = "{failing}" ] && exit 1; exit 0')

    result = run([str(DOCTOR)], tmp_path)

    assert result.returncode != 0
    assert "修复：" in result.stderr
    assert hint in result.stderr
    assert "环境自检通过" not in result.stdout


def test_doctor_passes_when_all_checks_pass(tmp_path: Path) -> None:
    for name in ("nvidia-smi", "docker"):
        stub(tmp_path, name, "exit 0")

    result = run([str(DOCTOR)], tmp_path)

    assert result.returncode == 0, result.stderr


def fake_compose(tmp_path: Path, status: str, services: str = "nats\npostgres\n") -> list[str]:
    """按子命令输出固定内容：config 为应有的服务清单，ps 为各容器状态。"""
    (tmp_path / "config").write_text(services, encoding="utf-8")
    (tmp_path / "ps").write_text(status, encoding="utf-8")
    return [str(stub(tmp_path, "fake-compose", f'cat "{tmp_path}/$1"'))]


def ps(service: str, health: str, state: str = "running", code: int = 0, labels: str = "") -> str:
    """wait-healthy.sh 请求的 ps 格式：Service|Health|State|ExitCode|Labels。"""
    return f"{service}|{health}|{state}|{code}|{labels}\n"


ONESHOT = "com.docker.compose.project=huiyandun,hyd.oneshot=true"


@pytest.mark.parametrize(
    ("services", "status"),
    [
        ("nats\npostgres\n", ps("nats", "healthy") + ps("postgres", "healthy")),
        ("nats\nmigrate\n", ps("nats", "healthy") + ps("migrate", "", "exited", 0, ONESHOT)),
    ],
    ids=["healthy", "oneshot-completed"],
)
def test_wait_healthy_reports_ready(tmp_path: Path, services: str, status: str) -> None:
    compose = fake_compose(tmp_path, status, services)

    result = run([str(WAIT_HEALTHY), *compose], tmp_path)

    assert result.returncode == 0, result.stderr
    assert "就绪耗时" in result.stdout


@pytest.mark.parametrize(
    ("status", "pending"),
    [
        (ps("postgres", "starting"), "postgres starting"),
        (ps("postgres", "unhealthy"), "postgres unhealthy"),
        # 没有健康检查的服务 Health 为空，不能视为就绪
        (ps("postgres", ""), "postgres"),
        # 常驻服务退出码为 0 同样未就绪；只有一次性服务例外
        (ps("postgres", "", "exited", 0), "postgres"),
        (ps("postgres", "", "exited", 1, ONESHOT), "postgres exited(1)"),
        # 容器未创建时 ps 中没有该服务，须按应有清单发现
        ("", "postgres 未创建"),
    ],
)
def test_wait_healthy_times_out_listing_pending(tmp_path: Path, status: str, pending: str) -> None:
    compose = fake_compose(tmp_path, ps("nats", "healthy") + status)

    result = run([str(WAIT_HEALTHY), *compose], tmp_path, HEALTH_TIMEOUT="0")

    assert result.returncode != 0
    assert pending in result.stderr
    assert "nats" not in result.stderr


def test_wait_healthy_fails_without_services(tmp_path: Path) -> None:
    compose = fake_compose(tmp_path, "", services="")

    result = run([str(WAIT_HEALTHY), *compose], tmp_path, HEALTH_TIMEOUT="0")

    assert result.returncode != 0
    assert "未定义任何服务" in result.stderr
