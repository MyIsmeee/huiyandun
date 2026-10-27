"""site.yaml 导入（FR-901～FR-903）与 GET /api/site。"""

import copy
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

from api_server import site
from api_server.app import create_app
from api_server.config import ApiConfig
from py_contracts.api import Site

DEMO_SITE = Path(__file__).resolve().parents[3] / "demo/scenarios/site.yaml"
VALID: dict[str, Any] = yaml.safe_load(DEMO_SITE.read_text(encoding="utf-8"))


def write(tmp_path: Path, data: Any) -> Path:
    path = tmp_path / "site.yaml"
    path.write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    return path


def edited(edit: Any) -> dict[str, Any]:
    data = copy.deepcopy(VALID)
    edit(data)
    return data


def test_demo_site_is_valid() -> None:
    result = site.load(DEMO_SITE)

    assert {d.id for d in result.devices} == {"cam-01", "cam-02"}


@pytest.mark.parametrize(
    ("edit", "path"),
    [
        (lambda d: d["site"].pop("width_m"), "site.width_m"),
        (lambda d: d["cameras"][0]["pose"].update(yaw_deg="东北"), "cameras.0.pose.yaw_deg"),
        (lambda d: d["zones"][0].update(no_clim=True), "zones.0.no_clim"),
        (lambda d: d["cameras"][1].update(id="cam-01"), "cameras.1.id"),
        (lambda d: d["zones"].append(d["zones"][0]), "zones.1.id"),
        (lambda d: d["cameras"][1].update(ip=d["cameras"][0]["ip"]), "cameras.1.ip"),
        (lambda d: d.update(whitelist=["172.30.0.1/28"]), "whitelist.0"),
        (lambda d: d["site"].update(mode="inline"), "site.mode"),
    ],
    ids=[
        "missing",
        "wrong-type",
        "unknown-field",
        "dup-camera",
        "dup-zone",
        "dup-ip",
        "bad-cidr",
        "mode",
    ],
)
def test_invalid_site_is_rejected_with_field_path(tmp_path: Path, edit: Any, path: str) -> None:
    with pytest.raises(site.SiteError) as exc:
        site.load(write(tmp_path, edited(edit)))

    assert any(e.startswith(f"{path}:") for e in exc.value.errors), exc.value.errors


def test_yaml_syntax_error_reports_line(tmp_path: Path) -> None:
    path = tmp_path / "site.yaml"
    path.write_text("site: {id: x\nwalls: []\n", encoding="utf-8")

    with pytest.raises(site.SiteError) as exc:
        site.load(path)

    assert "line" in str(exc.value)


@pytest.mark.parametrize(
    "content", [None, "site: 演示".encode("gbk")], ids=["missing-file", "not-utf8"]
)
def test_unreadable_file_is_rejected(tmp_path: Path, content: bytes | None) -> None:
    path = tmp_path / "site.yaml"
    if content is not None:
        path.write_bytes(content)

    with pytest.raises(site.SiteError):
        site.load(path)


@pytest.mark.parametrize(("points", "state"), [(3, "uncalibrated"), (4, "normal")])
def test_camera_with_fewer_than_four_points_is_uncalibrated(
    tmp_path: Path, points: int, state: str
) -> None:
    data = edited(
        lambda d: d["cameras"][0].update(calibration=d["cameras"][0]["calibration"][:points])
    )

    device = site.load(write(tmp_path, data)).devices[0]

    assert device.state == state
    assert device.camera is not None
    assert device.camera.homography is None


def test_device_mode_follows_site_mode(tmp_path: Path) -> None:
    result = site.load(write(tmp_path, edited(lambda d: d["site"].update(mode="bypass"))))

    assert {d.mode for d in result.devices} == {"bypass"}


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str) -> Iterator[TestClient]:
    with TestClient(create_app(db[1]), base_url="https://testserver") as c:
        yield c


def test_get_site_requires_login(client: TestClient) -> None:
    assert client.get("/api/site").status_code == 401


def test_viewer_gets_site(client: TestClient, password: str) -> None:
    body = {"username": "viewer", "password": password}
    client.post("/api/auth/login", json=body, headers={"X-Request-ID": "req-site"})

    r = client.get("/api/site")

    assert r.status_code == 200
    result = Site.model_validate(r.json())
    assert result.id == "demo-office"
    assert [w.root for w in result.walls] == VALID["walls"]
