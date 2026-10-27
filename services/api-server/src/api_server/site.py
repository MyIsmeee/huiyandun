"""site.yaml 导入（FR-901～FR-903）与 GET /api/site。启动时加载一次，只在内存中保存。"""

from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, Depends, Request
from pydantic import ValidationError
from pydantic_core import ErrorDetails

from api_server.auth import require
from py_contracts.api import Site
from py_contracts.config.site_schema import SiteConfig

MIN_CALIBRATION_POINTS = 4  # 单应矩阵至少需要 4 组对应点（FR-902、C-CV-05）


class SiteError(Exception):
    """site.yaml 无法读取或不符合 Schema，拒绝导入；errors 每项为"字段路径: 原因"（FR-903）。"""

    def __init__(self, path: Path, errors: list[str]) -> None:
        super().__init__(f"{path} 拒绝导入：\n" + "\n".join(errors))
        self.errors = errors


def _duplicates(section: str, field: str, values: list[Any]) -> list[str]:
    """Schema 无法表达对象列表中某字段唯一，在此校验。"""
    return [
        f"{section}.{i}.{field}: {field} {v} 重复" for i, v in enumerate(values) if v in values[:i]
    ]


def _device(camera: dict[str, Any], mode: str) -> dict[str, Any]:
    calibrated = len(camera["calibration"]) >= MIN_CALIBRATION_POINTS
    return {
        "id": camera["id"],
        "type": "camera",
        "ip": camera["ip"],
        "mode": mode,
        "state": "normal" if calibrated else "uncalibrated",
        "camera": {
            "stream": camera["stream"],
            "pose": camera["pose"],
            "calibration": camera["calibration"],
            # 单应矩阵与重投影误差由 vision-engine 计算（TK-023）
            "homography": None,
            "reproj_error_m": None,
        },
    }


def _field_path(data: Any, err: ErrorDetails) -> str:
    """联合类型（如 IPv4 | IPv6）会在 loc 中插入成员标签，只保留输入中实际存在的键与下标。"""
    parts = []
    for key in err["loc"]:
        if (isinstance(data, dict) and key in data) or (
            isinstance(data, list) and isinstance(key, int)
        ):
            data = data[key]
            parts.append(str(key))
    if err["type"] == "missing":
        parts.append(str(err["loc"][-1]))
    return ".".join(parts) or "<根>"


def load(path: Path) -> Site:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as e:
        raise SiteError(path, [f"无法读取：{e}"]) from e
    except yaml.YAMLError as e:
        raise SiteError(path, [f"YAML 语法错误：{e}"]) from e
    try:
        config = SiteConfig.model_validate(raw)
    except ValidationError as e:
        raise SiteError(
            path, [f"{_field_path(raw, err)}: {err['msg']}" for err in e.errors()]
        ) from e
    # correlator 按 IP 查设备补全 device_id（FR-203），IP 重复时无法确定是哪台
    errors = (
        _duplicates("zones", "id", [z.id for z in config.zones])
        + _duplicates("cameras", "id", [c.id for c in config.cameras])
        + _duplicates("cameras", "ip", [c.ip for c in config.cameras])
    )
    if errors:
        raise SiteError(path, errors)

    data = config.model_dump(mode="json")
    mode = data["site"].pop("mode")
    return Site.model_validate(
        data["site"]
        | {
            "walls": data["walls"],
            "zones": data["zones"],
            "devices": [_device(c, mode) for c in data["cameras"]],
        }
    )


router = APIRouter(prefix="/api")


@router.get("/site", dependencies=[Depends(require("viewer"))])
async def get_site(request: Request) -> Site:
    return request.app.state.site
