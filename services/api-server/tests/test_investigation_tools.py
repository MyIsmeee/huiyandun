"""值班员只读工具（TK-116、FR-1101）：过滤与时间窗、截断、拒绝越权工具与非法参数、日志缺失、超时。"""

import asyncio
import json
import threading
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from api_server import investigation_tools
from api_server.devices import Devices
from api_server.history import History
from api_server.investigation_tools import Tools
from api_server.site import load
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

SITE = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
NOW = datetime.now(UTC)
ATTACKER = "172.30.0.100"
TECHNIQUES = {"T1110": {"name": "Brute Force", "tactics": ["Credential Access"]}}


def common(minutes_ago: float) -> dict[str, Any]:
    return {"schema_version": "1.1.0", "event_id": uuid.uuid4(),
            "ts": NOW - timedelta(minutes=minutes_ago)}  # fmt: skip


def alert(
    minutes_ago: float, src: str = ATTACKER, summary: str = "RTSP 认证爆破"
) -> SecurityAlertV1:
    return SecurityAlertV1(
        **common(minutes_ago), rule_id="HYD-NET-0001", rule_version="3", mode="enforce",
        category="auth_bruteforce", severity="high", src_ip=src, dst_ip="172.30.0.12",
        device_id="cam-02", technique="T1110", evidence_ref="eve:1", source="rule",
        confidence=1.0, summary=summary,
    )  # fmt: skip


def behavior(minutes_ago: float, camera: str = "cam-02") -> VisionBehaviorV1:
    ts = NOW - timedelta(minutes=minutes_ago)
    return VisionBehaviorV1(
        **common(minutes_ago) | {"schema_version": "1.0.0"}, camera_id=camera, track_id=1,
        behavior="climb", confidence_avg=0.8, duration_s=2.0, ts_start=ts, ts_end=ts,
    )  # fmt: skip


def integrity(minutes_ago: float, camera: str = "cam-02") -> VisionIntegrityV1:
    return VisionIntegrityV1(
        **common(minutes_ago), camera_id=camera, type="freeze", duration_s=5.0, source="rule",
        confidence=1.0, detail=None,
    )  # fmt: skip


def conn(minutes_ago: float, orig: str, resp: str, port: int, state: str) -> str:
    ts = (NOW - timedelta(minutes=minutes_ago)).timestamp()
    return json.dumps({
        "ts": ts, "uid": "C1", "id.orig_h": orig, "id.orig_p": 40000, "id.resp_h": resp,
        "id.resp_p": port, "proto": "tcp", "conn_state": state, "orig_bytes": 100,
        "resp_bytes": 50,
    })  # fmt: skip


@pytest.fixture
def history() -> History:
    h = History()
    for event in (alert(30), alert(5), alert(2, summary="RTSP 认证爆破（第 37 次）"),
                  alert(1, src="172.30.0.5", summary="其他来源"), behavior(3),
                  behavior(1, camera="cam-01"), integrity(4), integrity(40)):  # fmt: skip
        if isinstance(event, VisionIntegrityV1):
            h.add_integrity(event)
        else:
            h.add_alert(event)
    return h


@pytest.fixture
def tools(history: History, tmp_path: Path) -> Tools:
    log = tmp_path / "conn.log"
    log.write_text(
        "\n".join(
            [conn(20, ATTACKER, "172.30.0.12", 8554, "SF")]  # 窗口之外
            + [conn(3, ATTACKER, "172.30.0.12", 8554, "SF")] * 3
            + [conn(2, ATTACKER, "172.30.0.12", 8554, "REJ")]
            + [conn(1, "172.30.0.12", ATTACKER, 22, "S0")]
            + [conn(1, "172.30.0.5", "172.30.0.11", 554, "SF")]
        )
        + "\n"
    )
    return Tools(history, Devices(load(SITE).devices), log, TECHNIQUES)


def run(tools: Tools, tool: str, args: dict[str, Any]) -> investigation_tools.ToolResult:
    return asyncio.run(tools.run(tool, args))


def test_list_alerts_by_ip_in_window_newest_first(tools: Tools) -> None:
    r = run(tools, "list_alerts", {"ip": ATTACKER})
    assert r.args_summary == "ip=172.30.0.100, minutes=10"
    assert r.data["total"] == 2
    assert [i["summary"] for i in r.data["items"]] == ["RTSP 认证爆破（第 37 次）", "RTSP 认证爆破"]
    assert (
        r.summary
        == "近 10 分钟 2 条告警，最近：RTSP 认证爆破（第 37 次）（172.30.0.100 → 172.30.0.12）"
    )


def test_list_alerts_by_device_includes_behavior(tools: Tools) -> None:
    r = run(tools, "list_alerts", {"device_id": "cam-02", "minutes": 60})
    assert [i["kind"] for i in r.data["items"]] == [
        "security_alert", "security_alert", "behavior", "security_alert", "security_alert"
    ]  # fmt: skip


def test_list_alerts_truncated_with_total(history: History, tools: Tools) -> None:
    for _ in range(30):
        history.add_alert(alert(1))
    r = run(tools, "list_alerts", {"ip": ATTACKER})
    assert r.data["total"] == 32 and len(r.data["items"]) == investigation_tools.MAX_ITEMS


def test_list_frame_events(tools: Tools) -> None:
    r = run(tools, "list_frame_events", {"camera_id": "cam-02"})
    assert [(i["kind"], i.get("type"), i.get("behavior")) for i in r.data["items"]] == [
        ("behavior", None, "climb"), ("integrity", "freeze", None)
    ]  # fmt: skip
    assert r.summary == "近 10 分钟 2 条画面事件，最近：攀爬"


def test_get_device(tools: Tools) -> None:
    r = run(tools, "get_device", {"device_id": "cam-02"})
    assert (r.data["ip"], r.data["type"], r.data["state"]) == ("172.30.0.12", "camera", "normal")
    assert r.summary == "cam-02：camera 172.30.0.12，状态 normal"
    missing = run(tools, "get_device", {"device_id": "cam-99"})
    assert missing.data == {"found": False} and missing.summary == "未登记的设备 cam-99"


def test_query_sessions_aggregates_by_peer(tools: Tools) -> None:
    r = run(tools, "query_sessions", {"ip": ATTACKER})
    assert r.data["total"] == 5
    assert r.data["peers"] == [
        {"peer": "172.30.0.12", "port": 8554, "direction": "out", "count": 4, "bytes": 600,
         "states": {"SF": 3, "REJ": 1}},
        {"peer": "172.30.0.12", "port": 22, "direction": "in", "count": 1, "bytes": 150,
         "states": {"S0": 1}},
    ]  # fmt: skip
    assert r.summary == "近 10 分钟 5 个会话，对端 2 个，最多：172.30.0.12:8554 4 次"


def test_query_sessions_without_log(history: History, tmp_path: Path) -> None:
    tools = Tools(history, Devices(load(SITE).devices), tmp_path / "missing.log", TECHNIQUES)
    r = run(tools, "query_sessions", {"ip": ATTACKER})
    assert r.data == {"available": False} and r.summary == "会话日志不可用"


def test_lookup_technique(tools: Tools) -> None:
    r = run(tools, "lookup_technique", {"technique_id": "T1110"})
    assert r.data == {"technique_id": "T1110", "name": "Brute Force",
                      "tactics": ["Credential Access"]}  # fmt: skip
    assert r.summary == "T1110 Brute Force（Credential Access）"
    assert run(tools, "lookup_technique", {"technique_id": "T9999"}).data == {"found": False}


@pytest.mark.parametrize(
    ("tool", "args", "summary"),
    [
        ("block_ip", {"ip": ATTACKER}, "已拒绝：未知工具 block_ip"),
        ("list_alerts", {}, "已拒绝：参数不合法"),
        ("list_alerts", {"ip": ATTACKER, "device_id": "cam-02"}, "已拒绝：参数不合法"),
        ("list_alerts", {"ip": "DROP TABLE"}, "已拒绝：参数不合法"),
        ("list_alerts", {"ip": ATTACKER, "minutes": 999}, "已拒绝：参数不合法"),
        ("get_device", {"device_id": "cam-02", "sql": "x"}, "已拒绝：参数不合法"),
    ],
)
def test_rejects_unknown_tool_and_invalid_args(
    tools: Tools, tool: str, args: dict[str, Any], summary: str
) -> None:
    r = run(tools, tool, args)
    assert r.summary == summary and "error" in r.data
    if tool == "block_ip":
        assert "list_alerts" in r.data["error"]  # 告知模型可用工具


def test_tool_timeout(tools: Tools, monkeypatch: pytest.MonkeyPatch) -> None:
    release = threading.Event()

    def stuck(*_: Any) -> list[dict[str, Any]]:
        release.wait(5)
        return []

    monkeypatch.setattr(investigation_tools, "TIMEOUT_S", 0.05)
    monkeypatch.setattr(investigation_tools, "_read_conn_log", stuck)
    try:
        r = run(tools, "query_sessions", {"ip": ATTACKER})
    finally:
        release.set()
    assert r.summary == "查询超时" and "error" in r.data
