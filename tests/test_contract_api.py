"""api-server 接口契约：接口清单、最低角色、写操作 X-Request-ID 与关键模型（HYD-PLAN-007 §3）。"""

from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

from py_contracts.api import Device, IncidentList, LoginResponse, Report, Site

SPEC = yaml.safe_load(
    (Path(__file__).resolve().parents[1] / "contracts/openapi/api-server.v1.yaml").read_text()
)
WRITE_METHODS = {"post", "put", "patch", "delete"}

# HYD-PLAN-007 §3：(方法, 路径, 最低角色)；None 表示无需登录
ENDPOINTS = [
    ("post", "/api/auth/login", None),
    ("post", "/api/auth/logout", "viewer"),
    ("get", "/api/site", "viewer"),
    ("get", "/api/devices/{id}", "viewer"),
    ("post", "/api/devices/{id}/webrtc", "viewer"),
    ("get", "/api/incidents", "viewer"),
    ("get", "/api/incidents/{id}", "viewer"),
    ("post", "/api/incidents/{id}/reports", "operator"),
    ("get", "/api/reports/{id}", "viewer"),
    ("post", "/api/reports/{id}/review", "operator"),
    ("post", "/api/executions/{id}/rollback", "operator"),
    ("post", "/api/incidents/{id}/evidence/export", "operator"),
]
OPERATIONS = [(m, p, op) for p, item in SPEC["paths"].items() for m, op in item.items()]


def test_operations_match_endpoint_list() -> None:
    assert {(m, p) for m, p, _ in OPERATIONS} == {(m, p) for m, p, _ in ENDPOINTS}


@pytest.mark.parametrize(("method", "path", "role"), ENDPOINTS)
def test_declares_min_role_and_auth(method: str, path: str, role: str | None) -> None:
    op = SPEC["paths"][path][method]

    assert op.get("x-min-role") == role
    assert op.get("security", SPEC["security"]) == ([] if role is None else [{"bearer": []}])


@pytest.mark.parametrize(("method", "path", "op"), OPERATIONS)
def test_write_operation_requires_request_id(method: str, path: str, op: dict) -> None:
    refs = [p.get("$ref") for p in op.get("parameters", [])]

    assert ("#/components/parameters/RequestId" in refs) == (method in WRITE_METHODS)


def site_sample() -> dict:
    pose = {"x": 2, "y": 2, "height_m": 3, "yaw_deg": 45, "pitch_deg": -30, "hfov_deg": 90}
    camera = {
        "stream": "cam-01",
        "pose": pose | {"range_m": 15},
        "calibration": [[312, 540, 4.0, 6.0], [980, 552, 9.5, 6.2]],
        "homography": None,
        "reproj_error_m": None,
    }
    device = {"id": "cam-01", "type": "camera", "ip": "172.30.0.11", "mode": "bypass"}
    zone = {"id": "z-01", "name": "设备间外墙", "polygon": [[30, 0], [40, 0], [40, 6]]}
    return {
        "id": "demo-office",
        "name": "演示办公区",
        "width_m": 40,
        "height_m": 24,
        "walls": [[0, 0, 40, 0]],
        "zones": [zone | {"no_climb": True}],
        "devices": [device | {"state": "uncalibrated", "camera": camera}],
    }


def test_site_accepts_site_yaml_shape() -> None:
    Site.model_validate(site_sample())


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s["walls"].append([0, 0, 40]),
        lambda s: s["zones"][0]["polygon"].append([1, 2, 3]),
        lambda s: s["devices"][0]["camera"]["calibration"].append([1, 2, 3]),
        lambda s: s["devices"][0]["camera"].update(homography=[[1, 0, 0], [0, 1, 0]]),
        lambda s: s["devices"][0]["camera"].update(homography=[[1, 0], [0, 1], [0, 0]]),
    ],
    ids=["wall", "polygon-point", "calibration-point", "homography-rows", "homography-cols"],
)
def test_site_rejects_wrong_array_length(mutate) -> None:
    site = site_sample()
    mutate(site)

    with pytest.raises(ValidationError):
        Site.model_validate(site)


@pytest.mark.parametrize(
    ("field", "value"), [("state", "blocked"), ("ip", "x"), ("mode", "inline")]
)
def test_device_rejects_invalid_value(field: str, value: str) -> None:
    device = {"id": "nvr-01", "type": "nvr", "ip": "172.30.0.20", "mode": "bypass"}

    with pytest.raises(ValidationError):
        Device.model_validate(device | {"state": "normal", "camera": None, field: value})


def test_login_response_role_is_enumerated() -> None:
    with pytest.raises(ValidationError):
        LoginResponse.model_validate(
            {"token": "t", "role": "root", "expires_at": "2026-10-26T08:00:00Z"}
        )


def test_template_report_has_null_ai() -> None:
    report = {"id": "rep-01", "incident_id": "inc-0001", "facts": {"rule_id": "HYD-X-0001"}}
    nulls = dict.fromkeys(["ai", "provider_id", "reviewed_by", "reviewed_at"])

    assert Report.model_validate(report | nulls | {"source": "template"}).ai is None


def test_report_rejects_unknown_source() -> None:
    report = {"id": "rep-01", "incident_id": "inc-0001", "facts": {}, "source": "manual"}

    with pytest.raises(ValidationError):
        Report.model_validate(
            report | dict.fromkeys(["ai", "provider_id", "reviewed_by", "reviewed_at"])
        )


def test_incident_list_reuses_incident_entity() -> None:
    with pytest.raises(ValidationError):
        IncidentList.model_validate({"items": [{"id": "inc-0001"}]})
