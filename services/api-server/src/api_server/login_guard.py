"""控制台登录爆破检测（HYD-WEB-0001）：同一来源 WINDOW_S 内登录失败 THRESHOLD 次即发布网络告警。

控制台（https://<HYD_LAN_IP>）在宿主网卡上对外提供，网络探针只监听镜像来的被监测网络，且登录走 HTTPS、
看不到拒绝响应；登录失败只有 api-server 自己知道，故由它判定。规则与主机探针的 HYD-HOST-0001 相同：
判定确定、上线即 enforce，每个时间窗只告警一次，攻击持续时每个窗口再告警一次。

目标是平台自身，不在摄像头登记表中（device_id 为 null）：告警在控制台显示，不关联成事件、不自动处置（FR-203）。
"""

import logging
import time
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from datetime import UTC, datetime
from ipaddress import IPv4Address, IPv6Address, ip_address

from starlette.requests import Request

from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1

RULE_ID = "HYD-WEB-0001"
RULE_VERSION = "1"
SCHEMA_VERSION = "1.2.0"  # 与 correlator 归一化的告警同一版本
WINDOW_S = 60.0
THRESHOLD = 5
# 每个来源最多记录的失败次数：超过阈值的部分不影响判定，只防止单一来源撑大内存
MAX_PER_SOURCE = THRESHOLD * 4

type Ip = IPv4Address | IPv6Address

log = logging.getLogger(__name__)


def client_ip(request: Request) -> Ip | None:
    """登录请求的来源地址。请求只经 web-console 的 Caddy 到达（C-OPS-05）：Caddy 不信任客户端自带的
    X-Forwarded-For，改写为它看到的对端地址，取最后一项即真实来源；不经代理时取连接对端。"""
    forwarded = request.headers.get("x-forwarded-for", "").rsplit(",", 1)[-1].strip()
    for candidate in (forwarded, request.client.host if request.client else ""):
        try:
            return ip_address(candidate)
        except ValueError:
            continue
    return None


class LoginGuard:
    def __init__(self, host_ip: Ip, clock: Callable[[], float] = time.monotonic) -> None:
        self._host_ip = host_ip
        self._clock = clock
        self._failures: dict[Ip, deque[float]] = defaultdict(lambda: deque(maxlen=MAX_PER_SOURCE))
        self._quiet_until: dict[Ip, float] = {}

    def failed(self, src: Ip, username: str) -> SecurityAlertV1 | None:
        """记一次登录失败；达到阈值且不在去重期内时返回要发布的告警。"""
        now = self._clock()
        self._expire(now)
        q = self._failures[src]
        q.append(now)
        if len(q) < THRESHOLD or now < self._quiet_until.get(src, 0):
            return None
        self._quiet_until[src] = now + WINDOW_S
        return SecurityAlertV1(
            schema_version=SCHEMA_VERSION,
            event_id=uuid.uuid4(),
            ts=datetime.now(UTC),
            rule_id=RULE_ID,
            rule_version=RULE_VERSION,
            mode="enforce",
            category="auth_bruteforce",
            severity="high",
            src_ip=src,
            dst_ip=self._host_ip,
            device_id=None,
            technique="T1110",
            evidence_ref=f"api-server:auth/{src}",
            source="rule",
            confidence=1.0,
            summary=(
                f"{RULE_ID} console login brute force: {len(q)} failed logins from {src} "
                f"in {WINDOW_S:g}s (last user {username!r})"
            ),
        )

    def _expire(self, now: float) -> None:
        """丢弃窗口外的失败记录；不再活跃的来源整条删除，表的大小只随近期来源数增长。"""
        for src in list(self._failures):
            q = self._failures[src]
            while q and now - q[0] > WINDOW_S:
                q.popleft()
            if not q and now >= self._quiet_until.get(src, 0):
                del self._failures[src]
                self._quiet_until.pop(src, None)
