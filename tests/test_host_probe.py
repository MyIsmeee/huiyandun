"""主机探针（agents/sensor/host-probe）：登录爆破、日志篡改与正常轮转；输出经 correlator 的归一化可读。"""

import importlib.util
import json
import os
from ipaddress import ip_address
from pathlib import Path

import pytest

from correlator.normalize import normalize

SCRIPT = Path(__file__).resolve().parents[1] / "agents/sensor/host-probe/host_probe.py"
_spec = importlib.util.spec_from_file_location("host_probe", SCRIPT)
assert _spec and _spec.loader
hp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hp)

HOST = "172.30.0.12"
FAIL = "Nov 16 10:00:00 cam sshd[1]: Failed password for root from 198.51.100.7 port 4022 ssh2\n"


class Clock:
    def __init__(self) -> None:
        self.now = 1_800_000_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def log(tmp_path: Path) -> Path:
    path = tmp_path / "auth.log"
    path.write_text("Nov 16 09:00:00 cam sshd[1]: Server listening on 0.0.0.0 port 22.\n" * 20)
    return path


def probe(log: Path) -> tuple["hp.Probe", Clock]:
    clock = Clock()
    return hp.Probe([log], HOST, clock), clock


def append(path: Path, text: str) -> None:
    with path.open("a") as f:
        f.write(text)


def rules(alerts: list[dict]) -> list[str]:
    return [a["alert"]["metadata"]["hyd_rule_id"][0] for a in alerts]


def test_bruteforce_alerts_once_per_window(log: Path) -> None:
    p, clock = probe(log)
    append(log, FAIL * 4)
    assert p.poll() == []  # 4 次不足门限
    append(log, FAIL * 3)
    found = p.poll()
    assert rules(found) == ["HYD-HOST-0001"]
    assert (found[0]["src_ip"], found[0]["dest_ip"]) == ("198.51.100.7", HOST)
    append(log, FAIL * 5)
    assert p.poll() == []  # 同一时间窗只告警一次
    clock.now += hp.WINDOW_S + 1
    append(log, FAIL * 5)
    assert rules(p.poll()) == ["HYD-HOST-0001"]


@pytest.mark.parametrize(
    "line",
    [
        "sshd[2]: Failed password for invalid user admin from 198.51.100.7 port 1 ssh2",
        "sshd[2]: Invalid user test from 198.51.100.7 port 1",
        "login[3]: pam_unix(login:auth): authentication failure; logname= uid=0 rhost=198.51.100.7",
        "webui: Login failed for user admin from 198.51.100.7",
    ],
)
def test_failure_formats_recognized(log: Path, line: str) -> None:
    p, _ = probe(log)
    append(log, (line + "\n") * hp.THRESHOLD)
    assert [a["src_ip"] for a in p.poll()] == ["198.51.100.7"]


def test_existing_content_is_baseline(log: Path) -> None:
    """启动前已有的失败记录不告警：只跟随新写入。"""
    append(log, FAIL * 10)
    p, _ = probe(log)
    assert p.poll() == []


def test_truncation_is_tamper(log: Path) -> None:
    p, _ = probe(log)
    log.write_text("")
    found = p.poll()
    assert rules(found) == ["HYD-HOST-0002"] and "truncated" in found[0]["alert"]["signature"]
    assert p.poll() == []  # 以截断后的内容为新基线


def test_in_place_rewrite_is_tamper(log: Path) -> None:
    """抹掉几行再写回同一文件（同一 inode、长度不变或变长）。"""
    p, _ = probe(log)
    data = log.read_bytes()
    with log.open("r+b") as f:
        f.write(data[:100].replace(b"listening", b"LISTENING"))
    assert rules(p.poll()) == ["HYD-HOST-0002"]


def test_replaced_with_edited_copy_is_tamper(log: Path) -> None:
    """复制、删改中间几行、再替换原文件（sed -i 即如此）：开头相同、已读部分对不上。"""
    p, _ = probe(log)
    lines = log.read_text().splitlines(keepends=True)
    edited = log.with_suffix(".tmp")
    edited.write_text("".join(lines[:5] + lines[8:]))
    os.replace(edited, log)
    found = p.poll()
    assert rules(found) == ["HYD-HOST-0002"] and "edited copy" in found[0]["alert"]["signature"]


def test_intact_copy_keeps_following(log: Path) -> None:
    p, _ = probe(log)
    copy = log.with_suffix(".tmp")
    copy.write_bytes(log.read_bytes() + FAIL.encode() * hp.THRESHOLD)
    os.replace(copy, log)
    assert rules(p.poll()) == ["HYD-HOST-0001"]  # 只读到新增的部分


def test_rotation_is_not_tamper(log: Path) -> None:
    """正常轮转：旧文件改名，新文件从头写起。"""
    p, _ = probe(log)
    log.rename(log.with_suffix(".log.1"))
    assert p.poll() == []  # 删除后的宽限期内
    log.write_text("Nov 16 11:00:00 cam syslogd: restart\n" + FAIL * hp.THRESHOLD)
    assert rules(p.poll()) == ["HYD-HOST-0001"]


def test_deleted_without_replacement_is_tamper(log: Path) -> None:
    p, clock = probe(log)
    log.unlink()
    assert p.poll() == []
    clock.now += hp.GRACE_S
    found = p.poll()
    assert rules(found) == ["HYD-HOST-0002"] and "deleted" in found[0]["alert"]["signature"]
    assert p.poll() == []


def test_output_normalizes_into_security_alerts(log: Path) -> None:
    """correlator 以同一套归一化读取：爆破为 enforce、可封禁；篡改为 monitor、只告警。"""
    p, _ = probe(log)
    append(log, FAIL * hp.THRESHOLD)
    brute = p.poll()[0]
    log.write_text("")
    tamper = p.poll()[0]
    devices = {ip_address(HOST): "cam-02"}
    a = normalize(json.dumps(brute), devices)
    b = normalize(json.dumps(tamper), devices)
    assert a is not None and b is not None
    assert (a.rule_id, a.category, a.mode, a.device_id, str(a.src_ip)) == (
        "HYD-HOST-0001", "auth_bruteforce", "enforce", "cam-02", "198.51.100.7"
    )  # fmt: skip
    assert (b.rule_id, b.category, b.mode, b.technique) == (
        "HYD-HOST-0002", "log_tamper", "monitor", "T1070"
    )  # fmt: skip


def test_unreadable_log_is_not_tamper(log: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """无权读取（如容器缺少读权限）不是篡改：只提示，恢复可读后以当时内容为基线。"""
    p, _ = probe(log)
    real_open = Path.open

    def denied(self: Path, *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        if self == log:
            raise PermissionError("Permission denied")
        return real_open(self, *args, **kwargs)

    monkeypatch.setattr(Path, "open", denied)
    with real_open(log, "a") as f:
        f.write(FAIL * hp.THRESHOLD)
    assert p.poll() == [] and p.poll() == []
    monkeypatch.setattr(Path, "open", real_open)
    assert p.poll() == []  # 恢复可读：不把期间写入的内容判为爆破或篡改
    append(log, FAIL * hp.THRESHOLD)
    assert rules(p.poll()) == ["HYD-HOST-0001"]


def test_inactive_sources_are_forgotten(log: Path) -> None:
    """不再活跃的来源整条删除：常驻进程的内存只随近期来源数增长。"""
    p, clock = probe(log)
    append(log, "".join(FAIL.replace("198.51.100.7", f"198.51.100.{i}") for i in range(50)))
    p.poll()
    assert len(p.failures) == 50
    clock.now += hp.WINDOW_S + 1
    p.poll()
    assert p.failures == {} and p.quiet_until == {}


def test_settled_log_is_not_rehashed(log: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """已静止的日志 ctime 不变时不再重读已读部分；之后的任何写入都会改变 ctime，篡改照常检出。"""
    real = hp.time.time_ns
    monkeypatch.setattr(hp.time, "time_ns", lambda: real() + 10**10)  # 日志 10 秒前写过
    hashed: list[Path] = []
    original = hp._hash
    monkeypatch.setattr(hp, "_hash", lambda path, size: hashed.append(path) or original(path, size))
    p, _ = probe(log)
    assert p.poll() == [] and len(hashed) == 1
    assert p.poll() == [] and len(hashed) == 1
    data = log.read_bytes()
    with log.open("r+b") as f:
        f.write(data[:100].replace(b"listening", b"LISTENING"))
    assert rules(p.poll()) == ["HYD-HOST-0002"]
