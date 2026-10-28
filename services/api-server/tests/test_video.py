"""POST /api/devices/{id}/webrtc：经 api-server 鉴权后把 SDP 转发给 go2rtc（FR-106、D-02）。"""

from collections.abc import Callable, Iterator

import httpx2
import pytest
from fastapi.testclient import TestClient

from api_server.app import create_app
from api_server.config import ApiConfig

OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n"
ANSWER = "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\n"
HEADERS = {"X-Request-ID": "r", "Content-Type": "application/sdp"}

type Handler = Callable[[httpx2.Request], httpx2.Response]


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        c.post(
            "/api/auth/login",
            json={"username": "viewer", "password": password},
            headers={"X-Request-ID": "r"},
        )
        yield c


def go2rtc(client: TestClient, handler: Handler) -> list[httpx2.Request]:
    """以假 go2rtc 替换真实连接，返回其收到的请求。"""
    seen: list[httpx2.Request] = []

    def record(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return handler(request)

    state = client.app.state
    state.go2rtc = httpx2.AsyncClient(
        base_url=state.config.go2rtc_url, transport=httpx2.MockTransport(record)
    )
    return seen


def test_forwards_offer_to_camera_stream(client: TestClient) -> None:
    seen = go2rtc(client, lambda _: httpx2.Response(201, text=ANSWER))

    res = client.post("/api/devices/cam-01/webrtc", content=OFFER, headers=HEADERS)

    assert res.status_code == 200
    assert res.text == ANSWER
    assert res.headers["content-type"] == "application/sdp"
    [request] = seen
    assert request.url.path == "/api/webrtc"
    assert request.url.params["src"] == "cam-01"  # demo/scenarios/site.yaml 中 cam-01 的 stream
    assert request.content.decode() == OFFER


def test_unknown_device_is_not_found(client: TestClient) -> None:
    seen = go2rtc(client, lambda _: httpx2.Response(201, text=ANSWER))

    res = client.post("/api/devices/cam-99/webrtc", content=OFFER, headers=HEADERS)

    assert res.status_code == 404
    assert seen == []


@pytest.mark.parametrize("body", ["", "not an sdp"])
def test_invalid_offer_is_rejected(client: TestClient, body: str) -> None:
    seen = go2rtc(client, lambda _: httpx2.Response(201, text=ANSWER))

    res = client.post("/api/devices/cam-01/webrtc", content=body, headers=HEADERS)

    assert res.status_code == 400
    assert seen == []


def timeout(request: httpx2.Request) -> httpx2.Response:
    raise httpx2.ReadTimeout("timed out", request=request)


def refused(request: httpx2.Request) -> httpx2.Response:
    raise httpx2.ConnectError("refused", request=request)


@pytest.mark.parametrize(
    "handler",
    [timeout, refused, lambda _: httpx2.Response(500, text="stream not found")],
    ids=["timeout", "refused", "error"],
)
def test_go2rtc_failure_is_bad_gateway(client: TestClient, handler: Handler) -> None:
    go2rtc(client, handler)

    res = client.post("/api/devices/cam-01/webrtc", content=OFFER, headers=HEADERS)

    assert res.status_code == 502
    assert res.json()["code"] == "bad_gateway"


def test_requires_login(db: tuple[ApiConfig, ApiConfig]) -> None:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        res = c.post("/api/devices/cam-01/webrtc", content=OFFER, headers=HEADERS)

    assert res.status_code == 401
