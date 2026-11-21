"""控制台登录爆破检测（HYD-WEB-0001）：阈值、去重期、来源地址。"""

from ipaddress import ip_address

from starlette.requests import Request

from api_server.login_guard import RULE_ID, THRESHOLD, WINDOW_S, LoginGuard, client_ip

HOST = ip_address("192.168.5.199")
ATTACKER = ip_address("192.168.5.23")


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def fail(guard: LoginGuard, times: int, src=ATTACKER) -> list:
    return [a for _ in range(times) if (a := guard.failed(src, "admin")) is not None]


def test_threshold_in_window_raises_one_alert() -> None:
    guard = LoginGuard(HOST, Clock())

    assert fail(guard, THRESHOLD - 1) == []
    [alert] = fail(guard, 1)
    assert (alert.rule_id, alert.category, alert.mode, alert.source) == (
        RULE_ID, "auth_bruteforce", "enforce", "rule",
    )  # fmt: skip
    assert (alert.src_ip, alert.dst_ip, alert.device_id) == (ATTACKER, HOST, None)
    assert alert.technique == "T1110" and alert.severity == "high"
    # 同一窗口内继续失败不再告警
    assert fail(guard, 30) == []


def test_continued_attack_alerts_once_per_window() -> None:
    clock = Clock()
    guard = LoginGuard(HOST, clock)
    assert len(fail(guard, THRESHOLD)) == 1

    clock.now += WINDOW_S + 1
    assert len(fail(guard, THRESHOLD)) == 1


def test_slow_failures_spread_beyond_window_do_not_alert() -> None:
    clock = Clock()
    guard = LoginGuard(HOST, clock)
    for _ in range(THRESHOLD * 3):
        assert fail(guard, 1) == []
        clock.now += WINDOW_S / (THRESHOLD - 1) + 1


def test_sources_counted_separately() -> None:
    guard = LoginGuard(HOST, Clock())
    other = ip_address("192.168.5.24")
    for _ in range(THRESHOLD - 1):
        fail(guard, 1)
        fail(guard, 1, other)
    assert [a.src_ip for a in fail(guard, 1, other)] == [other]


def request(headers: dict[str, str], peer: str | None = "172.20.0.5") -> Request:
    return Request(
        {
            "type": "http",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": (peer, 50000) if peer else None,
        }
    )


def test_client_ip_takes_address_set_by_proxy() -> None:
    # Caddy 追加的最后一项是它看到的对端；客户端自带的前几项可伪造
    assert client_ip(request({"X-Forwarded-For": "6.6.6.6, 192.168.5.23"})) == ATTACKER


def test_client_ip_falls_back_to_peer() -> None:
    assert client_ip(request({})) == ip_address("172.20.0.5")
    assert client_ip(request({"X-Forwarded-For": "garbage"})) == ip_address("172.20.0.5")
    assert client_ip(request({}, peer=None)) is None
