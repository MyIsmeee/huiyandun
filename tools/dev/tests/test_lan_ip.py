"""本机局域网地址探测（D-143）：.env 显式值优先；取开销最小的默认路由网卡，排除代理 TUN 等假地址。"""

import importlib.util
import subprocess
from pathlib import Path

import pytest

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


def test_env_value_with_trailing_comment() -> None:
    """行尾注释不能让显式值被识别不出、静默换成探测结果（D-143）。"""
    assert lan_ip.configured("HYD_LAN_IP=10.1.2.3  # 现场固定\n") == "10.1.2.3"
    assert lan_ip.configured("HYD_LAN_IP=10.1.2.3 #\n") == "10.1.2.3"


def test_env_value_quoted() -> None:
    """与 docker compose 一致去掉引号，否则控制台地址等处会带上引号。"""
    assert lan_ip.configured('HYD_LAN_IP="10.1.2.3"  # 现场固定\n') == "10.1.2.3"
    assert lan_ip.configured("HYD_LAN_IP='10.1.2.3'\n") == "10.1.2.3"


def test_env_value_empty_falls_back_to_detection() -> None:
    """值为空时回退到探测，不能把下一行当成地址（compose 同样视为空值）。"""
    assert lan_ip.configured("HYD_LAN_IP=\nHYD_DEMO_QUIET=true\n") is None
    assert lan_ip.configured("HYD_LAN_IP=  # 待填\nFOO=1\n") is None


GBK_ERROR = "找不到网卡".encode("gbk")


def _fake_run(stdout: bytes, stderr: bytes = b"", raises: Exception | None = None):
    """仿 subprocess.run：要求按文本解码时，像真实实现一样按 UTF-8 解码输出。"""

    def run(args, **kwargs):
        if raises is not None:
            raise raises
        if kwargs.get("text") or kwargs.get("encoding") or kwargs.get("universal_newlines"):
            stderr.decode("utf-8")
        return subprocess.CompletedProcess(args, 0, stdout, stderr)

    return run


@pytest.fixture
def on_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lan_ip.shutil, "which", lambda _name: "/mnt/c/powershell.exe")


@pytest.mark.usefixtures("on_wsl")
def test_gbk_stderr_does_not_break_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    """中文 Windows 上 PowerShell 的报错是 GBK 编码，不能因解码失败而崩溃。"""
    stdout = b"30 192.168.5.221\r\n" + GBK_ERROR + b"\r\n"
    monkeypatch.setattr(lan_ip.subprocess, "run", _fake_run(stdout, GBK_ERROR))
    assert lan_ip.detect() == "192.168.5.221"


@pytest.mark.usefixtures("on_wsl")
@pytest.mark.parametrize(
    "error",
    [
        FileNotFoundError("powershell.exe"),
        subprocess.TimeoutExpired("powershell.exe", 20),
        subprocess.CalledProcessError(1, "powershell.exe", b"", GBK_ERROR),
    ],
)
def test_query_failure_gives_none(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    monkeypatch.setattr(lan_ip.subprocess, "run", _fake_run(b"", raises=error))
    assert lan_ip.detect() is None


def test_without_powershell_gives_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lan_ip.shutil, "which", lambda _name: None)
    assert lan_ip.detect() is None


@pytest.mark.usefixtures("on_wsl")
def test_main_falls_back_to_loopback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(lan_ip, "ENV", tmp_path / ".env")
    monkeypatch.setattr(lan_ip.subprocess, "run", _fake_run(GBK_ERROR, GBK_ERROR))
    lan_ip.main()
    out, err = capsys.readouterr()
    assert out == "127.0.0.1\n"
    assert "HYD_LAN_IP=<IP>" in err
