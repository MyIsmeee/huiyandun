"""场景区域（FR-908、D-124、TK-152）：首次启动的默认区域、增删改、并发覆盖 409、审计、site 频道推送与初稿识别帧（FR-909）。"""

import asyncio
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from datetime import UTC, datetime
from typing import Any

import nats
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text, update
from starlette.testclient import WebSocketTestSession

from api_server import cameras, scene
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from py_contracts.api import WsFrame
from py_contracts.events.hyd_vision_scene_reply_v1_schema import VisionSceneReplyV1
from py_contracts.events.hyd_vision_scene_request_v1_schema import VisionSceneRequestV1

rid = iter(range(10**6))
MARK = WsFrame(channel="system", data={"type": "scene-test-mark"})
ITEMS = [
    {"asset": "office-block", "x": 4, "y": 6, "rot": 90, "len": None},
    {"asset": "wall", "x": 0, "y": 0, "rot": 0, "len": 12},
]


def headers() -> dict[str, str]:
    return {"X-Request-ID": f"req-area-{next(rid)}"}


def reset(db: tuple[ApiConfig, ApiConfig]) -> None:
    """回到首次启动前：无摄像头、无区域、默认区域未建过、两个编号序列都未分配过。"""

    async def main() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(delete(cameras.cameras))
            await conn.execute(delete(scene.scene_areas))
            await conn.execute(update(scene.scene_bootstrap).values(default_area_done=False))
        async with transaction(db[0]) as conn:  # 序列重置须属主权限
            await conn.execute(text("ALTER SEQUENCE camera_id_seq RESTART"))
            await conn.execute(text("ALTER SEQUENCE scene_area_id_seq RESTART"))

    asyncio.run(main())


def start(config: ApiConfig, password: str) -> Iterator[TestClient]:
    with TestClient(create_app(config), base_url="https://testserver") as c:
        body = {"username": "admin", "password": password}
        assert c.post("/api/auth/login", json=body, headers=headers()).status_code == 200
        deadline = time.monotonic() + 10  # 初始导入与默认区域由后台任务完成
        while not c.get("/api/cameras").json()["items"]:
            assert time.monotonic() < deadline, "初始导入超时"
            time.sleep(0.1)
        yield c


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    reset(db)
    yield from start(db[1], password)
    reset(db)  # 其他用例的 api-server 启动时重新初始导入


def areas(c: TestClient) -> list[dict[str, Any]]:
    r = c.get("/api/scene/areas")
    assert r.status_code == 200, r.text
    return r.json()["items"]


def placements(c: TestClient) -> dict[str, tuple[str | None, dict[str, Any]]]:
    return {
        cam["id"]: (cam["area_id"], cam["pose"]) for cam in c.get("/api/cameras").json()["items"]
    }


def save(c: TestClient, area: dict[str, Any], **changes: Any) -> Any:
    body = {k: area[k] for k in ("name", "width_m", "depth_m", "items", "updated_at")}
    return c.put(
        f"/api/scene/areas/{area['id']}",
        json=body | {"cameras": []} | changes,
        headers=headers(),
    )


def audits(config: ApiConfig, action: str, r: Any) -> list[dict[str, Any]]:
    """审计表只增不删，按本次请求的请求 ID 取。"""
    query = select(audit_log).where(
        audit_log.c.action == action, audit_log.c.request_id == r.headers["X-Request-ID"]
    )

    async def query_rows() -> list[dict[str, Any]]:
        async with transaction(config) as conn:
            rows = await conn.execute(query)
            return [dict(r) for r in rows.mappings()]

    return asyncio.run(query_rows())


def test_first_boot_creates_default_area_with_cameras(
    client: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    [area] = areas(client)
    assert {k: area[k] for k in ("id", "name", "width_m", "depth_m", "items")} == {
        "id": "area-01",
        "name": "默认区域",
        "width_m": 40,
        "depth_m": 24,
        "items": [],
    }
    # 现有摄像头放入默认区域，坐标不变（site.yaml 的 cam-01 在 (2, 2)、cam-02 在 (38, 22)）
    placed = placements(client)
    assert {k: (a, p["x"], p["y"]) for k, (a, p) in placed.items()} == {
        "cam-01": ("area-01", 2, 2),
        "cam-02": ("area-01", 38, 22),
    }
    site = client.get("/api/site").json()
    assert site["areas"] == [area]
    assert {d["camera"]["area_id"] for d in site["devices"]} == {"area-01"}
    [audit] = latest_system_audit(db[1])
    assert (audit["target"], [c["id"] for c in audit["after"]["cameras"]]) == (
        "area-01",
        ["cam-01", "cam-02"],
    )


def latest_system_audit(config: ApiConfig) -> list[dict[str, Any]]:
    query = (
        select(audit_log)
        .where(audit_log.c.actor == "system", audit_log.c.action == "scene_area.created")
        .order_by(audit_log.c.id.desc())
        .limit(1)
    )

    async def main() -> list[dict[str, Any]]:
        async with transaction(config) as conn:
            return [dict(r) for r in (await conn.execute(query)).mappings()]

    return asyncio.run(main())


def test_default_area_is_retried_after_failed_attempt(
    client: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    """建到一半失败（已取号）回滚后，下次启动仍会建：判断依据随事务回滚，不看序列。"""

    async def main() -> list[Any]:
        async with transaction(db[1]) as conn:
            await conn.execute(update(cameras.cameras).values(area_id=None))
            await conn.execute(delete(scene.scene_areas))
            await conn.execute(update(scene.scene_bootstrap).values(default_area_done=False))
        with pytest.raises(RuntimeError):
            async with transaction(db[1]) as conn:
                await scene.ensure_default_area(conn, 40, 24)
                raise RuntimeError("启动中断")
        async with transaction(db[1]) as conn:
            await scene.ensure_default_area(conn, 40, 24)
            return list(await conn.execute(select(cameras.cameras.c.area_id)))

    assert {r.area_id for r in asyncio.run(main())} == {"area-03"}  # area-02 随失败的尝试作废
    assert [a["name"] for a in areas(client)] == ["默认区域"]


def test_camera_page_edit_makes_scene_save_stale(client: TestClient) -> None:
    [area] = areas(client)
    rename = client.patch("/api/cameras/cam-01", json={"name": "东门"}, headers=headers())
    assert rename.status_code == 200
    assert areas(client) == [area]  # 不涉及位置的修改不影响场景编辑

    pose = placements(client)["cam-01"][1] | {"yaw_deg": 180}
    r = client.patch("/api/cameras/cam-01", json={"pose": pose}, headers=headers())
    assert r.status_code == 200, r.text

    cam = {"id": "cam-01", "x": 2, "y": 2, "yaw_deg": 90}
    assert save(client, area, cameras=[cam]).status_code == 409
    assert placements(client)["cam-01"][1]["yaw_deg"] == 180


def test_deleting_camera_makes_scene_save_stale(client: TestClient) -> None:
    [area] = areas(client)

    assert client.delete("/api/cameras/cam-02", headers=headers()).status_code == 204

    assert areas(client)[0]["updated_at"] != area["updated_at"]
    assert save(client, area).status_code == 409


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        (
            {"items": [ITEMS[0] | {"x": 41}]},
            "items.0: 位置 (41, 6) 超出区域 40×24 m",
        ),
        (
            {"depth_m": 20, "cameras": [{"id": "cam-02", "x": 38, "y": 22, "yaw_deg": 225}]},
            "cameras.0: 位置 (38, 22) 超出区域 40×20 m",
        ),
    ],
    ids=["item", "camera-after-shrink"],
)
def test_save_rejects_points_outside_area(
    client: TestClient, changes: dict[str, Any], message: str
) -> None:
    [area] = areas(client)

    r = save(client, area, **changes)

    assert (r.status_code, r.json()["message"]) == (400, message)
    assert areas(client) == [area]


def test_default_area_is_not_recreated(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], password: str
) -> None:
    [area] = areas(client)
    assert save(client, area).status_code == 200  # 摄像头移出
    assert client.delete("/api/scene/areas/area-01", headers=headers()).status_code == 204

    for restarted in start(db[1], password):
        assert areas(restarted) == []
        assert {a for a, _ in placements(restarted).values()} == {None}


def test_create_save_and_audit(
    client: TestClient,
    db: tuple[ApiConfig, ApiConfig],
    ws_connect: Callable[[], AbstractContextManager[WebSocketTestSession]],
) -> None:
    r = client.post(
        "/api/scene/areas",
        json={"name": "机房", "width_m": 12, "depth_m": 8},
        headers=headers(),
    )
    assert r.status_code == 201, r.text
    created = r.json()
    assert (created["id"], created["items"]) == ("area-02", [])
    [audit] = audits(db[1], "scene_area.created", r)
    assert audit["after"] == {
        "id": "area-02",
        "name": "机房",
        "width_m": 12,
        "depth_m": 8,
        "items": [],
    }

    with ws_connect() as ws:
        cam = {"id": "cam-02", "x": 3, "y": 4.5, "yaw_deg": 270}
        r = save(client, created, name="一号机房", items=ITEMS, cameras=[cam])
        assert r.status_code == 200, r.text
        client.app.state.hub.broadcast(MARK)
        frames = []
        while (frame := ws.receive_json()) != MARK.model_dump(mode="json"):
            frames.append(frame)

    saved = r.json()
    assert saved["items"] == ITEMS and saved["updated_at"] != created["updated_at"]
    assert [a for a in areas(client) if a["id"] == "area-02"] == [saved]
    # 位置与朝向写回登记表，安装高度等不变
    area_id, pose = placements(client)["cam-02"]
    assert (area_id, pose["x"], pose["y"], pose["yaw_deg"], pose["height_m"]) == (
        "area-02",
        3,
        4.5,
        270,
        3,
    )
    [pushed] = [f["data"] for f in frames if f["channel"] == "site"]
    assert [a["name"] for a in pushed["areas"]] == ["默认区域", "一号机房"]

    [audit] = audits(db[1], "scene_area.updated", r)
    assert (audit["before"]["name"], audit["before"]["cameras"]) == ("机房", [])
    assert (audit["after"]["items"], audit["after"]["cameras"]) == (ITEMS, [cam])
    # 从默认区域移入：默认区域的 updated_at 随之更新，那边打开的编辑保存时会得到 409
    [default] = [a for a in areas(client) if a["id"] == "area-01"]
    assert default["updated_at"] == saved["updated_at"]


def test_stale_save_is_rejected(client: TestClient) -> None:
    [area] = areas(client)
    assert save(client, area, name="大厅").status_code == 200

    r = save(client, area, name="停车场")  # 带的是旧的 updated_at

    assert r.status_code == 409
    assert r.json()["message"] == "场景已被其他人修改，请重新载入"
    assert areas(client)[0]["name"] == "大厅"


def test_camera_not_listed_leaves_area(client: TestClient) -> None:
    [area] = areas(client)
    keep = {"id": "cam-01", "x": 2, "y": 2, "yaw_deg": 45}

    assert save(client, area, cameras=[keep]).status_code == 200

    assert {k: a for k, (a, _) in placements(client).items()} == {
        "cam-01": "area-01",
        "cam-02": None,
    }


@pytest.mark.parametrize(
    ("cams", "message"),
    [
        ([{"id": "cam-09", "x": 1, "y": 1, "yaw_deg": 0}], "cameras: 摄像头 cam-09 不存在"),
        ([{"id": "cam-01", "x": 1, "y": 1, "yaw_deg": 0}] * 2, "cameras: 同一摄像头列出了多次"),
    ],
    ids=["unknown", "duplicate"],
)
def test_save_rejects_bad_cameras(client: TestClient, cams: list[Any], message: str) -> None:
    [area] = areas(client)

    r = save(client, area, cameras=cams)

    assert (r.status_code, r.json()["message"]) == (400, message)
    assert areas(client) == [area]


def test_delete_area_with_cameras_is_rejected(client: TestClient) -> None:
    r = client.delete("/api/scene/areas/area-01", headers=headers())

    assert r.status_code == 409
    assert len(areas(client)) == 1


def test_delete_is_audited_and_ids_are_not_reused(
    client: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    body = {"name": "临时", "width_m": 5, "depth_m": 5}
    created = client.post("/api/scene/areas", json=body, headers=headers()).json()

    r = client.delete(f"/api/scene/areas/{created['id']}", headers=headers())
    assert r.status_code == 204

    [audit] = audits(db[1], "scene_area.deleted", r)
    assert (audit["target"], audit["before"]["name"], audit["after"]) == ("area-02", "临时", None)
    again = client.post("/api/scene/areas", json=body, headers=headers()).json()
    assert again["id"] == "area-03"


def test_unknown_area_and_roles(client: TestClient, password: str) -> None:
    gone = {"name": "x", "width_m": 1, "depth_m": 1, "items": [], "cameras": []}
    r = client.put(
        "/api/scene/areas/area-99",
        json=gone | {"updated_at": "2026-11-08T00:00:00Z"},
        headers=headers(),
    )
    assert r.status_code == 404
    assert client.delete("/api/scene/areas/area-99", headers=headers()).status_code == 404

    body = {"username": "viewer", "password": password}
    client.post("/api/auth/login", json=body, headers=headers())
    assert len(areas(client)) == 1  # viewer 可读
    body = {"name": "x", "width_m": 1, "depth_m": 1}
    assert client.post("/api/scene/areas", json=body, headers=headers()).status_code == 403
    assert client.delete("/api/scene/areas/area-01", headers=headers()).status_code == 403


def answer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, reasons: dict[str, str] | Exception
) -> list[VisionSceneRequestV1]:
    """以假应答代替 vision-engine：reasons 中的摄像头按原因识别不了，其余各返回一帧；返回收到的请求。"""
    asked: list[VisionSceneRequestV1] = []

    async def request(
        subject: str, event: VisionSceneRequestV1, model: type[VisionSceneReplyV1], timeout_s: float
    ) -> VisionSceneReplyV1:
        assert subject == "hyd.vision.scene_request.v1"
        asked.append(event)
        if isinstance(reasons, Exception):
            raise reasons
        stamp = {"schema_version": "1.0.0", "event_id": uuid.uuid4(), "ts": datetime.now(UTC)}
        surfaces = [{"class": "road", "polygon": [[0, 0], [8, 0], [8, 8]]}]
        empty: dict[str, Any] = {"walls": [], "objects": [], "trees": [], "markings": []}
        return model.model_validate(
            stamp
            | {
                "frames": [
                    stamp | empty | {"camera_id": i, "surfaces": surfaces}
                    for i in event.camera_ids
                    if i not in reasons
                ],
                "unavailable": [
                    {"camera_id": i, "reason": reasons[i]} for i in event.camera_ids if i in reasons
                ],
            }
        )

    monkeypatch.setattr(client.app.state.bus, "request", request)
    return asked


def test_frames_recognized_on_request_with_reasons(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """初稿（FR-909、D-133）：对区域内摄像头各识别一次；识别不了的给出原因（#288）。"""
    [area] = areas(client)
    asked = answer(client, monkeypatch, {"cam-02": "no_frame"})

    r = client.get(f"/api/scene/areas/{area['id']}/frames")

    assert r.status_code == 200, r.text
    body = r.json()
    assert [a.camera_ids for a in asked] == [["cam-01", "cam-02"]]
    assert [f["camera_id"] for f in body["frames"]] == ["cam-01"]
    assert body["frames"][0]["surfaces"][0]["class"] == "road"
    assert body["unavailable"] == [{"camera_id": "cam-02", "reason": "no_frame"}]
    assert body["stale"] == ["cam-02"]


def test_frames_skip_cameras_outside_area(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    [area] = areas(client)
    keep = {"id": "cam-01", "x": 2, "y": 2, "yaw_deg": 45}
    assert save(client, area, cameras=[keep]).status_code == 200
    asked = answer(client, monkeypatch, {"cam-01": "model_missing"})

    body = client.get(f"/api/scene/areas/{area['id']}/frames").json()

    assert [a.camera_ids for a in asked] == [["cam-01"]]
    assert body["unavailable"] == [{"camera_id": "cam-01", "reason": "model_missing"}]


def test_frames_of_area_without_cameras_ask_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    [area] = areas(client)
    assert save(client, area, cameras=[]).status_code == 200
    asked = answer(client, monkeypatch, {})

    body = client.get(f"/api/scene/areas/{area['id']}/frames").json()

    assert body == {"frames": [], "unavailable": [], "stale": []}
    assert asked == []


@pytest.mark.parametrize("error", [nats.errors.NoRespondersError(), TimeoutError()])
def test_frames_503_when_vision_engine_does_not_answer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    [area] = areas(client)
    answer(client, monkeypatch, error)

    r = client.get(f"/api/scene/areas/{area['id']}/frames")

    assert r.status_code == 503
    assert r.json()["message"] == "识别服务未响应，请稍后重试"


def test_frames_need_admin_and_known_area(client: TestClient, password: str) -> None:
    assert client.get("/api/scene/areas/area-99/frames").status_code == 404

    body = {"username": "viewer", "password": password}
    client.post("/api/auth/login", json=body, headers=headers())
    assert client.get("/api/scene/areas/area-01/frames").status_code == 403
