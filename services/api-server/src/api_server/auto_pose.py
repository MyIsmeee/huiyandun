"""自动标定（视觉引擎的单目几何估计 → 摄像头安装参数）：未做 4 点标定的摄像头，按画面估出的安装高度、俯角、视角
自动写回，人员位置、三维姿态与场景随之按真实尺度换算，不必管理员逐台填写。

只改这三项，不动平面位置与朝向（那是摆放在区域里的位置，画面看不出）；已标定的摄像头不改（以标定为准）。
估计值本身是近几次的中位数，与当前值相差不到 TOLERANCE 时不改，同一台至多每 MIN_INTERVAL_S 改一次，
避免来回改动触发视觉引擎反复重启该路。每次改动写审计，执行者记为 system:auto-calibration。
"""

import logging
import time
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update

from api_server import scene
from api_server.audit import record
from api_server.cameras import cameras
from api_server.site import MIN_CALIBRATION_POINTS
from py_contracts.events.hyd_vision_pose_check_v1_schema import VisionPoseCheckV1

ACTOR = "system:auto-calibration"
TOLERANCE = {"height_m": 0.15, "pitch_deg": 2.0, "hfov_deg": 3.0}
MIN_INTERVAL_S = 600.0

log = logging.getLogger(__name__)


def proposal(pose: dict[str, Any], geometry: dict[str, Any]) -> dict[str, float] | None:
    """需要写回的字段；估计值超出可填范围或与当前值都相差不大时为 None。"""
    candidate = {
        "height_m": round(float(geometry["height_m"]), 2),
        "pitch_deg": round(float(geometry["pitch_deg"]), 1),
        "hfov_deg": round(float(geometry["hfov_deg"]), 1),
    }
    if not (0 < candidate["height_m"] <= 50 and -90 <= candidate["pitch_deg"] < 0):
        return None
    if not 0 < candidate["hfov_deg"] < 180:
        return None
    if all(abs(candidate[k] - float(pose[k])) <= TOLERANCE[k] for k in TOLERANCE):
        return None
    return candidate


class AutoPose:
    def __init__(self, app: Any, enabled: bool = True) -> None:
        self._app = app
        self._enabled = enabled
        self._applied: dict[str, float] = {}  # 摄像头 → 上次写回的时刻（单调时钟）

    async def on_check(self, event: VisionPoseCheckV1) -> None:
        if not self._enabled or event.geometry is None:
            return
        last = self._applied.get(event.camera_id)
        if last is not None and time.monotonic() - last < MIN_INTERVAL_S:
            return
        geometry = event.geometry.model_dump(mode="json")
        state = self._app.state
        async with state.engine.begin() as conn:
            row = (
                (
                    await conn.execute(
                        select(cameras).where(cameras.c.id == event.camera_id).with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if row is None or len(row["calibration"]) >= MIN_CALIBRATION_POINTS:
                return
            changes = proposal(row["pose"], geometry)
            if changes is None:
                return
            pose = dict(row["pose"]) | changes
            now = datetime.now(UTC)
            await conn.execute(
                update(cameras)
                .where(cameras.c.id == event.camera_id)
                .values(pose=pose, updated_at=now)
            )
            if row["area_id"]:
                await scene.touch(conn, row["area_id"], now)
            await record(
                conn,
                actor=ACTOR,
                action="camera.pose_auto",
                target=event.camera_id,
                before={k: row["pose"][k] for k in changes},
                after=changes | {"scale_ref": geometry["scale_ref"]},
                request_id=f"auto-pose-{event.event_id}",
            )
        self._applied[event.camera_id] = time.monotonic()
        state.pose_checks.forget(event.camera_id)
        log.info("camera.pose_auto", extra={"camera_id": event.camera_id} | changes)
        await state.cameras.apply()
