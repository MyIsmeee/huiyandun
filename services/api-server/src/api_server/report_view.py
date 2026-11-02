"""报告导出（FR-504、D-078）：网页与 Markdown 共用同一份展示内容，只在版式上不同。

事实区与模板叙述只由事实区字段填充（C-LLM-09）；AI 区为模型输出（V-AI1）。事件内容与模型输出都不可信：
网页模板开启自动转义；Markdown 的输出值换行改为空格（防止在新行伪造标题或"已复核"字样）、标记字符加反斜杠，
查看器不会把其中的 HTML 当作标记渲染。未溯源实体在网页中弱化并加虚线下划线，在 Markdown 中其后注明（V-AI3）。
"""

import re
from datetime import UTC, datetime
from typing import Any, Literal

from jinja2 import Environment, PackageLoader
from markupsafe import Markup, escape

from py_contracts.api import (
    Report,
    ReportAi,
    ReportFacts,
    ReportInvestigation,
    ReportTimelineEntry,
)

SEVERITY = {"critical": "严重", "high": "高", "medium": "中", "low": "低"}
MODE = {"enforce": "执行", "monitor": "仅监测"}
SOURCE = {"rule": "规则", "model": "模型"}
BEHAVIOR = {"fall": "跌倒", "climb": "攀爬越界"}
INTEGRITY = {
    "freeze": "画面冻结",
    "replay": "画面重放",
    "occlusion": "画面遮挡",
    "shift": "摄像头挪位",
    "stream_lost": "视频流中断",
}
DEVICE = {"camera": "摄像头", "nvr": "录像机", "switch": "交换机"}
# 与大屏处置栏一致（04 §5.2、V-T1）
EXECUTION = {
    "pending": "待确认",
    "executing": "处置中",
    "verifying": "处置中",
    "contained": "已处置",
    "failed": "处置失败",
    "rolled_back": "已解除",
    "notify_only": "已通知 · 待联动",
    "skipped": "未处置",
    "expired": "未确认 · 已过期",
}

CONFIDENCE = {"low": "低", "medium": "中", "high": "高"}
NETWORK = {"internal": "内网", "public": "公网·已脱敏"}
UNVERIFIED_HTML = Markup('<span class="unverified" title="该实体未能在证据中溯源">{}</span>')

MD_SPECIAL = re.compile(r"([\\`*_<>\[\]])")
NEWLINES = re.compile(r"\s*[\r\n]+\s*")


def _md_escape(value: object) -> object:
    """Markup 为已按 Markdown 处理过的 AI 区文字（见 _marked），不再处理。"""
    if isinstance(value, Markup) or not isinstance(value, str):
        return value
    return MD_SPECIAL.sub(r"\\\1", NEWLINES.sub(" ", value))


def _marked(text: str, unverified: list[str], fmt: Literal["html", "md"]) -> Markup:
    """把未溯源实体切出来单独标记；实体边界与网关的事实回溯一致，cam-0 不会标到 cam-02 上。"""
    pieces: list[tuple[str, bool]] = [(text, False)]
    if unverified:
        alternatives = "|".join(re.escape(u) for u in sorted(unverified, key=len, reverse=True))
        pattern = re.compile(rf"(?<![A-Za-z0-9_.\-])(?:{alternatives})(?![A-Za-z0-9_\-]|\.\d)")
        pieces, pos = [], 0
        for m in pattern.finditer(text):
            pieces += [(text[pos : m.start()], False), (m.group(), True)]
            pos = m.end()
        pieces.append((text[pos:], False))
    if fmt == "html":
        return Markup("").join(
            UNVERIFIED_HTML.format(p) if flag else escape(p) for p, flag in pieces
        )
    return Markup("".join(f"{_md_escape(p)}{'（未溯源）' if flag else ''}" for p, flag in pieces))


def _ai(ai: ReportAi, fmt: Literal["html", "md"]) -> dict[str, Any]:
    c, u = ai.content, ai.unverified
    return {
        "by": f"{ai.provider_name}（{ai.model}，{NETWORK[ai.network.root]}）",
        "summary": _marked(c.summary, u, fmt),
        "attack_chain": [
            _marked(
                f"{s.tactic} · {s.technique_id}：{s.description}"
                f"（证据：{'、'.join(r.root for r in s.evidence_refs) or '无'}）",
                u,
                fmt,
            )
            for s in c.attack_chain
        ],
        "impact": [_marked(f"{i.device_id}：{i.description}", u, fmt) for i in c.impact],
        "recommendations": [
            _marked(f"{r.action}：{r.rationale}", u, fmt) for r in c.recommendations
        ],
        "confidence": CONFIDENCE[c.confidence],
        "has_unverified": bool(u),
    }


def _verdict(investigation: ReportInvestigation, fmt: Literal["html", "md"]) -> dict[str, Any]:
    """AI 区开头引用的值班员判定（D-089），未溯源实体按工具结果回溯，与面板判定卡一致。"""
    v, p, u = investigation.verdict, investigation.provider, investigation.verdict.unverified
    return {
        "by": f"{p.name}（{NETWORK[p.location]}）" if p else "未知供应商",
        "at": utc(investigation.finished_at),
        "rows": [
            ("是否攻击", "是" if v.is_attack else "否"),
            ("可信度", f"{round(v.confidence * 100)}%"),
            ("ATT&CK 手法", _marked("、".join(t.root for t in v.techniques) or "无", u, fmt)),
            ("叙述", _marked(v.narrative, u, fmt)),
            ("建议（仅作文字建议，系统不会据此执行任何操作）", _marked(v.recommendation, u, fmt)),
        ],
        "has_unverified": bool(u),
    }


loader = PackageLoader("api_server", "templates")
ENVS = {
    "html": Environment(loader=loader, autoescape=True, trim_blocks=True, lstrip_blocks=True),
    "md": Environment(loader=loader, finalize=_md_escape, trim_blocks=True, lstrip_blocks=True),
}


def utc(ts: datetime) -> str:
    return ts.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _source(source: str, confidence: float) -> str:
    return SOURCE[source] if source == "rule" else f"模型 · {round(confidence * 100)}%"


def _entry(entry: ReportTimelineEntry) -> dict[str, Any]:
    """命中路径的一行：时间、类型、内容、来源与可信度。行为事件按模型证据显示（D-069）。"""
    if entry.event is None:
        text = f"事件 {entry.event_id} 已超出 24 小时保留或未收到"
        return {"ts": "—", "kind": "证据缺失", "text": text, "source": "—", "missing": True}
    e: Any = entry.event.root
    if entry.kind == "security_alert":
        kind, source = "网络告警", _source(e.source, e.confidence)
        text = f"{e.summary}（{e.src_ip} → {e.dst_ip}，规则 {e.rule_id} v{e.rule_version}，{e.technique}）"
    elif entry.kind == "behavior":
        kind, source = "行为事件", _source("model", e.confidence_avg)
        text = f"{e.camera_id} {BEHAVIOR.get(e.behavior, e.behavior)}，持续 {e.duration_s:.1f} s"
    else:
        kind, source = "画面完整性", _source(e.source, e.confidence)
        text = f"{e.camera_id} {INTEGRITY[e.type]}，持续 {e.duration_s:.1f} s"
        if e.detail:
            text += f"（{e.detail}）"
    return {"ts": utc(e.ts), "kind": kind, "text": text, "source": source, "missing": False}


def _executions(facts: ReportFacts) -> list[str]:
    lines = []
    for x in facts.executions:
        detail = x.reason or (x.verify_result.reason if x.verify_result else None)
        line = f"{x.playbook_id} v{x.playbook_version} → {x.target}：{EXECUTION[x.state]}"
        line += f"，TTL {x.ttl_s} s"
        if x.expires_at:
            line += f"，到期 {utc(x.expires_at)}"
        lines.append(line + (f"（{detail}）" if detail else ""))
    return lines


def _narrative(facts: ReportFacts, executions: list[str]) -> str:
    """模板叙述：模型不可用时 AI 区的内容（V-AI5）。"""
    i = facts.incident
    devices = "、".join(f"{d.id}（{d.ip}）" for d in facts.devices) or "未登记设备"
    text = (
        f"{utc(i.created_at)}，关联规则 {i.rule_id} v{i.rule_version} 判定「{i.title}」，"
        f"等级{SEVERITY[i.severity]}，涉及设备 {devices}"
    )
    text += f"，攻击源 {i.source_ip}。" if i.source_ip else "。"
    missing = sum(e.event is None for e in facts.timeline)
    text += f"命中路径共 {len(facts.timeline)} 个事件"
    text += f"，其中 {missing} 个证据缺失。" if missing else "。"
    if i.techniques:
        techniques = "、".join(t.root for t in i.techniques)
        text += f"对应 ATT&CK 技术 {techniques}（战术：{'、'.join(i.tactics) or '未知'}）。"
    text += f"处置：{'；'.join(executions)}。" if executions else "未执行自动处置。"
    return text


def render(report: Report, fmt: Literal["html", "md"]) -> str:
    facts, i = report.facts, report.facts.incident
    executions = _executions(facts)
    devices = "、".join(f"{d.id}（{DEVICE[d.type]}，{d.ip}）" for d in facts.devices)
    summary = [
        ("关联规则", f"{i.rule_id} v{i.rule_version}（{MODE[i.mode]}）"),
        ("等级", SEVERITY[i.severity]),
        ("设备", devices or "未登记设备"),
        ("攻击源", str(i.source_ip) if i.source_ip else "无"),
        ("ATT&CK 技术", "、".join(t.root for t in i.techniques) or "无"),
        ("ATT&CK 战术", "、".join(i.tactics) or "无"),
        ("处置前须人工确认", "是" if i.requires_confirmation else "否"),
        ("发生时间", utc(i.created_at)),
    ]
    return (
        ENVS[fmt]
        .get_template(f"report.{fmt}.j2")
        .render(
            report=report,
            title=i.title,
            created_at=utc(report.created_at),
            reviewed_at=utc(report.reviewed_at) if report.reviewed_at else None,
            summary=summary,
            timeline=[_entry(e) for e in facts.timeline],
            evidence_refs=i.evidence_refs,
            executions=executions,
            narrative=_narrative(facts, executions),
            ai=_ai(report.ai, fmt) if report.ai else None,
            verdict=_verdict(report.investigation, fmt) if report.investigation else None,
        )
    )
