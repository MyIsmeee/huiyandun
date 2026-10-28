"""归一化：Suricata EVE 告警 → hyd.security.alert.v1（TK-032）。

tests/eve/ 的两条记录为同一次攻击的真实输出（attack-sim 在 attack-net 内对 rtsp-target
即 cam-02 认证爆破 6 次）：live.json 为实时检测，replay.json 为同时抓包的 pcap 经
suricata -r 离线回放。只含演示隔离网络的地址，不含真实数据。
"""

import json
import logging
from pathlib import Path
from typing import Any

import pytest
import yaml

from correlator.normalize import device_index, normalize
from py_contracts.config.site_schema import SiteConfig

ROOT = Path(__file__).resolve().parents[3]
EVE = Path(__file__).parent / "eve"
DEVICES = device_index(
    SiteConfig.model_validate(
        yaml.safe_load((ROOT / "demo/scenarios/site.yaml").read_text(encoding="utf-8"))
    )
)


def record(name: str = "live") -> dict[str, Any]:
    return json.loads((EVE / f"{name}.json").read_text(encoding="utf-8"))


def test_replay_and_live_produce_same_alert() -> None:
    """FR-204：除事件 ID、时刻与证据引用（流编号）外完全相同。"""
    differ = {"event_id", "ts", "evidence_ref"}
    live, replay = (normalize((EVE / f"{n}.json").read_text(), DEVICES) for n in ("live", "replay"))
    assert live is not None and replay is not None
    assert live.model_dump(exclude=differ) == replay.model_dump(exclude=differ)


def test_bruteforce_alert_fields() -> None:
    """告警落在设备回包上：攻击方取 alert.source，而非报文源（#101）。"""
    alert = normalize(json.dumps(record()), DEVICES)
    assert alert is not None
    assert alert.model_dump(mode="json", exclude={"event_id"}) == {
        "schema_version": "1.0.0",
        "ts": "2026-10-28T16:29:01.987571Z",
        "rule_id": "HYD-NET-0001",
        "rule_version": "2",
        "category": "auth_bruteforce",
        "severity": "high",
        "src_ip": "172.30.0.100",
        "dst_ip": "172.30.0.12",
        "device_id": "cam-02",
        "technique": "T1110",
        "evidence_ref": "suricata:flow/971699494095076",
    }


def test_event_id_stable_for_same_line() -> None:
    """重读同一行时 ID 不变，JetStream 据此去重。"""
    line = json.dumps(record())
    first, second = normalize(line, DEVICES), normalize(line, DEVICES)
    assert first is not None and second is not None
    assert first.event_id == second.event_id


def test_unregistered_target_still_alerts() -> None:
    """FR-203：目标未登记为设备时 device_id 为 null，告警照常产生。"""
    eve = record()
    eve["alert"]["target"]["ip"] = "198.51.100.7"
    alert = normalize(json.dumps(eve), DEVICES)
    assert alert is not None and alert.device_id is None


def test_external_rule_uses_packet_direction_and_sid() -> None:
    """外部规则无 target 关键字与 HYD 元数据：按报文方向，规则 ID 取 sid，类别取 classtype。"""
    eve = record()
    del eve["alert"]["source"], eve["alert"]["target"]
    eve["src_ip"], eve["dest_ip"] = "172.30.0.100", "172.30.0.12"
    eve["alert"].update(signature_id=2010935, rev=3, severity=2)
    eve["alert"]["metadata"] = {"mitre_technique_id": ["T1046"]}
    alert = normalize(json.dumps(eve), DEVICES)
    assert alert is not None
    assert (alert.rule_id, alert.rule_version, alert.category, alert.severity) == (
        "SID-2010935",
        "3",
        "Attempted User Privilege Gain",
        "medium",
    )
    assert (str(alert.src_ip), alert.device_id) == ("172.30.0.100", "cam-02")


def test_alert_without_technique_skipped(caplog: pytest.LogCaptureFixture) -> None:
    """C-SEC-09：缺 ATT&CK 技术编号的告警不发布，只记日志。"""
    eve = record()
    del eve["alert"]["metadata"]["mitre_technique_id"]
    with caplog.at_level(logging.INFO):
        assert normalize(json.dumps(eve), DEVICES) is None
    assert [r.message for r in caplog.records] == ["correlator.alert_skipped"]


@pytest.mark.parametrize(
    "line",
    [
        "not json",
        json.dumps({"event_type": "stats", "timestamp": "2026-10-28T16:29:01+0000"}),
        json.dumps({**record(), "src_ip": "not-an-ip"}),
        json.dumps({**record(), "timestamp": "2026-10-28T16:29:01"}),  # 无时区
    ],
)
def test_invalid_record_skipped(line: str, caplog: pytest.LogCaptureFixture) -> None:
    """EVE 来自解析不可信流量的探针：不合格的记录记日志后跳过，不中断读取。"""
    assert normalize(line, DEVICES) is None
    assert [r.message for r in caplog.records] == ["correlator.eve_invalid"]


def test_alert_violating_contract_skipped(caplog: pytest.LogCaptureFixture) -> None:
    """字段取值不符合告警契约（如技术编号格式错误）时不发布，只记日志。"""
    eve = record()
    eve["alert"]["metadata"]["mitre_technique_id"] = ["Brute_Force"]
    assert normalize(json.dumps(eve), DEVICES) is None
    assert [r.message for r in caplog.records] == ["correlator.alert_invalid"]
