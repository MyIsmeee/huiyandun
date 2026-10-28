"""Compose 定义的静态约束：健康检查、digest 锁定、内部网络、复用组件登记。"""

import os
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


ONESHOT = [n for n, s in SERVICES.items() if s.get("labels", {}).get("hyd.oneshot") == "true"]


def base_images(name: str) -> list[str]:
    """服务实际使用的镜像：自研服务取其 Dockerfile 的全部基础镜像，不含引用前面构建阶段的 FROM。"""
    build = SERVICES[name].get("build")
    if build is None:
        return [SERVICES[name]["image"]]
    dockerfile = ROOT / "deploy/compose" / build["context"] / build["dockerfile"]
    froms = re.findall(r"^FROM (\S+)(?: AS (\S+))?", dockerfile.read_text(encoding="utf-8"), re.M)
    stages = {stage for _, stage in froms if stage}
    return [image for image, _ in froms if image not in stages]


@pytest.mark.parametrize("name", [n for n in SERVICES if n not in ONESHOT])
def test_service_has_healthcheck(name: str) -> None:
    """make demo-health 以 healthy 判定就绪，没有健康检查的服务永远不会就绪。"""
    assert SERVICES[name].get("healthcheck", {}).get("test")


@pytest.mark.parametrize("name", SERVICES)
def test_image_pinned_by_digest(name: str) -> None:
    """C-OPS-01、G-15。"""
    images = base_images(name)
    assert images and all("@sha256:" in image for image in images)


@pytest.mark.parametrize("name", SERVICES)
def test_image_registered(name: str) -> None:
    """C-RU-01：镜像引用与 deploy/third-party.yaml 逐字一致。"""
    assert set(base_images(name)) <= REGISTERED


@pytest.mark.parametrize("name", [n for n in SERVICES if n != "postgres" and n not in ONESHOT])
def test_long_running_service_lacks_owner_password(name: str) -> None:
    """G-13：常驻服务只持有应用账号口令，无法停用审计表触发器；属主口令只给一次性迁移。"""
    assert "postgres_password" not in SERVICES[name].get("secrets", [])


def test_doctor_image_registered() -> None:
    script = (ROOT / "tools/dev/doctor.sh").read_text(encoding="utf-8")
    image = re.search(r"^CUDA_IMAGE=(\S+)$", script, re.MULTILINE)
    assert image and image[1] in REGISTERED


EDGE = "edge-net"
EXPOSED = {"web-console", "go2rtc"}


@pytest.mark.parametrize("name", [n for n in COMPOSE["networks"] if n != EDGE])
def test_network_internal(name: str) -> None:
    """DP-05：例外（llm-gateway 出站）在对应服务加入时再声明。"""
    assert COMPOSE["networks"][name].get("internal") is True


def test_edge_network_blocks_egress() -> None:
    """DP-05、G-05：开放端口需要非 internal 网络；关闭 IP 伪装后容器仍无法出站。"""
    options = COMPOSE["networks"][EDGE]["driver_opts"]
    assert options["com.docker.network.bridge.enable_ip_masquerade"] == "false"


def test_only_exposed_services_publish_ports() -> None:
    """C-OPS-05：只有 DP-05 列出的服务开放端口，且只有它们接入 edge-net。"""
    assert {n for n, s in SERVICES.items() if s.get("ports")} == EXPOSED
    assert {n for n, s in SERVICES.items() if EDGE in s.get("networks", [])} == EXPOSED


def test_go2rtc_publishes_media_port_only() -> None:
    """C-OPS-05：go2rtc 只开放 WebRTC 媒体端口，API 不对外。"""
    assert {p.split(":")[-1] for p in SERVICES["go2rtc"]["ports"]} == {"8555/tcp", "8555/udp"}


def test_only_audit_service_holds_audit_password() -> None:
    """G-13：只有 audit-service 可写审计封存记录；postgres 仅在初始化时用它创建账号。"""
    holders = {n for n, s in SERVICES.items() if "db_audit_password" in s.get("secrets", [])}
    assert holders == {"audit-service", "postgres"}


@pytest.mark.parametrize("script", sorted((ROOT / "deploy/compose/postgres-init").glob("*.sh")))
def test_init_script_executable(script: Path) -> None:
    """不可执行的 .sh 会被 postgres 镜像 source 进自身启动流程，脚本的 set -eu 随之生效。"""
    assert os.access(script, os.X_OK)
