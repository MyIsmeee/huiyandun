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
