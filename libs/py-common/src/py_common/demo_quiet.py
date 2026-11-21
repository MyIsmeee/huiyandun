"""演示静默（演示场景预设）：现场摄像头未校准时，演示期间不展示、不关联已知易误报的事件。

预设登记于 demo/scenarios/demo-quiet.yaml，由 make demo-quiet 打开、make demo-normal 关闭；compose.yaml 中默认
关闭，生产部署不读取。correlator 用它跳过关联（不生成关联事件，也就不存证、不研判、不推送），api-server 用它
跳过控制台展示与 24 小时历史。事件本身照常发布在 JetStream 中，关闭后重启 api-server 即可重新看到。
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

from py_contracts.events.event_base_schema import EventBase
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1
from py_contracts.events.hyd_vision_behavior_v1_schema import VisionBehaviorV1
from py_contracts.events.hyd_vision_integrity_v1_schema import VisionIntegrityV1


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# stream_lost 不在可选之列：断流是真实的设备状态，静默会让离线的摄像头显示为在线
type Tamper = Literal["freeze", "replay", "occlusion", "shift"]


class Integrity(_Strict):
    hide: list[Tamper] = []
    # 摄像头编号 → 仍照常判定的类型（如靶机画面保留冻结与重放，挪位照样静默）
    keep: dict[str, list[Tamper]] = {}


class Behavior(_Strict):
    hide_levels: list[Literal["suspected", "confirmed"]] = []
    hide_behaviors: list[Literal["fall", "climb", "still", "fight"]] = []


class Alerts(_Strict):
    hide_unregistered: bool = False
    keep_rules: list[str] = []


class QuietPreset(_Strict):
    integrity: Integrity = Integrity()
    behavior: Behavior = Behavior()
    alerts: Alerts = Alerts()

    def hides(self, event: EventBase) -> bool:
        """事件是否被预设静默。"""
        match event:
            case VisionIntegrityV1():
                return (
                    event.type in self.integrity.hide
                    and event.type not in self.integrity.keep.get(event.camera_id, [])
                )
            case VisionBehaviorV1():
                # 1.0 的行为事件没有 level，按 confirmed
                return (event.level or "confirmed") in self.behavior.hide_levels or (
                    event.behavior in self.behavior.hide_behaviors
                )
            case SecurityAlertV1():
                return (
                    self.alerts.hide_unregistered
                    and event.device_id is None
                    and event.rule_id not in self.alerts.keep_rules
                )
        return False
