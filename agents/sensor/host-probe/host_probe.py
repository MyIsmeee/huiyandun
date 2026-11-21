#!/usr/bin/env python3
"""主机轻量探针（PPT"旁路镜像 · 主机探针双模式"）：在被保护的主机上跟随登录日志、守护日志文件，只用标准库。

输出与 Suricata EVE 同格式的告警行（一行一个 JSON），correlator 以同一套归一化读取（HYD_HOST_EVE_FILE），
告警随之进入关联与处置：登录爆破命中 HYD-NET-0101 即封禁攻击源。只写告警，不上传日志原文。

两条规则：
- HYD-HOST-0001 登录爆破：同一来源 WINDOW_S 内登录失败 THRESHOLD 次（sshd、PAM、通用"login failed … from <IP>"），
  每个时间窗只告警一次。日志由主机自己写，判定确定，上线即 enforce。
- HYD-HOST-0002 日志篡改：已读过的日志内容消失或被改写——
  · 同一文件变短（被截断）；
  · 同一文件已读部分的哈希变了（原地改写，如抹掉某几行后写回）；
  · 文件被替换为新文件，新文件开头与旧文件相同但已读部分对不上（复制后删改再替换）；
  · 文件被删除且 GRACE_S 内没有出现新文件。
  正常轮转（旧文件改名、新文件从头写起）不告警。没有攻击源，只告警、不处置：monitor。

用法：python host_probe.py <输出 EVE 文件> <日志文件>...；环境变量 HYD_HOST_IP 为本机在被监测网络中的地址，
作为告警的目标地址（correlator 据此对应到登记的设备）。
"""

import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

WINDOW_S = 60.0
THRESHOLD = 5
GRACE_S = 10.0  # 删除后等待新文件出现的时长（轮转时改名与新建之间有间隙）
POLL_S = 1.0
HEARTBEAT = Path("/tmp/hyd-host-probe-alive")  # 每个周期更新，供容器健康检查
HEAD_BYTES = 256  # 用于辨认"同一份日志的拷贝"的开头长度

# 登录失败 → 来源地址
FAILED = [
    re.compile(
        r"Failed (?:password|publickey|keyboard-interactive/pam) for (?:invalid user )?\S+ from (?P<ip>[0-9a-fA-F:.]+)"
    ),
    re.compile(r"Invalid user \S* ?from (?P<ip>[0-9a-fA-F:.]+)"),
    re.compile(r"authentication failure;.*\brhost=(?P<ip>[0-9a-fA-F:.]+)"),
    re.compile(r"(?i)login (?:failed|failure).*?\bfrom (?P<ip>[0-9a-fA-F:.]+)"),
]

RULES = {
    "HYD-HOST-0001": {
        "sid": 1000101, "category": "auth_bruteforce", "mode": "enforce", "severity": 1,
        "technique": ("T1110", "Brute_Force"), "tactic": ("TA0006", "Credential_Access"),
        "msg": "HYD-HOST-0001 host login brute force",
    },
    "HYD-HOST-0002": {
        "sid": 1000102, "category": "log_tamper", "mode": "monitor", "severity": 1,
        "technique": ("T1070", "Indicator_Removal"), "tactic": ("TA0005", "Defense_Evasion"),
        "msg": "HYD-HOST-0002 log file tampered",
    },
}  # fmt: skip


def alert(rule_id: str, src: str, dst: str, detail: str, now: float, flow: int) -> dict:
    """Suricata EVE 告警行；字段与 correlator.normalize 读取的一致。"""
    rule = RULES[rule_id]
    technique, tactic = rule["technique"], rule["tactic"]
    return {
        "timestamp": datetime.fromtimestamp(now, UTC).isoformat(),
        "flow_id": flow,
        "event_type": "alert",
        "src_ip": src,
        "dest_ip": dst,
        "alert": {
            "signature_id": rule["sid"],
            "rev": 1,
            "signature": f"{rule['msg']}: {detail}",
            "category": rule["category"],
            "severity": rule["severity"],
            "metadata": {
                "hyd_rule_id": [rule_id],
                "hyd_category": [rule["category"]],
                "hyd_mode": [rule["mode"]],
                "mitre_tactic_id": [tactic[0]],
                "mitre_tactic_name": [tactic[1]],
                "mitre_technique_id": [technique[0]],
                "mitre_technique_name": [technique[1]],
            },
        },
    }


@dataclass
class Watched:
    """一个日志文件：已读到的位置、已读部分的哈希与开头。"""

    path: Path
    inode: int | None = None
    offset: int = 0
    digest: "hashlib._Hash" = field(default_factory=hashlib.sha256)
    head: bytes = b""
    partial: bytes = b""
    missing_since: float | None = None
    unreadable: bool = False  # 无权读取：只提示一次，不判篡改


def _hash(path: Path, size: int) -> str | None:
    h = hashlib.sha256()
    try:
        with path.open("rb") as f:
            remaining = size
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    return None
                h.update(chunk)
                remaining -= len(chunk)
    except OSError:
        return None
    return h.hexdigest()


class Probe:
    def __init__(self, paths: list[Path], host_ip: str, clock=time.time) -> None:
        self.files = [Watched(p) for p in paths]
        self.host_ip = host_ip
        self.clock = clock
        self.failures: dict[str, deque[float]] = defaultdict(deque)
        self.quiet_until: dict[str, float] = {}
        self.flow = 0
        for w in self.files:  # 启动时已有的内容视为基线，只跟随新写入
            self._reset(w, read_existing=True)

    def _emit(self, rule_id: str, src: str, detail: str) -> dict:
        self.flow += 1
        return alert(rule_id, src, self.host_ip, detail, self.clock(), self.flow)

    def _reset(self, w: Watched, read_existing: bool) -> None:
        w.inode, w.offset, w.digest, w.head, w.partial = None, 0, hashlib.sha256(), b"", b""
        try:
            st = w.path.stat()
        except FileNotFoundError:
            return
        w.inode = st.st_ino
        if read_existing:
            self._consume(w, parse=False)

    def _consume(self, w: Watched, parse: bool = True) -> list[dict]:
        try:
            with w.path.open("rb") as f:
                f.seek(w.offset)
                data = f.read()
        except OSError:
            return []
        if not data:
            return []
        w.offset += len(data)
        w.digest.update(data)
        if len(w.head) < HEAD_BYTES:
            w.head = (w.head + data)[:HEAD_BYTES]
        *lines, w.partial = (w.partial + data).split(b"\n")
        found = []
        if parse:
            for raw in lines:
                found += self._line(raw.decode("utf-8", "replace"))
        return found

    def _line(self, text: str) -> list[dict]:
        for pattern in FAILED:
            if m := pattern.search(text):
                return self._failure(m.group("ip"))
        return []

    def _failure(self, ip: str) -> list[dict]:
        now = self.clock()
        q = self.failures[ip]
        q.append(now)
        while q and now - q[0] > WINDOW_S:
            q.popleft()
        if len(q) >= THRESHOLD and now >= self.quiet_until.get(ip, 0):
            self.quiet_until[ip] = now + WINDOW_S
            return [
                self._emit(
                    "HYD-HOST-0001", ip, f"{len(q)} failed logins from {ip} in {WINDOW_S:g}s"
                )
            ]
        return []

    def poll(self) -> list[dict]:
        found: list[dict] = []
        for w in self.files:
            found += self._check(w)
        return found

    def _check(self, w: Watched) -> list[dict]:
        now = self.clock()
        try:
            st = w.path.stat()
        except FileNotFoundError:
            if w.inode is not None and w.missing_since is None:
                w.missing_since = now
            if w.missing_since is not None and now - w.missing_since >= GRACE_S:
                w.missing_since = None
                read = w.offset
                self._reset(w, read_existing=False)
                return [
                    self._emit(
                        "HYD-HOST-0002", self.host_ip, f"{w.path} deleted after {read} bytes"
                    )
                ]
            return []
        w.missing_since = None
        try:
            with w.path.open("rb"):
                pass
        except OSError as e:
            if not w.unreadable:
                w.unreadable = True
                print(f"host-probe: 无法读取 {w.path}：{e}", file=sys.stderr)
            return []
        if w.unreadable:  # 恢复可读：以当前内容为基线重新跟随
            w.unreadable = False
            self._reset(w, read_existing=True)
            return []
        if w.inode is None:  # 文件出现（首次或删除后新建）：从头跟随
            self._reset(w, read_existing=False)
            return self._consume(w)
        if st.st_ino != w.inode:
            return self._replaced(w)
        if st.st_size < w.offset:
            read = w.offset
            self._reset(w, read_existing=True)
            return [
                self._emit(
                    "HYD-HOST-0002",
                    self.host_ip,
                    f"{w.path} truncated from {read} to {st.st_size} bytes",
                )
            ]
        if _hash(w.path, w.offset) != w.digest.hexdigest():
            self._reset(w, read_existing=True)
            return [self._emit("HYD-HOST-0002", self.host_ip, f"{w.path} rewritten in place")]
        return self._consume(w)

    def _replaced(self, w: Watched) -> list[dict]:
        """换了文件：开头相同说明是同一份日志的拷贝——已读部分须原样保留，否则视为篡改；开头不同为正常轮转。"""
        try:
            with w.path.open("rb") as f:
                head = f.read(len(w.head))
        except OSError:
            return []
        if w.head and head == w.head:
            intact = _hash(w.path, w.offset) == w.digest.hexdigest()
            if intact:  # 原样拷贝后继续写：沿用已读位置
                w.inode = w.path.stat().st_ino
                return self._consume(w)
            self._reset(w, read_existing=True)
            return [
                self._emit("HYD-HOST-0002", self.host_ip, f"{w.path} replaced by an edited copy")
            ]
        self._reset(w, read_existing=False)
        return self._consume(w)


def main() -> int:
    out, paths = Path(sys.argv[1]), [Path(p) for p in sys.argv[2:]]
    host_ip = os.environ.get("HYD_HOST_IP", "")
    if not paths or not host_ip:
        print(
            "用法：HYD_HOST_IP=<本机地址> host_probe.py <输出 EVE 文件> <日志文件>...",
            file=sys.stderr,
        )
        return 2
    probe = Probe(paths, host_ip)
    print(f"host-probe: watching {', '.join(map(str, paths))}", file=sys.stderr)
    while True:
        HEARTBEAT.touch()
        alerts = probe.poll()
        if alerts:
            with out.open("a", encoding="utf-8") as f:
                for a in alerts:
                    f.write(json.dumps(a, ensure_ascii=False) + "\n")
                    print(a["alert"]["signature"], file=sys.stderr)
        time.sleep(POLL_S)


if __name__ == "__main__":
    sys.exit(main())
