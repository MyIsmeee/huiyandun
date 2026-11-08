"""场景区域（FR-908、D-124、TK-152）：增删改，以及首次启动时的默认区域。

区域整体保存（PUT），带 updated_at 防并发覆盖；保存时把本区域摄像头的位置与朝向写回摄像头登记表。
每次变更写审计（G-13），之后由 cameras.Registry 按库重建站点、经 WS site 频道推送并下发登记表（FR-906）。
"""

import logging
import math
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import (
    Column,
    DateTime,
    Integer,
    MetaData,
    Table,
    Text,
    delete,
    func,
    insert,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import record
from api_server.auth import Principal, require
from py_contracts.api import (
    CameraPlacement,
    SceneArea,
    SceneAreaCreate,
    SceneAreaList,
    SceneAreaUpdate,
)

log = logging.getLogger(__name__)

ID_SEQUENCE = "scene_area_id_seq"  # 编号只增不复用
DEFAULT_NAME = "默认区域"
MAX_SIZE_M = 500  # 与契约、表约束一致

metadata = MetaData()
scene_areas = Table(
    "scene_areas",
    metadata,
    Column("id", Text, primary_key=True),
    Column("name", Text),
    Column("width_m", Integer),
    Column("depth_m", Integer),
    Column("items", JSONB),
    Column("updated_at", DateTime(timezone=True)),
)
# 摄像头登记表的完整定义见 cameras.cameras；此处只声明本模块读写的列
cameras = Table(
    "cameras",
    metadata,
    Column("id", Text, primary_key=True),
    Column("area_id", Text),
    Column("pose", JSONB),
    Column("updated_at", DateTime(timezone=True)),
)


def view(row: Any) -> SceneArea:
    return SceneArea.model_validate(dict(row))


def _values(area: SceneArea) -> dict[str, Any]:
    return area.model_dump(mode="json") | {"updated_at": area.updated_at}


def _audit(area: SceneArea, placements: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    values = area.model_dump(mode="json", exclude={"updated_at"})
    return values if placements is None else values | {"cameras": placements}


def _placement(row: Any) -> dict[str, Any]:
    pose = row["pose"]
    return {"id": row["id"], "x": pose["x"], "y": pose["y"], "yaw_deg": pose["yaw_deg"]}


async def list_areas(conn: AsyncConnection) -> list[SceneArea]:
    rows = await conn.execute(select(scene_areas).order_by(scene_areas.c.id))
    return [view(r) for r in rows.mappings()]


async def _next_id(conn: AsyncConnection) -> str:
    return f"area-{await conn.scalar(select(func.nextval(ID_SEQUENCE))):02d}"


async def ensure_default_area(conn: AsyncConnection, width_m: float, height_m: float) -> None:
    """区域编号从未分配过即首次启动（含从无区域的版本升级）：按 site.yaml 的尺寸建默认区域，
    现有摄像头放入其中、坐标不变（设计 150 §5）。之后管理员删光区域也不再重建。"""
    if await conn.scalar(text(f"SELECT is_called FROM {ID_SEQUENCE}")):
        return
    area = SceneArea(
        id=await _next_id(conn),
        name=DEFAULT_NAME,
        width_m=min(MAX_SIZE_M, math.ceil(width_m)),
        depth_m=min(MAX_SIZE_M, math.ceil(height_m)),
        items=[],
        updated_at=datetime.now(UTC),
    )
    await conn.execute(insert(scene_areas).values(_values(area)))
    await conn.execute(update(cameras).values(area_id=area.id))
    log.info("scene.default_area_created", extra={"area_id": area.id})


router = APIRouter(prefix="/api/scene")
Admin = Annotated[Principal, Depends(require("admin"))]


async def _locked(conn: AsyncConnection, area_id: str) -> Any:
    query = select(scene_areas).where(scene_areas.c.id == area_id).with_for_update()
    row = (await conn.execute(query)).mappings().first()
    if row is None:
        raise HTTPException(404, "区域不存在")
    return row


@router.get("/areas", dependencies=[Depends(require("viewer"))])
async def get_areas(request: Request) -> SceneAreaList:
    async with request.app.state.engine.connect() as conn:
        return SceneAreaList(items=await list_areas(conn))


@router.post("/areas", status_code=201)
async def create_area(body: SceneAreaCreate, request: Request, principal: Admin) -> SceneArea:
    async with request.app.state.engine.begin() as conn:
        area = SceneArea(
            id=await _next_id(conn),
            name=body.name,
            width_m=body.width_m,
            depth_m=body.depth_m,
            items=[],
            updated_at=datetime.now(UTC),
        )
        await conn.execute(insert(scene_areas).values(_values(area)))
        await record(
            conn,
            actor=principal.username,
            action="scene_area.created",
            target=area.id,
            before=None,
            after=_audit(area),
            request_id=request.state.request_id,
        )
    await request.app.state.cameras.apply()
    return area


@router.put("/areas/{area_id}")
async def save_area(
    area_id: str, body: SceneAreaUpdate, request: Request, principal: Admin
) -> SceneArea:
    placed: dict[str, CameraPlacement] = {c.id: c for c in body.cameras}
    if len(placed) < len(body.cameras):
        raise HTTPException(400, "cameras: 同一摄像头列出了多次")
    now = datetime.now(UTC)
    async with request.app.state.engine.begin() as conn:
        row = await _locked(conn, area_id)
        if row["updated_at"] != body.updated_at:
            raise HTTPException(409, "场景已被其他人修改，请重新载入")
        query = (
            select(cameras)
            .where(or_(cameras.c.area_id == area_id, cameras.c.id.in_(placed)))
            .order_by(cameras.c.id)
            .with_for_update()
        )
        rows = list((await conn.execute(query)).mappings())
        missing = placed.keys() - {r["id"] for r in rows}
        if missing:
            raise HTTPException(400, f"cameras: 摄像头 {'、'.join(sorted(missing))} 不存在")
        # 从其他区域移入的摄像头改变了原区域，原区域在别处打开的编辑须重新载入
        moved_from = {r["area_id"] for r in rows if r["id"] in placed} - {None, area_id}
        if moved_from:
            await conn.execute(
                update(scene_areas).where(scene_areas.c.id.in_(moved_from)).values(updated_at=now)
            )
        for r in rows:
            p = placed.get(r["id"])
            values: dict[str, Any] = {"area_id": None, "updated_at": now}
            if p is not None:
                pose = r["pose"] | {"x": p.x, "y": p.y, "yaw_deg": p.yaw_deg}
                values |= {"area_id": area_id, "pose": pose}
            await conn.execute(update(cameras).where(cameras.c.id == r["id"]).values(values))
        area = SceneArea(
            id=area_id,
            name=body.name,
            width_m=body.width_m,
            depth_m=body.depth_m,
            items=body.items,
            updated_at=now,
        )
        await conn.execute(
            update(scene_areas).where(scene_areas.c.id == area_id).values(_values(area))
        )
        await record(
            conn,
            actor=principal.username,
            action="scene_area.updated",
            target=area_id,
            before=_audit(view(row), [_placement(r) for r in rows if r["area_id"] == area_id]),
            after=_audit(area, [c.model_dump(mode="json") for c in body.cameras]),
            request_id=request.state.request_id,
        )
    await request.app.state.cameras.apply()
    return area


@router.delete("/areas/{area_id}", status_code=204)
async def delete_area(area_id: str, request: Request, principal: Admin) -> Response:
    async with request.app.state.engine.begin() as conn:
        row = await _locked(conn, area_id)
        inside = select(cameras.c.id).where(cameras.c.area_id == area_id).limit(1)
        if await conn.scalar(inside) is not None:
            raise HTTPException(409, "区域内仍有摄像头：先在场景页把摄像头移出")
        await conn.execute(delete(scene_areas).where(scene_areas.c.id == area_id))
        await record(
            conn,
            actor=principal.username,
            action="scene_area.deleted",
            target=area_id,
            before=_audit(view(row)),
            after=None,
            request_id=request.state.request_id,
        )
    await request.app.state.cameras.apply()
    return Response(status_code=204)
