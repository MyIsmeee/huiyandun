"""内部接口：api-server 经它导出证据包（FR-702，设计 080-evidence.md §3.3）。"""

import io
import json
import zipfile
from pathlib import Path

import httpx2
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from evidence_service.recording import Evidence
from evidence_service.service import create_app
from evidence_service.store import Chain, Entry


def test_package_is_served_as_zip_and_unknown_incident_is_404(tmp_path: Path) -> None:
    chain = Chain(tmp_path, Ed25519PrivateKey.generate())
    chain.append([Entry("incident", "inc-ev", {}, b'{"id":"inc-ev"}')])
    evidence = Evidence(chain, {}, httpx2.AsyncClient())

    with TestClient(create_app(evidence)) as client:
        res = client.get("/internal/incidents/inc-ev/package")
        missing = client.get("/internal/incidents/inc-x/package")

    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(io.BytesIO(res.content)) as z:
        assert json.loads(z.read("manifest.json"))["incident_id"] == "inc-ev"
    assert missing.status_code == 404


def test_clip_of_a_registered_camera_is_cut_from_recorder(tmp_path: Path) -> None:
    """控制台回放单条告警：按时段向 recorder 取 MP4；未登记、无录像为 404，时段过长为 400。"""
    seen: list[httpx2.Request] = []

    def recorder(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if request.url.params["path"] == "cam-09":
            return httpx2.Response(404)
        return httpx2.Response(200, content=b"mp4")

    client_ = httpx2.AsyncClient(
        base_url="http://recorder:9996", transport=httpx2.MockTransport(recorder)
    )
    evidence = Evidence(
        Chain(tmp_path, Ed25519PrivateKey.generate()),
        {"cam-05": "cam-05", "cam-09": "cam-09"},
        client_,
    )
    window = {"start": "2026-11-17T08:00:00+00:00", "end": "2026-11-17T08:00:20+00:00"}

    with TestClient(create_app(evidence)) as client:
        ok = client.get("/internal/clips/cam-05", params=window)
        empty = client.get("/internal/clips/cam-09", params=window)
        unknown = client.get("/internal/clips/cam-01", params=window)
        long = client.get(
            "/internal/clips/cam-05", params=window | {"end": "2026-11-17T08:05:00+00:00"}
        )

    assert (ok.status_code, ok.headers["content-type"], ok.content) == (200, "video/mp4", b"mp4")
    assert seen[0].url.params["duration"] == "20.0"
    assert seen[0].url.params["format"] == "mp4"
    assert (empty.status_code, unknown.status_code, long.status_code) == (404, 404, 400)
