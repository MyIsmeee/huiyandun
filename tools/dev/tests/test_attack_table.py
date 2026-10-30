"""ATT&CK 精简查表（D-070）：以最小 STIX 数据验证抽取规则，并核对已生成的表。"""

import importlib.util
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = Path(__file__).resolve().parents[1] / "attack_table.py"
_spec = importlib.util.spec_from_file_location("attack_table", SCRIPT)
assert _spec and _spec.loader
attack_table = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(attack_table)


def bundle(chain: str, tactics: list[tuple[str, str]], patterns: list[dict[str, Any]]) -> Any:
    objects: list[dict[str, Any]] = [
        {"type": "x-mitre-collection", "x_mitre_version": "20.0"},
        {"type": "marking-definition", "definition": {"statement": "Copyright MITRE"}},
        {"type": "x-mitre-matrix", "tactic_refs": [f"tactic--{s}" for s, _ in tactics]},
    ]
    objects += [
        {"type": "x-mitre-tactic", "id": f"tactic--{s}", "x_mitre_shortname": s, "name": n}
        for s, n in tactics
    ]
    for p in patterns:
        objects.append(
            {
                "type": "attack-pattern",
                "name": p["name"],
                "external_references": [{"source_name": "mitre-attack", "external_id": p["id"]}],
                "kill_chain_phases": [
                    {"kill_chain_name": chain, "phase_name": s} for s in p["phases"]
                ],
                **p.get("extra", {}),
            }
        )
    return {"objects": objects}


def test_techniques_with_tactics_in_matrix_order() -> None:
    enterprise = bundle(
        "mitre-attack",
        [("initial-access", "Initial Access"), ("credential-access", "Credential Access")],
        [
            {
                "id": "T1078",
                "name": "Valid Accounts",
                "phases": ["credential-access", "initial-access"],
            },
            {"id": "T1110", "name": "Brute Force", "phases": ["credential-access"]},
            {"id": "T9999", "name": "Old", "phases": [], "extra": {"revoked": True}},
            {"id": "T9998", "name": "Gone", "phases": [], "extra": {"x_mitre_deprecated": True}},
        ],
    )
    ics = bundle(
        "mitre-ics-attack",
        [("initial-access", "Initial Access"), ("impact", "Impact")],
        [{"id": "T0832", "name": "Manipulation of View", "phases": ["impact"]}],
    )

    table = attack_table.build([enterprise, ics])

    assert table == {
        "attack_version": "20.0",
        "notice": "Copyright MITRE",
        "tactic_order": ["Initial Access", "Credential Access", "Impact"],
        "techniques": {
            "T0832": {"name": "Manipulation of View", "tactics": ["Impact"]},
            "T1078": {"name": "Valid Accounts", "tactics": ["Initial Access", "Credential Access"]},
            "T1110": {"name": "Brute Force", "tactics": ["Credential Access"]},
        },
    }


def test_generated_table_covers_rule_techniques() -> None:
    """自研规则用到的技术编号都在表中（关联事件按此查战术）。"""
    table = json.loads((ROOT / "rules/attack/techniques.json").read_text(encoding="utf-8"))
    assert table["techniques"]["T1110"]["tactics"] == ["Credential Access"]
    assert table["techniques"]["T0832"]["tactics"] == ["Impact"]
