"""安装参数自检的最新结果（hyd.vision.pose_check.v1）：只保存在内存中，随摄像头列表给出，供摄像头设置提示。

视觉引擎每路每 30 s 上报一次；超过 STALE_S 没有更新（视觉引擎停止、该路已标定或已删除）即不再给出。
改了安装参数的摄像头丢弃旧结果：旧结果的建议值是相对旧参数说的，等视觉引擎按新参数重新上报。
"""

import time

from py_contracts.api import PoseCheck
from py_contracts.events.hyd_vision_pose_check_v1_schema import VisionPoseCheckV1

STALE_S = 120.0
MIN_CALIBRATION_POINTS = 4  # 已标定的摄像头位置按标定换算，不需要安装参数自检


class PoseChecks:
    def __init__(self) -> None:
        self._latest: dict[str, tuple[float, PoseCheck]] = {}

    def on_check(self, event: VisionPoseCheckV1, now: float | None = None) -> None:
        check = PoseCheck.model_validate(
            event.model_dump(include=set(PoseCheck.model_fields), mode="json")
        )
        self._latest[event.camera_id] = (time.monotonic() if now is None else now, check)

    def forget(self, camera_id: str) -> None:
        self._latest.pop(camera_id, None)

    def get(
        self, camera_id: str, calibration_points: int, now: float | None = None
    ) -> PoseCheck | None:
        entry = self._latest.get(camera_id)
        if entry is None or calibration_points >= MIN_CALIBRATION_POINTS:
            return None
        at, check = entry
        return check if (time.monotonic() if now is None else now) - at <= STALE_S else None
