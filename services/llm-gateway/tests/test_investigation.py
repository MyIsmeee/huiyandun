"""值班员任务 incident_investigation（TK-116、FR-1103、FR-1104、C-LLM-05）：每轮输出按 action 校验必填、
调用方传入的剩余时间、按 evidence 回溯、多轮脱敏的假名稳定且工具参数还原。

录制响应与供应商分派沿用 test_invoke。
"""

import asyncio
import json
from typing import Any

import httpx2
from test_invoke import Providers, completion, ok, provider

from llm_gateway.invoke import Invocation

INCIDENT = {"id": "inc-1", "device_ids": ["cam-02"], "source_ip": "172.30.0.100"}
TOOL = {"action": "tool", "reason": "先查攻击源的告警", "tool": "list_alerts",
        "args": {"ip": "172.30.0.100", "minutes": 10}, "verdict": None}  # fmt: skip
VERDICT = {
    "action": "verdict", "reason": "证据充分", "tool": None, "args": None,
    "verdict": {"is_attack": True, "confidence": 0.9, "techniques": ["T1110"],
                "narrative": "172.30.0.100 对 cam-02 爆破", "recommendation": "封禁攻击源"},
}  # fmt: skip


def investigate(p: Providers, *providers: dict[str, Any], **fields: Any) -> Any:
    body = {"task": "incident_investigation", "providers": list(providers)} | fields
    return asyncio.run(p.chain.invoke(Invocation.model_validate(body)))


def test_turn_without_required_field_is_retried_then_fails_over() -> None:
    """契约允许 null，但 action=tool 缺 tool、action=verdict 缺 verdict 都按不符合格式处理。"""
    p = Providers(
        a=ok(TOOL | {"tool": None}),
        b=ok(VERDICT | {"verdict": None}),
        c=ok(TOOL),
    )
    data = {"incident": INCIDENT, "steps": [], "rounds_left": 8}
    result = investigate(p, provider("a"), provider("b"), provider("c"), data=data)
    assert [a.reason for a in result.attempts[:2]] == ["输出两次不符合格式"] * 2
    assert len(p.seen["a"]) == 2 and result.output == TOOL
    assert p.seen["c"][0]["temperature"] == 0.1


def test_caller_deadline_caps_task_deadline() -> None:
    """调用方传的剩余时间带小数，提示取 1 位小数（值守人员可见）。"""

    async def slow(_: httpx2.Request) -> httpx2.Response:
        await asyncio.sleep(0.2)
        return httpx2.Response(500)

    p = Providers(a=slow, b=ok(VERDICT))
    result = investigate(p, provider("a"), provider("b"), data={}, deadline_s=0.1234)
    assert (result.attempts[1].outcome, result.attempts[1].reason) == (
        "skipped",
        "超出 0.1 秒总时限",
    )


def test_untraced_against_evidence_not_model_turns() -> None:
    """模型此前参数里写过的 IP 不能因此算作有出处（FR-1103）。"""
    steps = [{"tool": "query_sessions", "args": {"ip": "10.9.9.9"}, "result": {"total": 0}}]
    data = {"incident": INCIDENT, "steps": steps, "rounds_left": 7}
    evidence = {"incident": INCIDENT, "results": [{"total": 0}]}
    told = json.loads(json.dumps(VERDICT))
    told["verdict"]["narrative"] = "172.30.0.100 经 10.9.9.9 跳板爆破 cam-02"
    result = investigate(Providers(a=ok(told)), provider("a"), data=data, evidence=evidence)
    assert result.unverified == ["10.9.9.9"]
    without = investigate(Providers(a=ok(told)), provider("a"), data=data)
    assert without.unverified == []  # 缺省按 data 回溯


def test_public_pseudonyms_stable_across_rounds_and_args_restored() -> None:
    """FR-1104：每轮重新脱敏，已出现的地址编号不变；模型以假名给出的工具参数还原后返回。"""
    p = Providers(a=lambda _: completion(json.dumps(TOOL | {"args": {"ip": "HOST_001"}})))
    first = {"incident": INCIDENT, "steps": [], "rounds_left": 8}
    result = investigate(p, provider("a", network="public"), data=first)
    assert result.output["args"] == {"ip": "172.30.0.100"}
    step = {"tool": "list_alerts", "args": {"ip": "172.30.0.100"},
            "result": {"items": [{"src_ip": "172.30.0.100", "dst_ip": "172.30.0.12"}]}}  # fmt: skip
    second = first | {"steps": [step], "rounds_left": 7}
    investigate(p, provider("a", network="public"), data=second)
    sent = [b["messages"][1]["content"] for b in p.seen["a"]]
    assert all("172.30.0." not in s and "cam-02" not in s for s in sent)
    assert '"source_ip": "HOST_001"' in sent[0] and '"source_ip": "HOST_001"' in sent[1]
    assert '"dst_ip": "HOST_002"' in sent[1]
