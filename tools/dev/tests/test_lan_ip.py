"""本机局域网地址探测（D-143）：.env 显式值优先；取开销最小的默认路由网卡，排除代理 TUN 等假地址。"""

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "lan_ip.py"
_spec = importlib.util.spec_from_file_location("lan_ip", SCRIPT)
assert _spec and _spec.loader
lan_ip = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lan_ip)


def test_proxy_tun_is_skipped_even_with_lowest_metric() -> None:
    """mihomo 等代理的 TUN 网卡（198.18.0.0/15）开销常为 0，不能选它。"""
    assert lan_ip.pick("30 192.168.5.221\n0 198.18.0.1\n") == "192.168.5.221"


def test_lowest_metric_wins_among_lan_adapters() -> None:
    assert lan_ip.pick("50 10.0.0.8\n25 192.168.1.20\n") == "192.168.1.20"


def test_link_local_loopback_and_garbage_are_ignored() -> None:
    lines = "5 169.254.3.4\n1 127.0.0.1\n警告：某条输出\n7 fe80::1\n40 172.20.10.2\n"
    assert lan_ip.pick(lines) == "172.20.10.2"


def test_nothing_usable() -> None:
    assert lan_ip.pick("") is None
    assert lan_ip.pick("0 198.18.0.1\n") is None


def test_env_value_takes_precedence() -> None:
    assert lan_ip.configured("# 注释\nHYD_LAN_IP=10.1.2.3\n") == "10.1.2.3"
    assert lan_ip.configured("HYD_DEMO_QUIET=true\n") is None
    assert lan_ip.configured("# HYD_LAN_IP=10.1.2.3\n") is None
