"""告警通知：哪些事件推送、各平台格式、冷却与限流、平台拒收。"""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx2
import pytest
from notifier.messages import notice, request
from notifier.service import RATE_PER_MIN, Notifier, NotifierConfig, Target, load_targets

from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_rule_v1_schema import VisionRuleV1

NOW = datetime.now(UTC)


def fall(level: str = "confirmed", camera: str = "cam-05") -> VisionBehaviorV1:
    return VisionBehaviorV1.model_validate(
        {
            "schema_version": "1.2.0", "event_id": str(uuid.uuid4()), "ts": NOW.isoformat(),
            "camera_id": camera, "track_id": 3, "behavior": "fall", "level": level,
            "confidence_avg": 0.9, "duration_s": 8, "ts_start": "2026-11-17T08:00:00+00:00",
            "ts_end": NOW.isoformat(),
        }
    )  # fmt: skip


def zone(phase: str) -> VisionRuleV1:
    return VisionRuleV1.model_validate(
        {
            "schema_version": "1.0.0", "event_id": str(uuid.uuid4()), "ts": NOW.isoformat(),
            "camera_id": "cam-05", "rule_id": "yard", "rule_name": "库区", "rule_type": "intrusion",
            "phase": phase, "episode_id": str(uuid.uuid4()), "level": "confirmed", "track_id": 2,
            "object_class": "person", "x": 1, "y": 2, "uncertainty_m": 0.3,
            "since": NOW.isoformat(), "direction": None, "mapping": "calibrated",
            "inferred": False, "end_reason": None,
        }
    )  # fmt: skip


def incident(severity: str) -> CorrelatorIncidentV1:
    return CorrelatorIncidentV1.model_validate(
        {
            "schema_version": "1.2.0", "event_id": str(uuid.uuid4()), "ts": NOW.isoformat(),
            "id": "inc-1", "rule_id": "HYD-NET-0001", "rule_version": "1.0.0", "mode": "enforce",
            "title": "摄像头遭口令暴力破解", "severity": severity, "device_ids": ["cam-05"],
            "source_ip": "172.30.0.100", "techniques": [], "tactics": [], "evidence_refs": [],
            "hit_path": [], "requires_confirmation": False, "status": "open",
            "created_at": NOW.isoformat(),
        }
    )  # fmt: skip


def test_only_confirmed_alerts_entering_and_high_incidents_are_notified() -> None:
    names = {"cam-05": "前门"}
    n = notice(fall(), names, 480)
    assert n is not None and n.title == "跌倒"
    assert n.lines == ["摄像头：前门", "人员：#3", "发生时间：2026-11-17 16:00:00"]
    assert notice(fall("suspected"), names, 480) is None
    assert notice(zone("start"), names, 480) is not None
    assert notice(zone("update"), names, 480) is None
    assert notice(incident("critical"), names, 480) is not None
    assert notice(incident("medium"), names, 480) is None


def test_platform_formats_and_dingtalk_signature() -> None:
    n = notice(fall(), {}, 480)
    assert n is not None
    url, body = request(
        "wecom",
        "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k",
        None,
        n,
        "https://hyd.local",
    )
    assert (
        body["msgtype"] == "markdown"
        and "[打开控制台处置](https://hyd.local)" in body["markdown"]["content"]
    )
    url, body = request(
        "dingtalk", "https://oapi.dingtalk.com/robot/send?access_token=t", "SEC1", n, None
    )
    assert "&timestamp=" in url and "&sign=" in url and body["markdown"]["title"] == "慧眼盾：跌倒"
    _, body = request("webhook", "https://example.test/hook", None, n, None)
    assert body["event"]["behavior"] == "fall"


def test_targets_file_missing_means_disabled_and_bad_entry_fails(tmp_path: Path) -> None:
    assert load_targets(tmp_path / "none") == []
    (tmp_path / "t").write_text("- {kind: wecom, url: 'https://a.test/x'}\n", encoding="utf-8")
    assert load_targets(tmp_path / "t") == [Target(kind="wecom", url="https://a.test/x")]
    (tmp_path / "bad").write_text("- {kind: sms, url: 'https://a.test/x'}\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_targets(tmp_path / "bad")


def run(notifier: Notifier, *events) -> None:  # noqa: ANN001
    async def main() -> None:
        for e in events:
            await notifier.on_event(e)

    asyncio.run(main())


def make(handler) -> tuple[Notifier, list[dict]]:  # noqa: ANN001
    posted: list[dict] = []

    def record(req: httpx2.Request) -> httpx2.Response:
        posted.append(json.loads(req.content))
        return handler(req)

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(record))
    config = NotifierConfig(cooldown_s=60)
    return Notifier(config, [Target(kind="wecom", url="https://a.test/x")], client), posted


def test_cooldown_per_camera_and_kind_and_rate_limit() -> None:
    notifier, posted = make(lambda _: httpx2.Response(200, json={"errcode": 0}))
    run(notifier, fall(), fall(), fall(camera="cam-06"))
    assert len(posted) == 2  # 同一摄像头的第二次跌倒在冷却期内

    notifier, posted = make(lambda _: httpx2.Response(200, json={"errcode": 0}))
    run(notifier, *(fall(camera=f"cam-{i}") for i in range(RATE_PER_MIN + 5)))
    assert len(posted) == RATE_PER_MIN


def test_replayed_old_events_are_not_pushed() -> None:
    notifier, posted = make(lambda _: httpx2.Response(200, json={"errcode": 0}))
    run(notifier, fall().model_copy(update={"ts": NOW - timedelta(minutes=10)}))
    assert posted == []


def test_platform_rejection_is_logged_not_raised(caplog: pytest.LogCaptureFixture) -> None:
    notifier, _ = make(
        lambda _: httpx2.Response(200, json={"errcode": 93000, "errmsg": "invalid webhook url"})
    )
    run(notifier, fall())
    assert any(r.message == "notifier.rejected" for r in caplog.records)
