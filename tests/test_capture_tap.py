"""capture-tap.sh（C-SEC-08）：以假的 ip、tc、ethtool 记录调用，断言网桥源与网卡源两条路径。"""

import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "agents/sensor/capture-tap/capture-tap.sh"
LINK = {
    "bridge": '[{"ifname":"hyd-demo","linkinfo":{"info_kind":"bridge"}}]',
    "nic": '[{"ifname":"eth1"}]',
}


def run(
    tmp_path: Path, kind: str, ethtool_rc: int = 0
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    log = tmp_path / "calls.log"
    for name, body in {
        "ip": f'echo "ip $*" >> {log}; [ "$1" = -j ] && echo \'{LINK[kind]}\'; exit 0',
        "tc": f'echo "tc $*" >> {log}',
        "ethtool": f'echo "ethtool $*" >> {log}; exit {ethtool_rc}',
    }.items():
        stub = tmp_path / name
        stub.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
        stub.chmod(0o755)
    src = "hyd-demo" if kind == "bridge" else "eth1"
    result = subprocess.run(
        [str(SCRIPT), src, "hyd-tap"],
        env={**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return result, log.read_text(encoding="utf-8").splitlines()


def mirror(src: str) -> list[str]:
    return [
        f"tc qdisc replace dev {src} clsact",
        f"tc filter replace dev {src} ingress pref 1 handle 1 matchall action mirred egress mirror dev hyd-tap",
    ]


def no_address(dev: str) -> list[str]:
    return [f"ip link set dev {dev} addrgenmode none", f"ip -6 addr flush dev {dev}"]


def test_bridge_source_mirrors_span_port(tmp_path: Path) -> None:
    """网桥源：宿主在两个网桥上都不留地址，挂镜像端口并泛洪，镜像端口的入向流量送入探针网桥。"""
    result, calls = run(tmp_path, "bridge")

    assert result.returncode == 0, result.stderr
    assert calls[:2] == no_address("hyd-tap")
    assert set(no_address("hyd-demo")) <= set(calls)
    assert "ip link set hyd-span master hyd-demo up" in calls
    assert "ip link set hyd-demo type bridge ageing_time 0" in calls
    assert calls[-2:] == mirror("hyd-span-in")
    assert not any(c.startswith("ethtool") or "promisc" in c for c in calls)


@pytest.mark.parametrize("ethtool_rc", [0, 1], ids=["offload-off", "offload-unsupported"])
def test_nic_source_mirrors_promiscuous_nic(tmp_path: Path, ethtool_rc: int) -> None:
    """网卡源：开混杂模式（镜像帧的目标 MAC 不是本网卡），关闭 GRO/LRO；网卡不支持时只告警。"""
    result, calls = run(tmp_path, "nic", ethtool_rc)

    assert result.returncode == 0, result.stderr
    assert calls[:2] == no_address("hyd-tap")
    assert "ip link set dev eth1 promisc on" in calls
    assert "ethtool -K eth1 gro off lro off" in calls
    assert ("GRO/LRO" in result.stderr) == bool(ethtool_rc)
    assert calls[-2:] == mirror("eth1")
    assert not any("hyd-span" in c or "ageing_time" in c for c in calls)
