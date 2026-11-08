"""site.yaml 导入（FR-901～FR-904）与 GET /api/site。"""

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
        (lambda d: d["cameras"][0].update(no_clim=True), "cameras.0.no_clim"),
        # 平面图墙体已由场景区域取代（D-124），旧字段明确拒绝而不是静默忽略
        (lambda d: d.update(walls=[[0, 0, 40, 0]]), "walls"),
        (lambda d: d["cameras"][1].update(id="cam-01"), "cameras.1.id"),
        (lambda d: d["cameras"][1].update(ip=d["cameras"][0]["ip"]), "cameras.1.ip"),
        (lambda d: d.update(whitelist=["172.30.0.1/28"]), "whitelist.0"),
        (lambda d: d["site"].update(mode="inline"), "site.mode"),
        # 竖直的警戒线无法区分线上与线下（FR-104）
        (
            lambda d: d["cameras"][1].update(climb_lines=[[600, 300, 600, 200]]),
            "cameras.1.climb_lines.0",
        ),
        (
            lambda d: d["cameras"][1].update(climb_lines=[[600, 300, 600, 300]]),
            "cameras.1.climb_lines.0",
        ),
    ],
    ids=[
        "missing",
        "wrong-type",
        "unknown-field",
        "removed-walls",
        "dup-camera",
        "dup-ip",
        "bad-cidr",
        "mode",
        "vertical-climb-line",
        "zero-length-climb-line",
    ],
)
def test_invalid_site_is_rejected_with_field_path(tmp_path: Path, edit: Any, path: str) -> None:
    with pytest.raises(site.SiteError) as exc:
        site.load(write(tmp_path, edited(edit)))

    assert any(e.startswith(f"{path}:") for e in exc.value.errors), exc.value.errors


def test_yaml_syntax_error_reports_line(tmp_path: Path) -> None:
    path = tmp_path / "site.yaml"
    path.write_text("site: {id: x\ncameras: []\n", encoding="utf-8")

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


@pytest.mark.parametrize(
    ("points", "mapping"), [(3, "estimated"), (0, "estimated"), (4, "calibrated")]
)
def test_camera_mapping_estimated_below_four_points(
    tmp_path: Path, points: int, mapping: str
) -> None:
    corners = [
        [312, 540, 4.0, 6.0],
        [980, 552, 9.5, 6.2],
        [450, 300, 5.1, 14.0],
        [870, 310, 10.2, 13.8],
    ]
    data = edited(lambda d: d["cameras"][0].update(calibration=corners[:points]))

    device = site.load(write(tmp_path, data)).devices[0]

    # 少于 4 组标定点时按安装参数估算地面映射，仍为正常态（D-102）
    assert device.state == "normal"
    assert device.camera is not None and device.camera.mapping == mapping
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
