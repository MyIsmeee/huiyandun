"""摄像头登记表（FR-905～FR-907、D-101、D-103、TK-125）：增删改、口令加密、同步 go2rtc、下发登记表。

数据库为准；表为空时从 site.yaml 的 cameras 初始导入。每次变更后：重建站点设备并经 WS site 频道推送，
按登记表增删 go2rtc 的流，发布 hyd.config.cameras.v1（只保留最新一条，不含凭据与取流地址），
各服务据此热更新（FR-906）。取流地址只由本模块按协议、主机、端口、路径拼出，不接受完整地址：
go2rtc 的 exec: 等源可执行命令（D-103）。口令只写不读（C-ST-03），日志不含地址（G-14、SD-06）。
"""

import asyncio
import ipaddress
import logging
import re
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote

import httpx2
import yaml
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    LargeBinary,
    MetaData,
    Table,
    Text,
    delete,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from api_server.audit import record
from api_server.auth import Principal, require
from api_server.llm import seal, unseal
from api_server.site import MIN_CALIBRATION_POINTS
from py_contracts.api import Camera, CameraCreate, CameraList, CameraUpdate, Device, Site, WsFrame
from py_contracts.config.site_schema import SiteConfig
from py_contracts.events.hyd_config_cameras_v1_schema import ConfigCamerasV1

log = logging.getLogger(__name__)

SUBJECT = "hyd.config.cameras.v1"
STREAM = "HYD_CONFIG"
STREAM_MAX_AGE_S = 0  # 永久：每主题只保留最新一条
SCHEMA_VERSION = "1.0.0"
MAX_CAMERAS = 16  # D0 档位规划 4～8 路（architecture.md §11），留余量；超出拒绝（125 设计 §8）
# 推流接收（TK-129）的 ingest-net 固定地址：两者同在 edge-net，按名称会走 edge-net，而 ingest 只放行 ingest-net 上的 go2rtc
INGEST_RTSP = "rtsp://172.30.10.10:8554"
SYNC_S = 30  # go2rtc 重启会丢掉动态添加的流：定期比对补齐
RETRY_S = 2
CREATE_LOCK = 0x48594431  # 新增摄像头的事务级咨询锁：并发新增时路数上限不被同时突破
ID_SEQUENCE = "camera_id_seq"  # 编号只增不复用（D-108）
# 取流主机不能指向 go2rtc 或 ingest 自身：取流请求会落到视频服务自己身上（D-103、D-117）
FORBIDDEN_HOSTS = {"localhost", "go2rtc", "ingest"}
# go2rtc 与 ingest 在内部网络的固定地址（compose.yaml，tests/test_compose.py 核对一致）：
# 填成拉流来源会让它们拉自己，形成回环
SELF_ADDRESSES = {"172.30.10.2", "172.30.11.2", "172.30.12.2", "172.30.10.10", "172.30.11.3"}
SNAPSHOT_TIMEOUT_S = 8.0  # 首帧须等关键帧，摄像头的关键帧间隔常为 2～4 s
SNAPSHOT_ERRORS = {
    404: "视频服务中没有这路流：拉流地址尚未同步，稍后重试",
    500: "取不到画面：检查地址、端口、口令，以及摄像头是否在线",
}
# go2rtc 连上了但不认这路流的编码（如 SDP 把媒体标为 sendonly）：提示打开兼容模式（04 V-CAM8、D-117）
SNAPSHOT_UNRECOGNIZED = "视频服务无法识别这路流的编码：可在编辑中打开兼容模式（经中继拉流）"

metadata = MetaData()
cameras = Table(
    "cameras",
    metadata,
    Column("id", Text, primary_key=True),
    Column("name", Text),
    Column("ip", INET),
    Column("ingest", Text),
    Column("protocol", Text),
    Column("host", Text),
    Column("port", Integer),
    Column("path", Text),
    Column("username", Text),
    Column("password_enc", LargeBinary),
    Column("relay", Boolean),
    Column("pose", JSONB),
    Column("calibration", JSONB),
    Column("climb_lines", JSONB),
    Column("created_at", DateTime(timezone=True)),
    Column("updated_at", DateTime(timezone=True)),
)


def source_url(row: Any, password: str | None) -> str:
    """go2rtc 的取流地址。拉流按协议拼出；推流的设备推到 ingest，兼容模式由 ingest 中继拉流，
    这两种 go2rtc 都从 ingest 按摄像头编号取（D-103、D-117，ingest 只放行 go2rtc 读取）。"""
    if row["ingest"] != "pull" or row["relay"]:
        return f"{INGEST_RTSP}/{row['id']}"
    return camera_url(row, password)


def camera_url(row: Any, password: str | None) -> str:
    """拉流摄像头本身的地址：按协议、主机、端口、路径拼出，用户名与口令按 URL 规则转义（D-103）。"""
    auth = ""
    if row["username"]:
        auth = quote(row["username"], safe="")
        auth += f":{quote(password, safe='')}@" if password else "@"
    host = (
        f"[{row['host']}]"
        if ":" in row["host"] and not row["host"].startswith("[")
        else row["host"]
    )
    path = row["path"].lstrip("/")
    if row["protocol"] == "onvif":
        return f"onvif://{auth}{host}:{row['port']}"
    return f"{row['protocol']}://{auth}{host}:{row['port']}/{path}"


def masked(url: str) -> str:
    """go2rtc 列出的流地址把用户名与口令显示为 ***，比对时按同样方式遮盖。"""
    return re.sub(r"//[^/@]*@", "//***@", url, count=1)


def view(row: Any) -> Camera:
    pull = row["ingest"] == "pull"
    return Camera.model_validate(
        {
            "id": row["id"],
            "name": row["name"],
            "ip": str(row["ip"]),
            "ingest": row["ingest"],
            "source": (
                {k: row[k] for k in ("protocol", "host", "port", "path", "relay")} if pull else None
            ),
            "username": row["username"],
            "password_set": row["password_enc"] is not None,
            "pose": row["pose"],
            "calibration": row["calibration"],
            "climb_lines": row["climb_lines"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
    )


def with_push_password(request: Request, camera: Camera, show: bool) -> Camera:
    """新增推流摄像头或改为推流时，在响应中给出一次推流口令供配置设备（V-CAM2）；列表与其余响应不含。"""
    if not show:
        return camera
    password = request.app.state.config.push_password_file.read_text(encoding="utf-8").strip()
    return camera.model_copy(update={"push_password": password})


def audit_view(camera: Camera) -> dict[str, Any]:
    """审计只记口令是否设置（G-13、C-ST-03）。"""
    return camera.model_dump(mode="json", exclude={"created_at", "updated_at"})


def device(row: Any, mode: str) -> Device:
    calibrated = len(row["calibration"]) >= MIN_CALIBRATION_POINTS
    return Device.model_validate(
        {
            "id": row["id"],
            "name": row["name"],
            "type": "camera",
            "ip": str(row["ip"]),
            "mode": mode,
            "state": "normal",
            "alert_severity": None,
            "camera": {
                "stream": row["id"],
                "pose": row["pose"],
                "calibration": row["calibration"],
                "mapping": "calibrated" if calibrated else "estimated",
                "homography": None,
                "reproj_error_m": None,
            },
        }
    )


def registry(rows: list[Any]) -> ConfigCamerasV1:
    return ConfigCamerasV1.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "event_id": str(uuid.uuid4()),
            "ts": datetime.now(UTC).isoformat(),
            "cameras": [
                {k: (str(r[k]) if k == "ip" else r[k]) for k in ("id", "name", "ip", "pose")}
                | {"calibration": r["calibration"], "climb_lines": r["climb_lines"]}
                for r in rows
            ],
        }
    )


def _check(values: dict[str, Any]) -> None:
    """契约之外的校验：拉流须有地址且不指向本机，警戒线不能竖直（FR-104）。"""
    if values["ingest"] == "pull" and values.get("protocol") is None:
        raise HTTPException(400, "source: 拉流方式须填写协议、主机、端口与路径")
    if values["ingest"] == "pull" and _local(values["host"]):
        raise HTTPException(400, "source.host: 不能是本机或视频服务自身的地址")
    if values.get("relay") and values["protocol"] not in RELAY_PROTOCOLS:
        raise HTTPException(400, "source.relay: 兼容模式只支持 RTSP、RTMP 拉流")
    for i, (u1, _, u2, _) in enumerate(values["climb_lines"]):
        if u1 == u2:
            raise HTTPException(400, f"climb_lines.{i}: 警戒线不能是竖直线段")


def _local(host: str) -> bool:
    """回环、未指定地址、localhost、go2rtc 与 ingest 的名称或固定地址：取流请求会落到视频服务自身。"""
    name = host.strip("[]").lower().rstrip(".")
    if name in FORBIDDEN_HOSTS or name in SELF_ADDRESSES or name.endswith(".localhost"):
        return True
    try:
        ip = ipaddress.ip_address(name)
    except ValueError:
        return False
    ip = getattr(ip, "ipv4_mapped", None) or ip  # ::ffff:127.0.0.1 同样是回环
    return ip.is_loopback or ip.is_unspecified or str(ip) in SELF_ADDRESSES


SOURCE_FIELDS = ("protocol", "host", "port", "path")
RELAY_PROTOCOLS = {"rtsp", "rtmp"}  # MediaMTX 能作为来源拉取的协议（D-117）


def _source_columns(source: dict[str, Any] | None, ingest: str) -> dict[str, Any]:
    """推流不保存拉流地址，也没有兼容模式。"""
    if ingest != "pull" or source is None:
        return dict.fromkeys(SOURCE_FIELDS) | {"relay": False}
    return {k: source[k] for k in SOURCE_FIELDS} | {"relay": bool(source.get("relay"))}


async def _rows(conn: AsyncConnection) -> list[Any]:
    return list((await conn.execute(select(cameras).order_by(cameras.c.id))).mappings())


async def _next_id(conn: AsyncConnection) -> str:
    """编号只增不复用（D-108）：删除 cam-02 后新增的是下一个未用过的编号。"""
    return f"cam-{await conn.scalar(select(func.nextval(ID_SEQUENCE))):02d}"


def _seeded_max(rows: list[dict[str, Any]]) -> int:
    """初始导入的 cam-NN 中最大的 NN：序列从其后开始，导入的编号删除后也不复用。"""
    numbers = [int(r["id"][4:]) for r in rows if re.fullmatch(r"cam-\d+", r["id"])]
    return max(numbers, default=0)


def seeds(site_file: Path, now: datetime) -> list[dict[str, Any]]:
    """site.yaml 的摄像头，作为登记表为空时的初始导入（site.load 已校验过同一文件）。"""
    config = SiteConfig.model_validate(yaml.safe_load(site_file.read_text(encoding="utf-8")))
    rows = []
    for c in config.model_dump(mode="json")["cameras"]:
        source = c.get("source")
        rows.append(
            {
                "id": c["id"],
                "name": c.get("name") or c["id"],
                "ip": c["ip"],
                "ingest": "pull" if source else "push",
                "protocol": source["protocol"] if source else None,
                "host": source["host"] if source else None,
                "port": source["port"] if source else None,
                "path": source["path"] if source else None,
                "username": None,
                "password_enc": None,
                "pose": c["pose"],
                "calibration": c.get("calibration") or [],
                "climb_lines": c.get("climb_lines") or [],
                "created_at": now,
                "updated_at": now,
            }
        )
    return rows


class Registry:
    """登记表在内存中的副本与变更后的下发。state 为 app.state。"""

    def __init__(self, state: Any) -> None:
        self._state = state
        self._lock = asyncio.Lock()  # 下发串行，各服务按先后收到登记表
        # 部署模式全站统一，设备的 mode 取此值
        site = yaml.safe_load(state.config.site_file.read_text(encoding="utf-8"))
        self._mode = SiteConfig.model_validate(site).site.mode
        self._pending = False  # 最近一次下发未完成（如总线不可达），尽快重试

    async def run(self) -> None:
        """启动时初始导入并下发（数据库或总线不可达时重试），之后定期比对 go2rtc。"""
        while True:
            try:
                async with self._state.engine.begin() as conn:
                    if not await conn.scalar(select(cameras.c.id).limit(1)):
                        now = datetime.now(UTC)
                        rows = seeds(self._state.config.site_file, now)
                        for row in rows:
                            await conn.execute(insert(cameras).values(row))
                        if _seeded_max(rows):
                            await conn.execute(select(func.setval(ID_SEQUENCE, _seeded_max(rows))))
                        log.info("cameras.seeded")
                break
            except Exception:
                log.exception("cameras.bootstrap_failed")
                await asyncio.sleep(RETRY_S)
        await self.apply()
        while True:
            # 下发未完成时 2 s 后重试；否则每 30 s 比对 go2rtc（其重启会丢掉动态添加的流）
            await asyncio.sleep(RETRY_S if self._pending else SYNC_S)
            if self._pending:
                await self.apply()
                continue
            try:
                await self.reconcile()
            except Exception:
                log.exception("cameras.sync_failed")

    async def reconcile(self) -> None:
        """定期比对：按库补齐 ingest 的中继路径与 go2rtc 的流。"""
        async with self._lock:
            rows = await self._load()
            try:
                await self._sync_ingest(rows)
            except (httpx2.HTTPError, ValueError):
                # ingest 不可达不耽误 go2rtc 的比对；兼容模式的摄像头待其恢复后补齐
                log.exception("cameras.ingest_unavailable")
            await self._sync_go2rtc(rows)

    async def _load(self) -> list[Any]:
        async with self._state.engine.connect() as conn:
            return await _rows(conn)

    async def apply(self) -> None:
        """按库重建站点设备（有变化时推送 site 频道）、同步 go2rtc、发布登记表。不抛出：数据库或总线不可达时记录，
        由 run 在 2 s 后重试；接口的保存已提交，不因下发失败而报保存失败。"""
        async with self._lock:
            try:
                await self._apply()
                self._pending = False
            except Exception:
                log.exception("cameras.apply_failed")
                self._pending = True

    async def _apply(self) -> None:
        rows = await self._load()
        site: Site = self._state.site
        devices = [device(r, self._mode) for r in rows]
        # 只在登记表实际变化时推送：启动时从 site.yaml 初始导入的结果与启动时的站点相同
        if devices != site.devices:
            self._state.site = site.model_copy(update={"devices": devices})
            self._state.devices.sync(devices, time.monotonic())
            self._state.hub.broadcast(
                WsFrame(channel="site", data=self._state.site.model_dump(mode="json"))
            )
        try:
            await self._sync_ingest(rows)
        except (httpx2.HTTPError, ValueError):
            log.exception("cameras.ingest_unavailable")
        try:
            await self._sync_go2rtc(rows)
        except (httpx2.HTTPError, ValueError):
            # 视频服务暂不可达：登记表照常下发，定期比对时补齐
            log.exception("cameras.go2rtc_unavailable")
        await self._state.bus.js_publish(SUBJECT, registry(rows))
        log.info("cameras.published", extra={"cameras": [r["id"] for r in rows]})

    async def _sync_ingest(self, rows: list[Any]) -> None:
        """兼容模式（D-117）：ingest 中每台开启兼容模式的摄像头一条同名中继路径，来源为摄像头本身的地址；
        其余 cam-NN 显式路径删除（推流走正则路径，不受影响）。口令只在内存中解密后写入 MediaMTX 配置。"""
        client = self._state.ingest
        res = await client.get("/v3/config/paths/list")
        res.raise_for_status()
        current = {
            item["name"]: item.get("source")
            for item in res.json().get("items") or []
            if re.fullmatch(r"cam-\d+", item["name"])
        }
        key_file = self._state.config.device_key_file
        desired = {}
        for r in rows:
            if r["ingest"] == "pull" and r["relay"]:
                password = unseal(key_file, r["password_enc"]) if r["password_enc"] else None
                desired[r["id"]] = camera_url(r, password)
        for name in current.keys() - desired.keys():
            (await client.delete(f"/v3/config/paths/delete/{name}")).raise_for_status()
            log.info("cameras.relay_removed", extra={"camera_id": name})
        for name, url in desired.items():
            if current.get(name) == url:
                continue
            conf = {"source": url, "sourceOnDemand": False, "rtspTransport": "tcp"}
            action = "patch" if name in current else "add"
            res = await client.request(
                "PATCH" if action == "patch" else "POST",
                f"/v3/config/paths/{action}/{name}",
                json=conf,
            )
            res.raise_for_status()
            log.info("cameras.relay_synced", extra={"camera_id": name})

    async def _sync_go2rtc(self, rows: list[Any]) -> None:
        """go2rtc 只按登记表拉流；登记表外的流删除。go2rtc 的 PATCH 只改地址不重连，修改时先删再加。"""
        client = self._state.go2rtc
        res = await client.get("/api/streams")
        res.raise_for_status()
        current = {
            name: [p.get("url") for p in (info or {}).get("producers") or []]
            for name, info in res.json().items()
        }
        key_file = self._state.config.device_key_file
        desired = {}
        for r in rows:
            password = unseal(key_file, r["password_enc"]) if r["password_enc"] else None
            desired[r["id"]] = source_url(r, password)
        for name in current.keys() - desired.keys():
            (await client.delete("/api/streams", params={"src": name})).raise_for_status()
            log.info("cameras.stream_removed", extra={"camera_id": name})
        for name, url in desired.items():
            if current.get(name) == [masked(url)]:
                continue
            if name in current:
                (await client.delete("/api/streams", params={"src": name})).raise_for_status()
            (await client.put("/api/streams", params={"name": name, "src": url})).raise_for_status()
            log.info("cameras.stream_synced", extra={"camera_id": name})


router = APIRouter(prefix="/api")
Admin = Annotated[Principal, Depends(require("admin"))]


async def _locked(conn: AsyncConnection, camera_id: str) -> Any:
    row = (
        (await conn.execute(select(cameras).where(cameras.c.id == camera_id).with_for_update()))
        .mappings()
        .first()
    )
    if row is None:
        raise HTTPException(404, "摄像头不存在")
    return row


@router.get("/cameras", dependencies=[Depends(require("admin"))])
async def list_cameras(request: Request) -> CameraList:
    async with request.app.state.engine.connect() as conn:
        return CameraList(items=[view(r) for r in await _rows(conn)])


@router.post("/cameras", status_code=201)
async def create_camera(body: CameraCreate, request: Request, principal: Admin) -> Camera:
    now = datetime.now(UTC)
    values: dict[str, Any] = {
        "name": body.name,
        "ip": str(body.ip),
        "ingest": body.ingest,
        "username": body.username.root if body.username and body.username.root else None,
        "password_enc": (
            seal(request.app.state.config.device_key_file, body.password.get_secret_value())
            if body.password and body.password.get_secret_value()
            else None
        ),
        "pose": body.pose.model_dump(mode="json"),
        "calibration": [],
        "climb_lines": [line.root for line in body.climb_lines or []],
        "created_at": now,
        "updated_at": now,
    } | _source_columns(body.source.model_dump() if body.source else None, body.ingest)
    _check(values)
    try:
        async with request.app.state.engine.begin() as conn:
            # 并发新增串行化：否则可能同时通过路数上限的检查
            await conn.execute(select(func.pg_advisory_xact_lock(CREATE_LOCK)))
            if len(await _rows(conn)) >= MAX_CAMERAS:
                raise HTTPException(409, f"最多登记 {MAX_CAMERAS} 路摄像头")
            values["id"] = await _next_id(conn)
            await conn.execute(insert(cameras).values(values))
            camera = view(values)
            await record(
                conn,
                actor=principal.username,
                action="camera.created",
                target=camera.id,
                before=None,
                after=audit_view(camera),
                request_id=request.state.request_id,
            )
    except IntegrityError as e:
        raise HTTPException(409, f"设备 IP {body.ip} 已被其他摄像头使用") from e
    await request.app.state.cameras.apply()
    return with_push_password(request, camera, camera.ingest == "push")


@router.patch("/cameras/{camera_id}")
async def update_camera(
    camera_id: str, body: CameraUpdate, request: Request, principal: Admin
) -> Camera:
    changes = body.model_dump(exclude_unset=True)
    try:
        async with request.app.state.engine.begin() as conn:
            row = await _locked(conn, camera_id)
            before = view(row)
            values: dict[str, Any] = dict(row)
            if body.name is not None:
                values["name"] = body.name
            if body.ip is not None:
                values["ip"] = str(body.ip)
            if "username" in changes:
                values["username"] = body.username.root if body.username else None
                values["username"] = values["username"] or None
            if body.pose is not None:
                values["pose"] = body.pose.model_dump(mode="json")
            if body.climb_lines is not None:
                values["climb_lines"] = [line.root for line in body.climb_lines]
            values["ingest"] = body.ingest or row["ingest"]
            # 未给出 source 时沿用库中的拉流地址（如只改接入方式）
            source = changes.get("source", None if row["protocol"] is None else dict(row))
            values |= _source_columns(source, values["ingest"])
            if body.clear_password:
                values["password_enc"] = None
            elif body.password is not None and body.password.get_secret_value():
                values["password_enc"] = seal(
                    request.app.state.config.device_key_file, body.password.get_secret_value()
                )
            _check(values)
            values["updated_at"] = datetime.now(UTC)
            await conn.execute(
                update(cameras)
                .where(cameras.c.id == camera_id)
                .values({k: v for k, v in values.items() if k not in ("id", "created_at")})
            )
            camera = view(values)
            await record(
                conn,
                actor=principal.username,
                action="camera.updated",
                target=camera_id,
                before=audit_view(before),
                after=audit_view(camera),
                request_id=request.state.request_id,
            )
    except IntegrityError as e:
        raise HTTPException(409, f"设备 IP {body.ip} 已被其他摄像头使用") from e
    await request.app.state.cameras.apply()
    return with_push_password(request, camera, camera.ingest == "push" and before.ingest != "push")


@router.delete("/cameras/{camera_id}", status_code=204)
async def delete_camera(camera_id: str, request: Request, principal: Admin) -> Response:
    async with request.app.state.engine.begin() as conn:
        row = await _locked(conn, camera_id)
        await conn.execute(delete(cameras).where(cameras.c.id == camera_id))
        await record(
            conn,
            actor=principal.username,
            action="camera.deleted",
            target=camera_id,
            before=audit_view(view(row)),
            after=None,
            request_id=request.state.request_id,
        )
    await request.app.state.cameras.apply()
    return Response(status_code=204)


@router.get("/cameras/{camera_id}/snapshot", dependencies=[Depends(require("viewer"))])
async def snapshot(camera_id: str, request: Request) -> Response:
    """经 go2rtc 取一帧 JPEG（编辑框预览 V-CAM4、摄像头栏缩略图 D-115），只返回给浏览器，不落盘、不进入事件或 LLM（C-LLM-04）。

    viewer 即可：同一路画面 viewer 本就能经 WebRTC 观看（FR-106），截帧不增加暴露面。
    """
    async with request.app.state.engine.connect() as conn:
        if await conn.scalar(select(cameras.c.id).where(cameras.c.id == camera_id)) is None:
            raise HTTPException(404, "摄像头不存在")
    try:
        res = await request.app.state.go2rtc.get(
            "/api/frame.jpeg", params={"src": camera_id}, timeout=SNAPSHOT_TIMEOUT_S
        )
    except httpx2.TimeoutException as e:
        raise HTTPException(502, "取画面超时：摄像头无响应或网络不通") from e
    except httpx2.HTTPError as e:
        raise HTTPException(502, "视频服务不可用") from e
    if res.status_code != 200 or not res.content:
        log.warning(
            "cameras.snapshot_failed", extra={"camera_id": camera_id, "status": res.status_code}
        )
        if b"codecs not matched" in res.content:
            raise HTTPException(502, SNAPSHOT_UNRECOGNIZED)
        raise HTTPException(502, SNAPSHOT_ERRORS.get(res.status_code, SNAPSHOT_ERRORS[500]))
    return Response(res.content, media_type="image/jpeg", headers={"Cache-Control": "no-store"})
