"""公网脱敏与还原（C-LLM-03）、事实回溯（C-LLM-06、FR-503、D-086）。"""

import json

from llm_gateway.redact import Pseudonyms, untraced

EVIDENCE = {
    "incident": {
        "device_ids": ["cam-02"],
        "source_ip": "172.30.0.100",
        "techniques": ["T1110"],
        "evidence_refs": ["eve:1"],
    },
    "timeline": [
        {
            "event": {
                "src_ip": "172.30.0.100",
                "dst_ip": "172.30.0.12",
                "device_id": "cam-02",
                "summary": "RTSP 认证爆破 172.30.0.12:554，来自 8.8.8.8",
            }
        },
        {"event": {"camera_id": "cam-02", "detail": "画面冻结", "dst_port": 8554}},
    ],
}
TECHNIQUES = {"T1110", "T1110.001", "T0832"}


def test_redact_replaces_internal_ips_and_devices_everywhere() -> None:
    redacted = json.dumps(Pseudonyms().redact(EVIDENCE), ensure_ascii=False)
    for real in ("172.30.0.100", "172.30.0.12", "cam-02"):
        assert real not in redacted
    assert "HOST_001" in redacted and "HOST_002:554" in redacted and "DEV_001" in redacted
    assert "8.8.8.8" in redacted  # 公网地址不是内网信息，保留


def test_same_value_gets_same_pseudonym_and_prefix_is_not_cut() -> None:
    p = Pseudonyms()
    out = p.redact({"device_id": "cam-1", "a": "10.0.0.1 与 10.0.0.12，cam-1、cam-12"})
    assert out["a"] == "HOST_001 与 HOST_002，DEV_001、cam-12"
    assert p.restore(out) == {"device_id": "cam-1", "a": "10.0.0.1 与 10.0.0.12，cam-1、cam-12"}


def test_restore_keeps_unknown_pseudonyms() -> None:
    p = Pseudonyms()
    p.redact(EVIDENCE)
    restored = p.restore({"summary": "HOST_001 攻击 DEV_001，并涉及 HOST_099"})
    assert restored == {"summary": "172.30.0.100 攻击 cam-02，并涉及 HOST_099"}


def test_traceable_entities_are_not_flagged() -> None:
    output = {
        "summary": "172.30.0.100 对 cam-02 的端口 554 与 8554 爆破（T1110，T1110.001。T0832）",
        "attack_chain": [{"technique_id": "T1110", "evidence_refs": ["eve:1"]}],
        "impact": [{"device_id": "cam-02", "description": "08:00:00 起画面冻结"}],
    }
    assert untraced(output, EVIDENCE, TECHNIQUES) == []


def test_fabricated_entities_are_flagged() -> None:
    output = {
        "summary": "10.9.9.9 经 fe80::99 利用 CVE-2024-12345 入侵 cam-07，端口 23，T1078",
        "attack_chain": [{"technique_id": "T1078", "evidence_refs": ["eve:1", "eve:9"]}],
        "impact": [{"device_id": "NVR 主机", "description": "HOST_099 受影响，172.30.0.12:23"}],
    }
    assert untraced(output, EVIDENCE, TECHNIQUES) == [
        "10.9.9.9",
        "fe80::99",
        "端口 23",
        "CVE-2024-12345",
        "T1078",
        "cam-07",
        "eve:9",
        "NVR 主机",
        "172.30.0.12:23",
        "HOST_099",
    ]


def test_partial_match_is_not_traced() -> None:
    """cam-0 只是 cam-02 的一部分，不能算在证据中出现。"""
    assert untraced({"summary": "cam-0 与 172.30.0.1"}, EVIDENCE, TECHNIQUES) == [
        "172.30.0.1",
        "cam-0",
    ]
