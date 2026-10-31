"""溯源报告（FR-501～FR-504、TK-070）：事实区全部取自近 24 小时历史中的结构化事件，不经过 LLM（V-AI1）。

供应商调用链（TK-062）接入前只有模板路径：AI 区为空并注明原因（FR-502、C-LLM-09）。
生成与复核各写一条审计，与报告的写入同一事务（G-13、AI-M-05）。
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import Column, DateTime, MetaData, Table, Text, insert, select, update
from sqlalchemy.dialects.postgresql import JSONB

from api_server.audit import record
from api_server.auth import Principal, require
from api_server.history import History
from py_contracts.api import Report, ReportFacts, Site
from py_contracts.events.hyd_correlator_incident_v1_schema import CorrelatorIncidentV1
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1

DEGRADED_REASON = "未启用任何模型供应商"
KINDS = {
    SecurityAlertV1: "security_alert",
    VisionBehaviorV1: "behavior",
    VisionIntegrityV1: "integrity",
}
ENVELOPE = {"schema_version", "event_id", "ts"}  # 事件公共字段，实体不含

# 表结构由迁移 0004 定义
report_table = Table(
    "report",
    MetaData(),
    Column("id", Text, primary_key=True),
    Column("incident_id", Text),
    Column("facts", JSONB),
    Column("ai", JSONB(none_as_null=True)),
    Column("source", Text),
    Column("provider_id", Text),
    Column("degraded_reason", Text),
    Column("reviewed_by", Text),
    Column("reviewed_at", DateTime(timezone=True)),
    Column("created_at", DateTime(timezone=True)),
)

router = APIRouter(prefix="/api")


def facts(incident: CorrelatorIncidentV1, history: History, site: Site) -> ReportFacts:
    """命中路径中找不到的事件（超出保留范围或未收到）记为证据缺失，不中断生成。"""
    devices = {d.id: d for d in site.devices}
    timeline: list[dict[str, Any]] = []
    for event_id in incident.hit_path:
        event = history.event(event_id)
        timeline.append(
            {
                "event_id": event_id,
                "kind": KINDS[type(event)] if event else None,
                "event": event.model_dump(mode="json") if event else None,
            }
        )
    return ReportFacts.model_validate(
        {
            "incident": incident.model_dump(mode="json", exclude=ENVELOPE),
            "devices": [
                {"id": d.id, "type": d.type, "ip": d.ip}
                for d in (devices.get(i) for i in incident.device_ids)
                if d is not None
            ],
            "timeline": timeline,
            "executions": [
                e.model_dump(mode="json", exclude=ENVELOPE)
                for e in history.executions_of(incident.id)
            ],
        }
    )


@router.post("/incidents/{incident_id}/reports", status_code=201)
async def create_report(
    incident_id: str,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> Report:
    state = request.app.state
    incident = state.history.incident(incident_id)
    if incident is None:
        raise HTTPException(404, "关联事件不存在或已超过 24 小时")
    report = Report(
        id=str(uuid.uuid4()),
        incident_id=incident_id,
        facts=facts(incident, state.history, state.site),
        ai=None,
        source="template",
        provider_id=None,
        degraded_reason=DEGRADED_REASON,
        reviewed_by=None,
        reviewed_at=None,
        created_at=datetime.now(UTC),
    )
    async with state.engine.begin() as conn:
        await conn.execute(
            insert(report_table).values(
                report.model_dump(exclude={"facts"})
                | {"facts": report.facts.model_dump(mode="json")}
            )
        )
        await record(
            conn,
            actor=principal.username,
            action="report.created",
            target=incident_id,
            before=None,
            after={"report_id": report.id, "source": report.source},
            request_id=request.state.request_id,
        )
    return report


@router.get("/reports/{report_id}", dependencies=[Depends(require("viewer"))])
async def get_report(report_id: str, request: Request) -> Report:
    async with request.app.state.engine.connect() as conn:
        row = (
            (await conn.execute(select(report_table).where(report_table.c.id == report_id)))
            .mappings()
            .first()
        )
    if row is None:
        raise HTTPException(404, "报告不存在")
    return Report.model_validate(dict(row))


@router.post("/reports/{report_id}/review")
async def review_report(
    report_id: str,
    request: Request,
    principal: Annotated[Principal, Depends(require("operator"))],
) -> Report:
    async with request.app.state.engine.begin() as conn:
        row = (
            (
                await conn.execute(
                    update(report_table)
                    .where(report_table.c.id == report_id, report_table.c.reviewed_by.is_(None))
                    .values(reviewed_by=principal.username, reviewed_at=datetime.now(UTC))
                    .returning(*report_table.c)
                )
            )
            .mappings()
            .first()
        )
        if row is None:
            reviewer = await conn.scalar(
                select(report_table.c.reviewed_by).where(report_table.c.id == report_id)
            )
            if reviewer is None:
                raise HTTPException(404, "报告不存在")
            raise HTTPException(409, f"报告已由 {reviewer} 复核")
        report = Report.model_validate(dict(row))
        await record(
            conn,
            actor=principal.username,
            action="report.reviewed",
            target=report_id,
            before={"reviewed_by": None},
            after={
                "reviewed_by": report.reviewed_by,
                "reviewed_at": row["reviewed_at"].isoformat(),
            },
            request_id=request.state.request_id,
        )
    return report
