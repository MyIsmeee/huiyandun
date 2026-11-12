"""场景区域（FR-908、D-124、TK-152）：增删改，首次启动时的默认区域，以及供生成初稿的识别帧（FR-909）。

区域整体保存（PUT），带 updated_at 防并发覆盖；保存时把本区域摄像头的位置与朝向写回摄像头登记表。
在摄像头页改位置、朝向或删除摄像头同样更新所在区域的 updated_at（touch），场景页的旧编辑保存时得到 409。
每次变更写审计（G-13），之后由 cameras.Registry 按库重建站点、经 WS site 频道推送并下发登记表（FR-906）。
"""

import logging
import math
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

import nats
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import (
    Boolean,
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
    SceneAreaFrames,
    SceneAreaList,
    SceneAreaUpdate,
)
from py_contracts.events.hyd_vision_scene_reply_v1_schema import VisionSceneReplyV1
from py_contracts.events.hyd_vision_scene_request_v1_schema import VisionSceneRequestV1

log = logging.getLogger(__name__)

ID_SEQUENCE = "scene_area_id_seq"  # 编号只增不复用
DEFAULT_NAME = "默认区域"
MAX_SIZE_M = 500  # 与契约、表约束一致
# 改动区域或摄像头位置的事务先取这把锁：区域行与摄像头行的加锁顺序因此不会交叉，避免死锁
SCENE_LOCK = 0x48594432
RECOGNIZE_SUBJECT = "hyd.vision.scene_request.v1"
# vision-engine 逐台识别，每台约 0.1 s（#286 实测 1080p 78 ms），首次推理另有预热
RECOGNIZE_TIMEOUT_S = 15.0

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
scene_bootstrap = Table("scene_bootstrap", metadata, Column("default_area_done", Boolean))


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


async def lock(conn: AsyncConnection) -> None:
    await conn.execute(select(func.pg_advisory_xact_lock(SCENE_LOCK)))


async def touch(conn: AsyncConnection, area_id: str, now: datetime) -> None:
    """区域内容未变、但其中的摄像头被改动：在别处打开的该区域编辑须重新载入。"""
    await conn.execute(
        update(scene_areas).where(scene_areas.c.id == area_id).values(updated_at=now)
    )


async def ensure_default_area(conn: AsyncConnection, width_m: float, height_m: float) -> None:
    """首次启动（含从无区域的版本升级）：按 site.yaml 的尺寸建默认区域，现有摄像头放入其中、坐标不变
    （设计 150 §5）。标志与区域在同一事务内写入，失败时一并回滚；之后管理员删光区域也不再重建。"""
    claim = (
        update(scene_bootstrap)
        .where(scene_bootstrap.c.default_area_done.is_(False))
        .values(default_area_done=True)
        .returning(scene_bootstrap.c.default_area_done)
    )
    if await conn.scalar(claim) is None:
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
    placed = await conn.execute(
        update(cameras).values(area_id=area.id).returning(cameras.c.id, cameras.c.pose)
    )
    await record(
        conn,
        actor="system",
        action="scene_area.created",
        target=area.id,
        before=None,
        after=_audit(area, [_placement(r) for r in placed.mappings()]),
        request_id=str(uuid.uuid4()),
    )
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


def _check_inside(body: SceneAreaUpdate) -> None:
    """物体与摄像头的放置点须在区域内（D-125），缩小区域时同样校验。"""
    points = [(f"items.{i}", p.x, p.y) for i, p in enumerate(body.items)]
    points += [(f"cameras.{i}", c.x, c.y) for i, c in enumerate(body.cameras)]
    outside = [
        f"{path}: 位置 ({x:g}, {y:g}) 超出区域 {body.width_m}×{body.depth_m} m"
        for path, x, y in points
        if x > body.width_m or y > body.depth_m
    ]
    if outside:
        raise HTTPException(400, "; ".join(outside))


@router.put("/areas/{area_id}")
async def save_area(
    area_id: str, body: SceneAreaUpdate, request: Request, principal: Admin
) -> SceneArea:
    placed: dict[str, CameraPlacement] = {c.id: c for c in body.cameras}
    if len(placed) < len(body.cameras):
        raise HTTPException(400, "cameras: 同一摄像头列出了多次")
    _check_inside(body)
    now = datetime.now(UTC)
    async with request.app.state.engine.begin() as conn:
        await lock(conn)
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
        for other in sorted(moved_from):
            await touch(conn, other, now)
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


@router.get("/areas/{area_id}/frames", dependencies=[Depends(require("admin"))])
async def get_frames(area_id: str, request: Request) -> SceneAreaFrames:
    """请 vision-engine 对区域内摄像头的当前画面各识别一次（D-133），供场景页生成初稿（FR-909）；
    只读，草稿由场景页转换。"""
    async with request.app.state.engine.connect() as conn:
        if await conn.scalar(select(scene_areas.c.id).where(scene_areas.c.id == area_id)) is None:
            raise HTTPException(404, "区域不存在")
        query = select(cameras.c.id).where(cameras.c.area_id == area_id).order_by(cameras.c.id)
        ids = list((await conn.execute(query)).scalars())
    if not ids:
        return SceneAreaFrames(frames=[], unavailable=[], stale=[])
    ask = VisionSceneRequestV1(
        schema_version="1.0.0", event_id=uuid.uuid4(), ts=datetime.now(UTC), camera_ids=ids
    )
    try:
        reply = await request.app.state.bus.request(
            RECOGNIZE_SUBJECT, ask, VisionSceneReplyV1, RECOGNIZE_TIMEOUT_S
        )
    except (nats.errors.Error, TimeoutError) as e:
        log.warning("scene.recognize_failed", extra={"area_id": area_id, "error": repr(e)})
        raise HTTPException(503, "识别服务未响应，请稍后重试") from e
    found = reply.model_dump(mode="json")
    stale = [u["camera_id"] for u in found["unavailable"]]
    return SceneAreaFrames.model_validate(
        {"frames": found["frames"], "unavailable": found["unavailable"], "stale": stale}
    )


@router.delete("/areas/{area_id}", status_code=204)
async def delete_area(area_id: str, request: Request, principal: Admin) -> Response:
    async with request.app.state.engine.begin() as conn:
        await lock(conn)
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
