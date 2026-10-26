"""Compose 定义的静态约束：健康检查、digest 锁定、内部网络、复用组件登记。"""

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = yaml.safe_load((ROOT / "deploy/compose/compose.yaml").read_text(encoding="utf-8"))
SERVICES = COMPOSE["services"]
REGISTERED = {
    c["image"]
    for c in yaml.safe_load((ROOT / "deploy/third-party.yaml").read_text(encoding="utf-8"))[
        "components"
    ]
}


@pytest.mark.parametrize("name", SERVICES)
def test_service_has_healthcheck(name: str) -> None:
    """make demo-health 以 healthy 判定就绪，没有健康检查的服务永远不会就绪。"""
    assert SERVICES[name].get("healthcheck", {}).get("test")


@pytest.mark.parametrize("name", SERVICES)
def test_image_pinned_by_digest(name: str) -> None:
    """C-OPS-01、G-15。"""
    assert "@sha256:" in SERVICES[name]["image"]


@pytest.mark.parametrize("name", SERVICES)
def test_image_registered(name: str) -> None:
    """C-RU-01：镜像引用与 deploy/third-party.yaml 逐字一致。"""
    assert SERVICES[name]["image"] in REGISTERED


def test_doctor_image_registered() -> None:
    script = (ROOT / "tools/dev/doctor.sh").read_text(encoding="utf-8")
    image = re.search(r"^CUDA_IMAGE=(\S+)$", script, re.MULTILINE)
    assert image and image[1] in REGISTERED


@pytest.mark.parametrize("name", COMPOSE["networks"])
def test_network_internal(name: str) -> None:
    """DP-05：例外（web-console 443、llm-gateway 出站）在对应服务加入时再声明。"""
    assert COMPOSE["networks"][name].get("internal") is True
