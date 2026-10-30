"""关联规则样本回放（C-SEC-01）：rules/tests/<规则 ID>/sequences.yaml 的每个用例按列表顺序送入引擎，
比对生成的关联事件数与是否须确认。"""

from pathlib import Path
from typing import Any

import pytest
import yaml
from test_engine import ALERT, ATTACK, RULES, alert, integrity

from correlator.engine import Engine
from correlator.rules import MODELS

ROOT = Path(__file__).resolve().parents[3]
CASES = [
    pytest.param(rule.id, case, id=f"{rule.id}-{case['name']}")
    for rule in RULES
    for case in yaml.safe_load(
        (ROOT / f"rules/tests/{rule.id}/sequences.yaml").read_text(encoding="utf-8")
    )["cases"]
]


def test_every_rule_has_samples() -> None:
    assert {r.id for r in RULES} == {
        p.parent.name for p in (ROOT / "rules/tests").glob("*/sequences.yaml")
    }


@pytest.mark.parametrize(("rule_id", "case"), CASES)
def test_rule_sample(rule_id: str, case: dict[str, Any]) -> None:
    engine = Engine([r for r in RULES if r.id == rule_id], ATTACK)
    incidents = []
    for raw in case["events"]:
        fields = dict(raw)
        subject, t = fields.pop("subject"), fields.pop("t")
        assert subject in MODELS
        event = alert(t, **fields) if subject == ALERT else integrity(t, **fields)
        incidents += engine.feed(subject, event)

    assert [{"requires_confirmation": i.requires_confirmation} for i in incidents] == case[
        "incidents"
    ]
