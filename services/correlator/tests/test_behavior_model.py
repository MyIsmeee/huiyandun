"""设备行为模型（TK-115、FR-205）：合成 conn.log——正常基线零告警、低速爆破告警、新访问方拉流告警、
学习期不告警、重启续用。基线模拟录像机每 15 s 拉流约 5 s，每个 30 s 窗口 1～3 个会话。"""

import json
import random

import pytest

from correlator.behavior import LEARN_WINDOWS, WINDOW_S, BehaviorModel
from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1

CAM, NVR, ATTACKER = "172.30.0.12", "172.30.0.13", "172.30.0.100"


class Traffic:
    def __init__(self, seed: int = 0) -> None:
        self.rng = random.Random(seed)
        self.model = BehaviorModel({CAM: "cam-02", "172.30.0.11": "cam-01"})
        self.t = 1_800_000_000.0
        self.uid = 0

    def conn(self, orig: str, **fields: object) -> str:
        self.uid += 1
        record = {
            "ts": self.t + self.rng.uniform(0, WINDOW_S),
            "uid": f"C{self.uid}",
            "id.orig_h": orig,
            "id.orig_p": 40000 + self.uid,
            "id.resp_h": CAM,
            "id.resp_p": 8554,
            "proto": "tcp",
            "conn_state": "SF",
            "duration": 5.0,
            "orig_bytes": 900,
            "resp_bytes": 200_000,
        } | fields
        return json.dumps(record)

    def add(self, orig: str, **fields: object) -> None:
        self.model.add(self.conn(orig, **fields), self.t + WINDOW_S)

    def recorder(self) -> None:
        """录像机凭合法账号拉流：每个窗口 1～3 次，每次约 5 s、数百 KB。"""
        for _ in range(self.rng.choice([1, 2, 2, 2, 3])):
            self.add(
                NVR,
                duration=self.rng.uniform(4.8, 5.6),
                orig_bytes=self.rng.randint(700, 1100),
                resp_bytes=self.rng.randint(150_000, 260_000),
            )

    def guess(self) -> None:
        """攻击方的一次认证尝试：约 2 s 后被拒，响应只有一条 401。"""
        self.add(ATTACKER, duration=2.0, orig_bytes=180, resp_bytes=150)

    def window(self, *extra: str) -> list[SecurityAlertV1]:
        self.recorder()
        for kind in extra:
            getattr(self, kind)()
        alerts = self.model.close_window(self.t)
        self.t += WINDOW_S
        return alerts

    def learned(self) -> "Traffic":
        for _ in range(LEARN_WINDOWS):
            assert self.window() == []
        return self


@pytest.mark.parametrize("seed", range(5))
def test_normal_baseline_never_alerts(seed: int) -> None:
    traffic = Traffic(seed).learned()
    assert [a for _ in range(200) for a in traffic.window()] == []


def test_slow_bruteforce_alerts_after_two_windows() -> None:
    """每分钟 3 次（每窗口 1～2 次），低于 HYD-NET-0001 的 5 次/60 s 阈值。"""
    traffic = Traffic().learned()
    first_guess = traffic.t
    assert traffic.window("guess") == []  # 只偏离一个窗口不告警
    [alert] = traffic.window("guess")
    assert (alert.source, alert.category, alert.mode) == ("model", "behavior_anomaly", "enforce")
    assert (alert.device_id, str(alert.src_ip), str(alert.dst_ip)) == ("cam-02", ATTACKER, CAM)
    assert alert.technique == "T1110"
    assert 0.6 < alert.confidence <= 1
    # 白话摘要（D-106）：陌生访问方 + 偏离最大的两项及平时水平，不出现 σ
    assert alert.summary.startswith(f"cam-02 出现陌生访问方 {ATTACKER}；")
    assert "连接失败率" in alert.summary and "（平时 " in alert.summary
    assert "σ" not in alert.summary
    # 时刻取偏离开始：攻击方的首个会话
    assert first_guess <= alert.ts.timestamp() < first_guess + WINDOW_S
    assert alert.evidence_ref.startswith("zeek:conn/C")
    # 持续偏离只报一次；回到正常后再出现重新告警，攻击方仍是新访问方（偏离窗口不学习）
    assert traffic.window("guess") == []
    assert traffic.window() == []
    assert traffic.window("guess") == []
    assert len(traffic.window("guess")) == 1


def test_blocked_connections_still_anomalous() -> None:
    traffic = Traffic().learned()
    blocked = {"conn_state": "S0", "duration": 0, "orig_bytes": 0, "resp_bytes": 0}
    alerts = []
    for _ in range(2):
        traffic.add(ATTACKER, **blocked)
        alerts += traffic.window()
    assert [a.technique for a in alerts] == ["T1110"]


def test_new_peer_pulling_stream() -> None:
    """陌生方凭有效账号拉流（会话成功、码流正常）：映射为视频采集 T1125。"""
    traffic = Traffic().learned()
    alerts = []
    for _ in range(2):
        traffic.add("172.30.0.200")
        alerts += traffic.window()
    [alert] = alerts
    assert (alert.technique, str(alert.src_ip)) == ("T1125", "172.30.0.200")


def test_learning_period_never_alerts() -> None:
    traffic = Traffic()
    assert traffic.model.learning() == {"cam-02": 0, "cam-01": 0}
    for _ in range(LEARN_WINDOWS):
        assert traffic.window("guess", "guess") == []
    assert traffic.model.learning() == {}


def test_restart_resumes_state() -> None:
    """存盘再加载：不重新进入学习期，已见过的访问方与判定照旧。"""
    traffic = Traffic().learned()
    for _ in range(30):
        traffic.window()
    state = json.loads(json.dumps(traffic.model.dump()))
    traffic.model = BehaviorModel({CAM: "cam-02", "172.30.0.11": "cam-01"})
    assert traffic.model.load(state)
    assert traffic.model.learning() == {}
    assert traffic.window() == []
    assert traffic.window("guess") == []
    assert len(traffic.window("guess")) == 1


def test_state_carries_baseline_summary() -> None:
    traffic = Traffic().learned()
    saved = traffic.model.dump()["devices"]["cam-02"]
    assert saved["seen"] == [NVR]
    assert 1 <= saved["baseline"]["会话数"]["mean"] <= 3
    assert saved["baseline"]["新访问方数"]["mean"] == 0.05  # 只有第一个窗口里录像机是新访问方
    assert traffic.model.dump()["devices"]["cam-01"]["baseline"]["会话数"]["mean"] == 0


def test_stale_state_ignored() -> None:
    model = BehaviorModel({CAM: "cam-02"})
    assert not model.load(model.dump() | {"version": "0.0.1"})
    assert model.learning() == {"cam-02": 0}


def test_invalid_unrelated_and_stale_records_ignored() -> None:
    """含首次启动时读到的历史日志：结束早于 10 分钟的会话不计入当前窗口。"""
    traffic = Traffic()
    now = traffic.t + WINDOW_S
    traffic.model.add("not json", now)
    traffic.model.add(json.dumps({"ts": "x", "uid": "C1"}), now)
    traffic.add("10.0.0.1", **{"id.resp_h": "10.0.0.2"})
    traffic.add(ATTACKER, ts=traffic.t - 3600, duration=5.0)
    traffic.model.close_window(traffic.t)
    saved = traffic.model.dump()["devices"]["cam-02"]
    assert saved["seen"] == [] and saved["history"][0][0] == 0


def test_sync_follows_registry() -> None:
    """D-101：新登记的设备从头学习，删除的丢弃，IP 与编号都未变的沿用学过的基线。"""
    traffic = Traffic().learned()
    model = traffic.model
    before = model.learning()
    assert "cam-02" not in before  # 已学完
    model.sync({CAM: "cam-02", "10.0.0.9": "cam-09"})
    assert model.learning() == {"cam-09": 0}
    model.sync({"10.0.0.9": "cam-09"})
    assert set(model.dump()["devices"]) == {"cam-09"}
