"""摄像头登记表（FR-905～FR-907、D-101、D-103、TK-125）：初始导入、增删改、口令只写不读、审计、
取流地址拼接、go2rtc 同步与登记表下发。"""

import asyncio
import base64
import os
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import httpx2
import nats
import pytest
import yaml
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import delete, select, text, update

from api_server import cameras, scene
from api_server.app import create_app
from api_server.audit import audit_log
from api_server.config import ApiConfig
from api_server.db import transaction
from api_server.llm import unseal
from py_contracts.events.hyd_vision_calibration_reply_v1_schema import VisionCalibrationReplyV1
from py_contracts.events.hyd_vision_calibration_request_v1_schema import (
    VisionCalibrationRequestV1,
)

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
    push = key_file.parent / "push_password"
    push.write_text("push-secret\n")
    config = db[1].model_copy(update={"device_key_file": key_file, "push_password_file": push})
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
        ({"source": GATE["source"] | {"host": "ingest"}}, 400),
        (
            {"source": GATE["source"] | {"host": "172.30.10.10"}},
            400,
        ),  # ingest 的固定地址：中继拉自己
        ({"source": GATE["source"] | {"host": "[::ffff:172.30.11.2]"}}, 400),  # go2rtc 的固定地址
        (
            {"source": GATE["source"] | {"protocol": "http", "relay": True}},
            400,
        ),  # 兼容模式只支持 RTSP、RTMP
        ({"source": GATE["source"] | {"host": "[::1]"}}, 400),
        ({"source": GATE["source"] | {"host": "[::ffff:127.0.0.1]"}}, 400),
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
    # 改为推流时给出一次推流口令（V-CAM2），列表中不含
    assert r.json()["push_password"] == "push-secret"
    listed = {c["id"]: c for c in client.get("/api/cameras").json()["items"]}
    assert listed["cam-03"].get("push_password") is None
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


def test_self_addresses_match_compose() -> None:
    """go2rtc 与 ingest 在 compose.yaml 中的全部固定地址都不能作为拉流来源（中继回环）。"""
    compose = Path(__file__).resolve().parents[3] / "deploy/compose/compose.yaml"
    services = yaml.safe_load(compose.read_text(encoding="utf-8"))["services"]
    fixed = {
        net["ipv4_address"]
        for name in ("go2rtc", "ingest")
        for net in services[name]["networks"].values()
        if net and "ipv4_address" in net
    }
    assert fixed == cameras.SELF_ADDRESSES


def row(**over: Any) -> dict[str, Any]:
    return {"ingest": "pull", "protocol": "rtsp", "host": "192.168.8.31", "port": 554,
            "path": "/Streaming/Channels/101", "username": None, "relay": False} | over  # fmt: skip


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
        # 推流：go2rtc 从 ingest 按编号取（D-103）
        (
            {"id": "cam-05"} | row(ingest="push", protocol=None, host=None, port=None, path=None),
            None,
            "rtsp://172.30.10.10:8554/cam-05",
        ),
    ],
)
def test_source_url(values: dict[str, Any], password: str | None, url: str) -> None:
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
        ("put", {"name": "cam-03", "src": "rtsp://172.30.10.10:8554/cam-03"}),
    ]


class FakeIngest:
    """MediaMTX 的路径配置接口：记下增删改调用；列表中另有推流用的正则路径，不应被动到。"""

    def __init__(self, paths: dict[str, str]) -> None:
        self.paths = paths
        self.calls: list[tuple[str, str, Any]] = []

    async def get(self, path: str, **_: Any) -> Any:
        items = [{"name": "~^cam-[0-9]+$", "source": "publisher"}]
        items += [{"name": n, "source": s} for n, s in self.paths.items()]
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"items": items})

    async def delete(self, path: str, **_: Any) -> Any:
        self.calls.append(("delete", path, None))
        self.paths.pop(path.rsplit("/", 1)[1])
        return SimpleNamespace(raise_for_status=lambda: None)

    async def request(self, method: str, path: str, json: dict[str, Any]) -> Any:
        self.calls.append((method, path, json))
        self.paths[path.rsplit("/", 1)[1]] = json["source"]
        return SimpleNamespace(raise_for_status=lambda: None)


def test_relay_camera_is_pulled_through_ingest(key_file: Path) -> None:
    """D-117：兼容模式的摄像头由 ingest 中继拉流，go2rtc 从 ingest 取；关闭后中继路径删除，推流的正则路径不动。"""
    site_file = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
    config = SimpleNamespace(site_file=site_file, device_key_file=key_file)
    ingest = FakeIngest({"cam-07": "rtsp://old", "cam-08": "rtsp://stale"})
    state = SimpleNamespace(config=config, ingest=ingest)
    blob = cameras.seal(key_file, "pw")
    relay = {"id": "cam-07", "password_enc": blob} | row(username="admin", relay=True)
    plain = {"id": "cam-09", "password_enc": None} | row(host="192.168.8.32")
    camera = "rtsp://admin:pw@192.168.8.31:554/Streaming/Channels/101"

    assert cameras.source_url(relay, "pw") == "rtsp://172.30.10.10:8554/cam-07"
    asyncio.run(cameras.Registry(state)._sync_ingest([relay, plain]))
    conf = {"source": camera, "sourceOnDemand": False, "rtspTransport": "tcp"}
    assert ingest.calls == [
        ("delete", "/v3/config/paths/delete/cam-08", None),
        ("PATCH", "/v3/config/paths/patch/cam-07", conf),
    ]
    ingest.calls.clear()
    asyncio.run(cameras.Registry(state)._sync_ingest([relay, plain]))
    assert ingest.calls == []  # 未变化不重复下发

    asyncio.run(cameras.Registry(state)._sync_ingest([relay | {"relay": False}]))
    assert ingest.calls == [("delete", "/v3/config/paths/delete/cam-07", None)]
    assert ingest.paths == {}


def test_create_relay_camera_round_trip(client: TestClient) -> None:
    """兼容模式随拉流地址保存并返回；默认关闭。"""
    body = GATE | {"source": GATE["source"] | {"relay": True}}
    created = client.post("/api/cameras", json=body, headers=headers())
    assert created.status_code == 201, created.text
    assert created.json()["source"]["relay"] is True
    other = client.post("/api/cameras", json=GATE | {"ip": "192.168.8.40"}, headers=headers())
    assert other.json()["source"]["relay"] is False


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
    areas: list[Any] = []

    def model_copy(self, update: dict[str, Any]) -> "FakeSite":
        return self

    def model_dump(self, mode: str) -> dict[str, Any]:
        return {}


async def no_areas() -> list[Any]:
    return []


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
        ingest=FakeIngest({}),
        bus=SimpleNamespace(js_publish=js_publish),
        hub=SimpleNamespace(broadcast=lambda _: None),
        devices=SimpleNamespace(sync=lambda *_: None),
        site=FakeSite(),
    )
    registry = cameras.Registry(state)
    registry._load = load  # type: ignore[method-assign]
    registry._areas = no_areas  # type: ignore[method-assign]

    async def twice() -> list[bool]:
        pending = []
        for _ in range(2):
            await registry.apply()
            pending.append(registry._pending)
        return pending

    assert asyncio.run(twice()) == [True, False]
    assert len(published) == 1


class DownIngest(FakeIngest):
    """ingest 不可达：任何请求都连不上。"""

    async def get(self, path: str, **_: Any) -> Any:
        raise httpx2.ConnectError("ingest")


def test_ingest_down_does_not_block_go2rtc(key_file: Path) -> None:
    """D-117：ingest 不可达时，下发与定期比对照常同步 go2rtc、发布登记表；中继路径待其恢复后补齐。"""
    site_file = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
    published: list[object] = []

    async def js_publish(subject: str, event: object) -> None:
        published.append(event)

    camera = {"id": "cam-01", "name": "东门", "ip": "172.30.0.11", "pose": POSE, "calibration": [],
              "climb_lines": [], "password_enc": None, "area_id": None}  # fmt: skip
    rows = [camera | row(host="mediamtx", port=8554, path="cam-01")]

    async def load() -> list[Any]:
        return rows

    go2rtc = FakeGo2rtc({})
    state = SimpleNamespace(
        config=SimpleNamespace(site_file=site_file, device_key_file=key_file),
        go2rtc=go2rtc,
        ingest=DownIngest({}),
        bus=SimpleNamespace(js_publish=js_publish),
        hub=SimpleNamespace(broadcast=lambda _: None),
        devices=SimpleNamespace(sync=lambda *_: None),
        site=FakeSite(),
    )
    registry = cameras.Registry(state)
    registry._load = load  # type: ignore[method-assign]
    registry._areas = no_areas  # type: ignore[method-assign]
    put = ("put", {"name": "cam-01", "src": "rtsp://mediamtx:8554/cam-01"})

    asyncio.run(registry.apply())
    assert (go2rtc.calls, len(published), registry._pending) == ([put], 1, False)

    go2rtc.streams.clear()  # go2rtc 重启丢掉了动态添加的流
    go2rtc.calls.clear()
    asyncio.run(registry.reconcile())
    assert go2rtc.calls == [put]


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
        (
            httpx2.Response(500, content=b"streams: codecs not matched:  => video:JPEG"),
            502,
            "兼容模式",
        ),
    ],
)
def test_snapshot(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    frame: httpx2.Response | Exception,
    status: int,
    detail: str | None,
) -> None:
    """V-CAM4：取一帧只返回给浏览器、不缓存；超时、视频服务不可用、无此流、空画面各有提示。"""
    monkeypatch.setattr(cast(Any, client.app).state, "go2rtc", FrameGo2rtc(frame))
    r = client.get("/api/cameras/cam-01/snapshot", headers=headers())
    assert r.status_code == status, r.text
    if detail is None:
        assert r.content == b"\xff\xd8jpeg"
        assert (r.headers["content-type"], r.headers["cache-control"]) == ("image/jpeg", "no-store")
    else:
        assert detail in r.text


def test_snapshot_unknown_camera_and_viewer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, password: str
) -> None:
    """D-115：摄像头栏缩略图对所有角色可见，viewer 也能取帧；未登录仍被拒。"""
    assert client.get("/api/cameras/cam-99/snapshot", headers=headers()).status_code == 404
    monkeypatch.setattr(
        cast(Any, client.app).state,
        "go2rtc",
        FrameGo2rtc(httpx2.Response(200, content=b"\xff\xd8jpeg")),
    )
    login(client, "viewer", password)
    assert client.get("/api/cameras/cam-01/snapshot", headers=headers()).status_code == 200
    client.cookies.clear()
    assert client.get("/api/cameras/cam-01/snapshot", headers=headers()).status_code == 401


# 标定（FR-910、D-132、D-134）：拟合由 vision-engine 应答，此处以假应答代替
CALIBRATION = [[100, 900, 1, 1], [1800, 900, 9, 1], [300, 500, 2, 8], [1600, 500, 8, 8]]
CALIBRATION += [[900, 700, 5, 4], [500, 800, 3, 2]]


@pytest.fixture
def area(client: TestClient, db: tuple[ApiConfig, ApiConfig]) -> Iterator[str]:
    """新建 10×10 m 的区域并放入 cam-01；用后删除，不影响其他用例。"""
    created = client.post(
        "/api/scene/areas", json={"name": "标定", "width_m": 10, "depth_m": 10}, headers=headers()
    ).json()
    body = {k: created[k] for k in ("name", "width_m", "depth_m", "items", "updated_at")}
    body["cameras"] = [{"id": "cam-01", "x": 5, "y": 0, "yaw_deg": 90}]
    r = client.put(f"/api/scene/areas/{created['id']}", json=body, headers=headers())
    assert r.status_code == 200, r.text
    yield created["id"]

    async def remove() -> None:
        async with transaction(db[1]) as conn:
            await conn.execute(
                update(cameras.cameras)
                .where(cameras.cameras.c.area_id == created["id"])
                .values(area_id=None)
            )
            await conn.execute(
                delete(scene.scene_areas).where(scene.scene_areas.c.id == created["id"])
            )

    asyncio.run(remove())


def fit_reply(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, outcome: float | str | Exception = 0.21
) -> list[VisionCalibrationRequestV1]:
    """outcome 为误差时拟合成功，各组偏差相同；为字符串时是失败原因；为异常时视为未应答。"""
    asked: list[VisionCalibrationRequestV1] = []

    async def request(
        subject: str,
        event: VisionCalibrationRequestV1,
        model: type[VisionCalibrationReplyV1],
        timeout_s: float,
    ) -> VisionCalibrationReplyV1:
        assert subject == "hyd.vision.calibration_request.v1"
        asked.append(event)
        if isinstance(outcome, Exception):
            raise outcome
        stamp = {"schema_version": "1.0.0", "event_id": uuid.uuid4(), "ts": datetime.now(UTC)}
        if isinstance(outcome, str):
            reply = {"reason": outcome, "reproj_error_m": None, "residuals_m": None}
        else:
            residuals = [outcome] * len(event.points)
            reply = {"reason": None, "reproj_error_m": outcome, "residuals_m": residuals}
        return model.model_validate(stamp | reply)

    monkeypatch.setattr(cast(Any, client.app).state.bus, "request", request)
    return asked


def calibrate(
    client: TestClient, area_id: str, points: list[list[float]], check: bool = False
) -> Any:
    body = {"area_id": area_id, "points": points}
    if check:
        return client.post("/api/cameras/cam-01/calibration/check", json=body, headers=headers())
    return client.put("/api/cameras/cam-01/calibration", json=body, headers=headers())


def audited(config: ApiConfig, action: str, r: Any) -> list[dict[str, Any]]:
    """审计表只增不删，按本次请求的请求 ID 取。"""
    request_id = r.request.headers["X-Request-ID"]
    return [a for a in audits(config, action) if a["request_id"] == request_id]


def site_camera(client: TestClient, camera_id: str) -> dict[str, Any]:
    [device] = [d for d in client.get("/api/site").json()["devices"] if d["id"] == camera_id]
    return device["camera"]


def test_calibration_check_does_not_save(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], area: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A5：只拟合、不保存，不写审计。"""
    asked = fit_reply(client, monkeypatch, 0.21)

    r = calibrate(client, area, CALIBRATION, check=True)

    assert r.status_code == 200, r.text
    assert r.json() == {"reproj_error_m": 0.21, "residuals_m": [0.21] * 6}
    assert [(a.camera_id, [p.root for p in a.points]) for a in asked] == [("cam-01", CALIBRATION)]
    assert stored(db[1], "cam-01")["calibration"] == []
    assert audited(db[1], "camera.calibrated", r) == []


def test_calibration_saved(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], area: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A6：保存点与误差、写审计、下发登记表，设备按标定映射。"""
    fit_reply(client, monkeypatch, 0.21)
    state = cast(Any, client.app).state
    published: list[Any] = []
    js_publish = state.bus.js_publish

    async def capture(subject: str, event: Any) -> None:
        published.append(event)
        await js_publish(subject, event)

    monkeypatch.setattr(state.bus, "js_publish", capture)

    r = calibrate(client, area, CALIBRATION)

    assert r.status_code == 200, r.text
    assert (r.json()["calibration"], r.json()["calibration_error_m"]) == (CALIBRATION, 0.21)
    row = stored(db[1], "cam-01")
    assert (row["calibration"], row["calibration_error_m"]) == (CALIBRATION, 0.21)
    [audit] = audited(db[1], "camera.calibrated", r)
    assert audit["before"] == {"points": [], "error_m": None}
    assert audit["after"] == {"points": CALIBRATION, "error_m": 0.21}
    [cam] = [c for c in published[-1].model_dump(mode="json")["cameras"] if c["id"] == "cam-01"]
    assert cam["calibration"] == CALIBRATION
    camera = site_camera(client, "cam-01")
    assert (camera["mapping"], camera["reproj_error_m"]) == ("calibrated", 0.21)


@pytest.mark.parametrize(
    ("points", "area_id", "status", "message"),
    [
        (CALIBRATION[:3], None, 400, "至少需要 4 组点"),
        (CALIBRATION[:4] + [[900, 700, 10.5, 4]], None, 400, "第 5 组"),
        (CALIBRATION[:4] + [[-1, 700, 5, 4]], None, 400, "第 5 组"),
        (CALIBRATION, "area-99", 409, "摄像头已换区域，请关闭后重新标定"),
    ],
)
def test_calibration_rejected(
    client: TestClient,
    db: tuple[ApiConfig, ApiConfig],
    area: str,
    monkeypatch: pytest.MonkeyPatch,
    points: list[list[float]],
    area_id: str | None,
    status: int,
    message: str,
) -> None:
    """A7：点数不足、越界、区域不一致时拒绝，不请求拟合、库中不变。"""
    asked = fit_reply(client, monkeypatch)

    for check in (True, False):
        r = calibrate(client, area_id or area, points, check)
        assert r.status_code == status, r.text
        assert message in r.json()["message"]
    assert asked == []
    assert stored(db[1], "cam-01")["calibration"] == []


def test_calibration_rejected_outside_area(
    client: TestClient, area: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A7：摄像头未放入区域时 409；不存在时 404。"""
    fit_reply(client, monkeypatch)
    unplaced = client.post("/api/cameras", json=GATE, headers=headers()).json()["id"]
    body = {"area_id": area, "points": CALIBRATION}
    for camera_id, status in ((unplaced, 409), ("cam-99", 404)):
        r = client.put(f"/api/cameras/{camera_id}/calibration", json=body, headers=headers())
        assert r.status_code == status, r.text


@pytest.mark.parametrize(
    ("reason", "message"),
    [
        ("pixels_collinear", "画面上的点至少要有 4 个不在同一直线上"),
        ("ground_collinear", "地面上的点至少要有 4 个不在同一直线上"),
        ("inconsistent", "这些点对不上"),
    ],
)
def test_calibration_fit_failure_explained(
    client: TestClient,
    db: tuple[ApiConfig, ApiConfig],
    area: str,
    monkeypatch: pytest.MonkeyPatch,
    reason: str,
    message: str,
) -> None:
    fit_reply(client, monkeypatch, reason)

    for check in (True, False):
        r = calibrate(client, area, CALIBRATION, check)
        assert r.status_code == 400, r.text
        assert message in r.json()["message"]
    assert stored(db[1], "cam-01")["calibration"] == []


def invalid_fit() -> ValidationError:
    with pytest.raises(ValidationError) as caught:
        VisionCalibrationReplyV1.model_validate({})
    return caught.value


@pytest.mark.parametrize("error", [nats.errors.NoRespondersError(), TimeoutError(), invalid_fit()])
def test_calibration_vision_unavailable(
    client: TestClient,
    db: tuple[ApiConfig, ApiConfig],
    area: str,
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
) -> None:
    """A8：视觉引擎不应答或应答不合契约时 503，库中不变。"""
    fit_reply(client, monkeypatch, error)

    for check in (True, False):
        r = calibrate(client, area, CALIBRATION, check)
        assert r.status_code == 503, r.text
        assert r.json()["message"] == "识别服务未响应，请稍后重试"
    assert stored(db[1], "cam-01")["calibration"] == []


def test_calibration_requires_admin(client: TestClient, area: str, password: str) -> None:
    """A9。"""
    for role in ("viewer", "operator"):
        login(client, role, password)
        for check in (True, False):
            assert calibrate(client, area, CALIBRATION, check).status_code == 403


def test_calibration_cleared(
    client: TestClient, db: tuple[ApiConfig, ApiConfig], area: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A10：空 points 清除标定，不请求拟合，回到按安装参数估算。"""
    asked = fit_reply(client, monkeypatch, 0.21)
    assert calibrate(client, area, CALIBRATION).status_code == 200

    r = calibrate(client, area, [])

    assert r.status_code == 200, r.text
    assert (r.json()["calibration"], r.json()["calibration_error_m"]) == ([], None)
    assert len(asked) == 1
    [audit] = audited(db[1], "camera.calibrated", r)
    assert audit["after"] == {"points": [], "error_m": None}
    camera = site_camera(client, "cam-01")
    assert (camera["mapping"], camera["reproj_error_m"]) == ("estimated", None)


def test_pose_change_keeps_calibration(
    client: TestClient, area: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A12：摄像头页改俯角、朝向不清除标定（D-134）。"""
    fit_reply(client, monkeypatch, 0.21)
    assert calibrate(client, area, CALIBRATION).status_code == 200

    pose = POSE | {"x": 5, "y": 0, "pitch_deg": -45, "yaw_deg": 120}
    r = client.patch("/api/cameras/cam-01", json={"pose": pose}, headers=headers())

    assert r.status_code == 200, r.text
    assert (r.json()["calibration"], r.json()["calibration_error_m"]) == (CALIBRATION, 0.21)
