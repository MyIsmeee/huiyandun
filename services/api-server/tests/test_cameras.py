"""摄像头登记表（FR-905～FR-907、D-101、D-103、TK-125）：初始导入、增删改、口令只写不读、审计、
取流地址拼接、go2rtc 同步与登记表下发。"""

import asyncio
import base64
import os
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, text

from api_server import cameras
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from api_server.llm import unseal

POSE = {
    "x": 12,
    "y": 3.5,
    "height_m": 3,
    "yaw_deg": 90,
    "pitch_deg": -30,
    "hfov_deg": 90,
    "range_m": 15,
}
GATE = {
    "name": "大门口",
    "ip": "192.168.8.31",
    "ingest": "pull",
    "source": {
        "protocol": "rtsp",
        "host": "192.168.8.31",
        "port": 554,
        "path": "/Streaming/Channels/101",
    },
    "username": "admin",
    "password": "p@ss word/1",
    "pose": POSE,
}
rid = iter(range(10**6))


def headers() -> dict[str, str]:
    return {"X-Request-ID": f"req-cam-{next(rid)}"}


@pytest.fixture
def key_file(tmp_path: Path) -> Path:
    path = tmp_path / "device_key_secret"
    path.write_text(base64.b64encode(os.urandom(32)).decode())
    return path


def login(client: TestClient, username: str, password: str) -> None:
    body = {"username": username, "password": password}
    assert client.post("/api/auth/login", json=body, headers=headers()).status_code == 200


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str, key_file: Path) -> Iterator[TestClient]:
    async def reset() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(delete(cameras.cameras))
        async with transaction(db[0]) as conn:  # 序列重置须属主权限
            await conn.execute(text("ALTER SEQUENCE camera_id_seq RESTART"))

    asyncio.run(reset())
    config = db[1].model_copy(update={"device_key_file": key_file})
    with TestClient(create_app(config), base_url="https://testserver") as c:
        login(c, "admin", password)
        # 登记表为空时由后台任务从 site.yaml 初始导入
        deadline = time.monotonic() + 10
        while len(c.get("/api/cameras").json()["items"]) < 2:
            assert time.monotonic() < deadline, "初始导入超时"
            time.sleep(0.1)
        yield c
    asyncio.run(reset())  # 其他测试的 api-server 启动时按 site.yaml 重新初始导入


def stored(config: ApiConfig, camera_id: str) -> dict[str, Any]:
    async def query() -> dict[str, Any]:
        async with transaction(config) as conn:
            row = await conn.execute(
                select(cameras.cameras).where(cameras.cameras.c.id == camera_id)
            )
            return dict(row.mappings().one())

    return asyncio.run(query())


def audits(config: ApiConfig, action: str) -> list[dict[str, Any]]:
    async def query() -> list[dict[str, Any]]:
        async with transaction(config) as conn:
            rows = await conn.execute(select(audit_log).where(audit_log.c.action == action))
            return [dict(r) for r in rows.mappings()]

    return asyncio.run(query())


def test_seeded_from_site_yaml(client: TestClient) -> None:
    items = client.get("/api/cameras").json()["items"]
    assert [(c["id"], c["name"], c["ingest"], c["source"]["host"]) for c in items] == [
        ("cam-01", "演示画面 1", "pull", "mediamtx"),
        ("cam-02", "演示画面 2", "pull", "mediamtx"),
    ]
    assert not any(c["password_set"] for c in items)


def test_create_password_write_only_and_audited(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], key_file: Path
) -> None:
    r = client.post("/api/cameras", json=GATE, headers=headers())
    assert r.status_code == 201, r.text
    camera = r.json()
    assert camera["id"] == "cam-03" and camera["password_set"] is True
    assert "password" not in camera and GATE["password"] not in r.text

    row = stored(db[1], "cam-03")
    assert unseal(key_file, row["password_enc"]) == GATE["password"]
    [audit] = audits(db[1], "camera.created")
    assert audit["after"]["password_set"] is True
    assert GATE["password"] not in str(audit)

    site = client.get("/api/site").json()
    [device] = [d for d in site["devices"] if d["id"] == "cam-03"]
    assert (device["name"], device["state"], device["camera"]["mapping"]) == (
        "大门口",
        "normal",
        "estimated",
    )


@pytest.mark.parametrize(
    ("change", "status"),
    [
        ({"source": None}, 400),  # 拉流须有地址
        ({"climb_lines": [[100, 50, 100, 300]]}, 400),  # 竖直警戒线
        ({"source": GATE["source"] | {"path": "/live#video=copy"}}, 400),  # go2rtc 参数
        ({"source": GATE["source"] | {"host": "exec:rm -rf /"}}, 400),
        ({"source": GATE["source"] | {"protocol": "exec"}}, 400),
        ({"source": GATE["source"] | {"host": "127.0.0.1", "port": 1984}}, 400),  # go2rtc 自身
        ({"source": GATE["source"] | {"host": "localhost"}}, 400),
        ({"source": GATE["source"] | {"host": "GO2RTC"}}, 400),
        ({"source": GATE["source"] | {"host": "[::1]"}}, 400),
        ({"source": GATE["source"] | {"host": "0.0.0.0"}}, 400),
        ({"pose": POSE | {"pitch_deg": 10}}, 400),
        ({"ip": "172.30.0.11"}, 409),  # 与 cam-01 重复
    ],
)
def test_create_rejects(client: TestClient, change: dict[str, Any], status: int) -> None:
    r = client.post("/api/cameras", json=GATE | change, headers=headers())
    assert r.status_code == status, r.text


def test_update_keeps_or_clears_password_and_switches_to_push(
    client: TestClient, db: tuple[ApiConfig, ApiConfig]
) -> None:
    client.post("/api/cameras", json=GATE, headers=headers())
    r = client.patch("/api/cameras/cam-03", json={"name": "后门"}, headers=headers())
    assert r.status_code == 200 and r.json()["password_set"] is True

    r = client.patch("/api/cameras/cam-03", json={"clear_password": True}, headers=headers())
    assert r.json()["password_set"] is False

    r = client.patch("/api/cameras/cam-03", json={"ingest": "push"}, headers=headers())
    assert (r.json()["ingest"], r.json()["source"]) == ("push", None)
    assert stored(db[1], "cam-03")["host"] is None
    assert len(audits(db[1], "camera.updated")) == 3


def test_ids_are_never_reused(client: TestClient) -> None:
    """D-108：删除后新增的摄像头取下一个未用过的编号，含初始导入的编号。"""
    assert client.post("/api/cameras", json=GATE, headers=headers()).json()["id"] == "cam-03"
    for camera_id in ("cam-03", "cam-02"):
        assert client.delete(f"/api/cameras/{camera_id}", headers=headers()).status_code == 204
    r = client.post("/api/cameras", json=GATE, headers=headers())
    assert r.status_code == 201 and r.json()["id"] == "cam-04"


def test_delete_and_roles(client: TestClient, password: str) -> None:
    assert client.delete("/api/cameras/cam-02", headers=headers()).status_code == 204
    assert [d["id"] for d in client.get("/api/site").json()["devices"]] == ["cam-01"]
    assert client.delete("/api/cameras/cam-02", headers=headers()).status_code == 404

    login(client, "viewer", password)
    assert client.get("/api/cameras").status_code == 403
    assert client.post("/api/cameras", json=GATE, headers=headers()).status_code == 403


def row(**over: Any) -> dict[str, Any]:
    return {"ingest": "pull", "protocol": "rtsp", "host": "192.168.8.31", "port": 554,
            "path": "/Streaming/Channels/101", "username": None} | over  # fmt: skip


@pytest.mark.parametrize(
    ("values", "password", "url"),
    [
        (row(), None, "rtsp://192.168.8.31:554/Streaming/Channels/101"),
        (
            row(username="ad min"),
            "p@ss/1",
            "rtsp://ad%20min:p%40ss%2F1@192.168.8.31:554/Streaming/Channels/101",
        ),
        (row(protocol="onvif", port=80, username="admin"), "x", "onvif://admin:x@192.168.8.31:80"),
        (
            row(host="fe80::1", protocol="http", port=80, path="video.mjpg"),
            None,
            "http://[fe80::1]:80/video.mjpg",
        ),
        (row(ingest="push", protocol=None, host=None, port=None, path=None), None, None),
    ],
)
def test_source_url(values: dict[str, Any], password: str | None, url: str | None) -> None:
    assert cameras.source_url(values, password) == url


class FakeGo2rtc:
    """go2rtc 的流接口：记下增删调用。"""

    def __init__(self, streams: dict[str, list[str]]) -> None:
        self.streams = streams
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def get(self, path: str, **_: Any) -> Any:
        body = {n: {"producers": [{"url": u} for u in urls]} for n, urls in self.streams.items()}
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: body)

    async def delete(self, path: str, params: dict[str, str]) -> Any:
        self.calls.append(("delete", params))
        self.streams.pop(params["src"])
        return SimpleNamespace(raise_for_status=lambda: None)

    async def put(self, path: str, params: dict[str, str]) -> Any:
        self.calls.append(("put", params))
        self.streams[params["name"]] = [params["src"]]
        return SimpleNamespace(raise_for_status=lambda: None)


def test_sync_go2rtc_adds_replaces_and_removes(tmp_path: Path, key_file: Path) -> None:
    site_file = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
    go2rtc = FakeGo2rtc(
        {"cam-01": ["rtsp://mediamtx:8554/cam-01"], "cam-02": ["rtsp://old"], "x": []}
    )
    state = SimpleNamespace(
        config=SimpleNamespace(site_file=site_file, device_key_file=key_file), go2rtc=go2rtc
    )
    rows = [
        {"id": "cam-01", "password_enc": None} | row(host="mediamtx", port=8554, path="cam-01"),
        {"id": "cam-02", "password_enc": None} | row(host="mediamtx", port=8554, path="cam-02"),
        {"id": "cam-03", "password_enc": None}
        | row(ingest="push", protocol=None, host=None, port=None, path=None),
    ]
    asyncio.run(cameras.Registry(state)._sync_go2rtc(rows))
    assert go2rtc.calls == [
        ("delete", {"src": "x"}),
        ("delete", {"src": "cam-02"}),
        ("put", {"name": "cam-02", "src": "rtsp://mediamtx:8554/cam-02"}),
    ]


def test_sync_compares_masked_credentials(key_file: Path) -> None:
    """go2rtc 把地址中的凭据显示为 ***：带口令的流不应每次比对都被删了重加。"""
    site_file = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
    go2rtc = FakeGo2rtc({"cam-03": ["rtsp://***@192.168.8.31:554/Streaming/Channels/101"]})
    config = SimpleNamespace(site_file=site_file, device_key_file=key_file)
    state = SimpleNamespace(config=config, go2rtc=go2rtc)
    blob = cameras.seal(key_file, "pw")
    rows = [{"id": "cam-03", "password_enc": blob} | row(username="admin")]
    asyncio.run(cameras.Registry(state)._sync_go2rtc(rows))
    assert go2rtc.calls == []


def test_registry_event_has_no_credentials() -> None:
    event = cameras.registry(
        [{"id": "cam-03", "name": "大门口", "ip": "192.168.8.31", "pose": POSE, "calibration": [],
          "climb_lines": [], "username": "admin", "password_enc": b"x", "host": "192.168.8.31"}]
    )  # fmt: skip
    dumped = event.model_dump(mode="json")
    assert set(dumped["cameras"][0]) == {"id", "name", "ip", "pose", "calibration", "climb_lines"}


class FakeSite:
    devices: list[Any] = ["变化前"]

    def model_copy(self, update: dict[str, Any]) -> "FakeSite":
        return self

    def model_dump(self, mode: str) -> dict[str, Any]:
        return {}


def test_apply_failure_does_not_raise_and_retries(key_file: Path) -> None:
    """下发失败（如总线不可达）不让接口报保存失败；标记待重试，下次成功后清除。"""
    site_file = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
    published: list[object] = []
    fail = [True]

    async def js_publish(subject: str, event: object) -> None:
        if fail.pop(0) if fail else False:
            raise TimeoutError("nats")
        published.append(event)

    async def load() -> list[Any]:
        return []

    state = SimpleNamespace(
        config=SimpleNamespace(site_file=site_file, device_key_file=key_file),
        go2rtc=FakeGo2rtc({}),
        bus=SimpleNamespace(js_publish=js_publish),
        hub=SimpleNamespace(broadcast=lambda _: None),
        devices=SimpleNamespace(sync=lambda *_: None),
        site=FakeSite(),
    )
    registry = cameras.Registry(state)
    registry._load = load  # type: ignore[method-assign]

    async def twice() -> list[bool]:
        pending = []
        for _ in range(2):
            await registry.apply()
            pending.append(registry._pending)
        return pending

    assert asyncio.run(twice()) == [True, False]
    assert len(published) == 1


def test_concurrent_creates_get_distinct_ids(client: TestClient) -> None:
    """并发新增串行化：不会分到同一编号而被误报为 IP 重复。"""
    from concurrent.futures import ThreadPoolExecutor

    def create(n: int) -> int:
        body = GATE | {"name": f"并发 {n}", "ip": f"192.168.8.{40 + n}"}
        return client.post("/api/cameras", json=body, headers=headers()).status_code

    with ThreadPoolExecutor(4) as pool:
        assert sorted(pool.map(create, range(4))) == [201, 201, 201, 201]
    ids = [c["id"] for c in client.get("/api/cameras").json()["items"]]
    assert len(ids) == len(set(ids)) == 6


class FrameGo2rtc(FakeGo2rtc):
    """取一帧时返回给定的响应或抛出给定的异常；流接口同 FakeGo2rtc。"""

    def __init__(self, frame: httpx2.Response | Exception) -> None:
        super().__init__({})
        self.frame = frame

    async def get(self, path: str, **kw: Any) -> Any:
        if path != "/api/frame.jpeg":
            return await super().get(path, **kw)
        if isinstance(self.frame, Exception):
            raise self.frame
        return self.frame


@pytest.mark.parametrize(
    ("frame", "status", "detail"),
    [
        (httpx2.Response(200, content=b"\xff\xd8jpeg"), 200, None),
        (httpx2.ReadTimeout("slow"), 502, "取画面超时"),
        (httpx2.ConnectError("down"), 502, "视频服务不可用"),
        (httpx2.Response(404), 502, "视频服务中没有这路流"),
        (httpx2.Response(500), 502, "取不到画面"),
        (httpx2.Response(200, content=b""), 502, "取不到画面"),
    ],
)
def test_snapshot(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    frame: httpx2.Response | Exception,
    status: int,
    detail: str | None,
) -> None:
    """V-CAM4：取一帧只返回给管理员浏览器、不缓存；超时、视频服务不可用、无此流、空画面各有提示。"""
    monkeypatch.setattr(cast(Any, client.app).state, "go2rtc", FrameGo2rtc(frame))
    r = client.get("/api/cameras/cam-01/snapshot", headers=headers())
    assert r.status_code == status, r.text
    if detail is None:
        assert r.content == b"\xff\xd8jpeg"
        assert (r.headers["content-type"], r.headers["cache-control"]) == ("image/jpeg", "no-store")
    else:
        assert detail in r.text


def test_snapshot_unknown_camera_and_viewer(client: TestClient, password: str) -> None:
    assert client.get("/api/cameras/cam-99/snapshot", headers=headers()).status_code == 404
    login(client, "viewer", password)
    assert client.get("/api/cameras/cam-01/snapshot", headers=headers()).status_code == 403
