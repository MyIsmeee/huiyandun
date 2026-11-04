"""关联事件写入存证：命中事件、关联事件与录像片段（FR-701，设计 080-evidence.md §3.1、D-098）。"""

import asyncio
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx2
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from evidence_service.recording import Evidence, windows
from evidence_service.store import Chain
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

T0 = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)  # 录像早已落盘，不必等待
ALERT_ID, FREEZE_ID = uuid.uuid4(), uuid.uuid4()

type Handler = Callable[[httpx2.Request], httpx2.Response]


def alert() -> SecurityAlertV1:
    return SecurityAlertV1(
        schema_version="1.0.0", event_id=ALERT_ID, ts=T0, rule_id="HYD-NET-0001",
        rule_version="3", mode="enforce", category="auth_bruteforce", severity="high",
        src_ip="172.30.0.100", dst_ip="172.30.0.12", device_id="cam-02", technique="T1110",
        evidence_ref="eve:1", source="rule", confidence=1.0, summary="RTSP 认证爆破",
    )  # fmt: skip


def freeze() -> VisionIntegrityV1:
    return VisionIntegrityV1(
        schema_version="1.0.0", event_id=FREEZE_ID, ts=T0 + timedelta(seconds=40),
        camera_id="cam-02", type="freeze", duration_s=4.0, source="rule", confidence=1.0,
        detail="画面冻结",
    )  # fmt: skip


def incident(device: str = "cam-02") -> CorrelatorIncidentV1:
    return CorrelatorIncidentV1.model_validate({
        "schema_version": "1.2.0", "event_id": uuid.uuid4(), "ts": T0 + timedelta(seconds=41),
        "id": "inc-ev", "rule_id": "HYD-X-0001", "rule_version": "1.0.0", "mode": "enforce",
        "title": "摄像头疑似被入侵且画面遭篡改", "severity": "critical", "device_ids": [device],
        "source_ip": "172.30.0.100", "techniques": ["T1110"], "tactics": ["Credential Access"],
        "evidence_refs": ["eve:1"], "hit_path": [str(ALERT_ID), str(FREEZE_ID)],
        "requires_confirmation": False, "status": "open",
        "created_at": (T0 + timedelta(seconds=41)).isoformat(),
    })  # fmt: skip


def iso(t: datetime) -> str:
    return t.isoformat(timespec="milliseconds")


class Recorder:
    """假 recorder：/list 返回给定区间，/get 返回以起点命名的字节。"""

    def __init__(self, handler: Handler | None = None) -> None:
        self.requests: list[httpx2.Request] = []
        self._handler = handler or self.recorded

    @staticmethod
    def recorded(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/list":
            # 源时间戳跳变处录像分段：两个区间之间有 5 s 空档
            return httpx2.Response(200, json=[
                {"start": iso(T0 - timedelta(seconds=30)), "duration": 40.0},
                {"start": iso(T0 + timedelta(seconds=15)), "duration": 55.0},
            ])  # fmt: skip
        return httpx2.Response(200, content=f"mp4@{request.url.params['start']}".encode())

    def client(self) -> httpx2.AsyncClient:
        def record(request: httpx2.Request) -> httpx2.Response:
            self.requests.append(request)
            return self._handler(request)

        return httpx2.AsyncClient(
            base_url="http://recorder:9996", transport=httpx2.MockTransport(record)
        )


@pytest.fixture
def chain(tmp_path: Path) -> Chain:
    return Chain(tmp_path, Ed25519PrivateKey.generate())


def records(root: Path) -> list[dict]:
    return [json.loads(line) for line in (root / "chain.jsonl").read_bytes().splitlines()]


async def run(evidence: Evidence, *events: CorrelatorIncidentV1) -> None:
    for event in events:
        await evidence.on_incident(event)
    await asyncio.gather(*list(evidence._tasks.values()))


def test_windows_take_30s_around_each_hit_and_merge_overlaps() -> None:
    t = T0
    assert windows([t + timedelta(seconds=200), t, t + timedelta(seconds=40)]) == [
        (t - timedelta(seconds=30), t + timedelta(seconds=70)),
        (t + timedelta(seconds=170), t + timedelta(seconds=230)),
    ]


def test_incident_records_hits_incident_and_each_recorded_span(
    chain: Chain, tmp_path: Path
) -> None:
    recorder = Recorder()
    evidence = Evidence(chain, {"cam-02": "cam-02"}, recorder.client())
    evidence.cache("alert", alert())
    evidence.cache("integrity", freeze())

    asyncio.run(run(evidence, incident(), incident()))  # 重放的同一事件只写一次

    rows = records(tmp_path)
    assert [r["kind"] for r in rows] == ["alert", "integrity", "incident", "video", "video"]
    assert rows[0]["meta"] == {"event_id": str(ALERT_ID)}
    assert (
        json.loads((tmp_path / rows[0]["payload_ref"]).read_bytes())["summary"] == "RTSP 认证爆破"
    )
    assert rows[3]["meta"] == {
        "device_id": "cam-02",
        "stream": "cam-02",
        "capture_host": "recorder",
        "start": iso(T0 - timedelta(seconds=30)),
        "end": iso(T0 + timedelta(seconds=10)),
    }
    assert rows[4]["meta"]["start"] == iso(T0 + timedelta(seconds=15))
    assert rows[4]["payload_ref"].endswith(".mp4")
    # 两条命中事件相隔 40 s，前后各 30 s 合并为一个时段
    [listing, *gets] = recorder.requests
    assert listing.url.params["path"] == "cam-02"
    assert listing.url.params["start"] == iso(T0 - timedelta(seconds=30))
    assert listing.url.params["end"] == iso(T0 + timedelta(seconds=70))
    assert [g.url.params["format"] for g in gets] == ["mp4", "mp4"]
    assert [g.url.params["duration"] for g in gets] == ["40.0", "55.0"]


def test_missing_hit_and_no_recording_are_recorded_as_such(chain: Chain, tmp_path: Path) -> None:
    evidence = Evidence(
        chain, {"cam-02": "cam-02"}, Recorder(lambda _: httpx2.Response(404)).client()
    )
    evidence.cache("alert", alert())  # 冻结事件未收到

    asyncio.run(run(evidence, incident()))

    rows = records(tmp_path)
    assert [r["kind"] for r in rows] == ["alert", "event_missing", "incident", "video_unavailable"]
    assert rows[1]["meta"] == {"event_id": str(FREEZE_ID)}
    assert rows[1]["payload_ref"] is None
    # 只找到告警：时段为它前后各 30 s
    assert rows[3]["meta"]["start"] == iso(T0 - timedelta(seconds=30))
    assert rows[3]["meta"]["end"] == iso(T0 + timedelta(seconds=30))
    assert rows[3]["meta"]["reason"] == "该时段无录像"


def test_recorder_down_does_not_block_other_records(chain: Chain, tmp_path: Path) -> None:
    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    evidence = Evidence(chain, {"cam-02": "cam-02"}, Recorder(down).client())
    evidence.cache("alert", alert())
    evidence.cache("integrity", freeze())

    asyncio.run(run(evidence, incident()))

    rows = records(tmp_path)
    assert [r["kind"] for r in rows] == ["alert", "integrity", "incident", "video_unavailable"]
    assert rows[3]["meta"]["reason"].startswith("录像不可用：ConnectError")


def test_device_without_stream_has_no_video(chain: Chain, tmp_path: Path) -> None:
    recorder = Recorder()
    evidence = Evidence(chain, {"cam-02": "cam-02"}, recorder.client())

    asyncio.run(run(evidence, incident(device="nvr-01")))

    assert [r["kind"] for r in records(tmp_path)] == [
        "event_missing",
        "event_missing",
        "incident",
    ]
    assert recorder.requests == []


def test_hit_arriving_after_incident_is_still_recorded(chain: Chain, tmp_path: Path) -> None:
    """告警与关联事件来自不同的流，关联事件可能先到：等录像之后才查缓存。"""
    evidence = Evidence(chain, {"cam-02": "cam-02"}, Recorder().client())
    evidence.cache("integrity", freeze())

    async def main() -> None:
        await evidence.on_incident(incident())
        await asyncio.sleep(0)  # 写入任务已开始
        evidence.cache("alert", alert())
        await asyncio.gather(*list(evidence._tasks.values()))

    asyncio.run(main())

    assert [r["kind"] for r in records(tmp_path)][:2] == ["alert", "integrity"]


def test_failed_clip_keeps_other_clips_of_the_window(chain: Chain, tmp_path: Path) -> None:
    def second_clip_fails(request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/get" and request.url.params["duration"] == "55.0":
            return httpx2.Response(500)
        return Recorder.recorded(request)

    evidence = Evidence(chain, {"cam-02": "cam-02"}, Recorder(second_clip_fails).client())
    evidence.cache("alert", alert())
    evidence.cache("integrity", freeze())

    asyncio.run(run(evidence, incident()))

    rows = records(tmp_path)
    assert [r["kind"] for r in rows][3:] == ["video", "video_unavailable"]
    assert rows[4]["meta"]["start"] == iso(T0 + timedelta(seconds=15))
    assert rows[4]["meta"]["end"] == iso(T0 + timedelta(seconds=70))
    assert rows[4]["meta"]["reason"].startswith("录像不可用：HTTPStatusError")
