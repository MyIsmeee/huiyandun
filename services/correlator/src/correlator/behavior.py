"""设备行为模型（TK-115，设计 109-model-driven-security.md §3.3 B）：从 Zeek conn.log 学习每台已登记设备的
正常网络行为，持续两个窗口偏离基线时发布 behavior_anomaly 告警（FR-205，source=model）。

每 30 s 一个窗口，按读到会话记录的时刻归入窗口（Zeek 在会话结束后才写记录）。每台设备每个窗口提取会话数、
访问方数、从未见过的访问方数、失败会话占比、入/出字节、平均会话时长，不含时段（D-093：基线只录 10 分钟，
学不到一天中的规律）。River HalfSpaceTrees 按窗口在线学习；偏离窗口不学习、其中的访问方也不记为已见过，
攻击者无法在学习期之后把自己混入基线。启动后先学 20 个窗口再判定；状态逐窗口存盘，重启后续用，
没有状态时可从预先学好的基线快照开始。
"""

import json
import logging
import math
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from ipaddress import ip_address
from pathlib import Path
from statistics import fmean, pstdev
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from river.anomaly import HalfSpaceTrees

from py_contracts.events.hyd_security_alert_v1_schema import SecurityAlertV1

SCHEMA_VERSION = "1.2.0"  # 与归一化器发布的告警同一契约版本
MODEL_ID, MODEL_VERSION = "behavior-model", "1.0.0"  # 特征或判定改变时升版本，旧状态不再续用
WINDOW_S = 30
LEARN_WINDOWS = 20  # 学习期 10 分钟，只学习不告警
HISTORY = 40  # 保留最近学过的窗口：重启时重建模型、计算基线均值与标准差
ANOMALY_WINDOWS = 2  # 连续偏离的窗口数达到即告警（FR-205）
# 分数阈值：模拟录像机周期拉流的合成基线上，正常窗口最高 0.29，低速爆破、被封禁后的连接、只有攻击方的
# 窗口最低 0.79。还须至少一个特征偏离基线 3σ，告警说明才有可写的偏离项
SCORE_THRESHOLD = 0.6
MIN_SIGMA = 3.0
SIGMA_FLOOR = 0.02  # 缩放后特征的标准差下限：基线恒定的特征（如新访问方数恒为 0）不至于除以 0
# 会话结束早于此时长的记录不计入：首次启动时读到的历史日志、停机后补读的积压。Zeek 在会话结束后才写记录，
# 空闲超时的会话最晚约 5 分钟后写出
STALE_S = 600
MIN_STREAM_BYTES = 1024  # 响应不足 1 KiB 的会话没取得码流（如认证被拒），与未建立的会话一并计为失败
OK_STATES = {"SF", "S1", "S2", "S3", "RSTO", "RSTR"}  # Zeek conn_state 中已建立的会话
EVENT_NAMESPACE = uuid.UUID("0b8a4f3e-6c2d-4e1a-9f57-2d6c8e1b3a94")

log = logging.getLogger(__name__)

# 特征名（告警说明用）与缩放上限：计数与字节取对数后除以上限的对数，缩放到 HalfSpaceTrees 要求的 [0, 1]，
# 超出上限记为 1。上限按单台摄像头 30 s 内的量取小：上限越大，少量变化在 [0, 1] 中越难与基线分开
FEATURES = (
    ("会话数", 50),
    ("访问方数", 10),
    ("新访问方数", 3),
    ("失败会话占比", None),
    ("入向字节", 1e9),
    ("出向字节", 1e9),
    ("平均会话时长", 300),
)
NEW_PEERS, FAILED, BYTES_OUT = 2, 3, 5
UNITS = {4: " B", 5: " B", 6: " s"}
# ATT&CK 由偏离的特征按固定表映射（确定性，不依赖模型）
T_BRUTE_FORCE, T_EXFILTRATION, T_VIDEO_CAPTURE = "T1110", "T1041", "T1125"


class _Conn(BaseModel):
    """conn.log 的一行。日志来自解析不可信流量的探针，按模型校验后才取用。"""

    model_config = ConfigDict(populate_by_name=True)

    ts: float
    uid: str
    orig_h: str = Field(alias="id.orig_h")
    resp_h: str = Field(alias="id.resp_h")
    conn_state: str = "-"
    duration: float = 0.0
    orig_bytes: int = 0
    resp_bytes: int = 0


@dataclass(frozen=True)
class _Session:
    peer: str
    ts: float
    uid: str
    failed: bool
    bytes_in: int  # 设备收到的字节
    bytes_out: int  # 设备发出的字节
    duration: float


@dataclass
class _Window:
    start: float
    sessions: list[_Session]
    x: list[float]
    new_peers: list[str]
    score: float = 0.0


def _features(sessions: list[_Session], seen: set[str]) -> tuple[list[float], list[str]]:
    peers = {s.peer for s in sessions}
    new = sorted(peers - seen)
    n = len(sessions)
    x = [
        float(n),
        float(len(peers)),
        float(len(new)),
        sum(s.failed for s in sessions) / n if n else 0.0,
        float(sum(s.bytes_in for s in sessions)),
        float(sum(s.bytes_out for s in sessions)),
        fmean(s.duration for s in sessions) if n else 0.0,
    ]
    return x, new


def _scale(x: list[float]) -> list[float]:
    return [
        v if cap is None else min(1.0, math.log1p(v) / math.log1p(cap))
        for v, (_, cap) in zip(x, FEATURES, strict=True)
    ]


def _fmt(i: int, v: float) -> str:
    if i == FAILED:
        return f"{v:.2f}"
    return f"{v:.1f}{UNITS.get(i, '')}" if i == 6 else f"{v:.0f}{UNITS.get(i, '')}"


@dataclass
class _Device:
    id: str
    ip: str
    seen: set[str] = field(default_factory=set)
    history: deque[list[float]] = field(default_factory=lambda: deque(maxlen=HISTORY))
    learned: int = 0
    model: HalfSpaceTrees = field(default_factory=lambda: _new_model())
    streak: list[_Window] = field(default_factory=list)
    alerted: bool = False  # 本次连续偏离已告警，回到正常前不再重复

    def learn(self, window: _Window) -> None:
        self.model.learn_one(dict(enumerate(_scale(window.x))))
        self.history.append(window.x)
        self.seen.update(s.peer for s in window.sessions)
        self.learned += 1

    def sigmas(self, x: list[float]) -> list[float]:
        """各特征偏离基线的标准差倍数（带符号），在缩放后的尺度上计算。"""
        scaled = [_scale(h) for h in self.history]
        out = []
        for i, v in enumerate(_scale(x)):
            column = [h[i] for h in scaled]
            out.append((v - fmean(column)) / max(pstdev(column), SIGMA_FLOOR))
        return out


def _new_model() -> HalfSpaceTrees:
    # 参考窗口 10 个（5 分钟），学习期内即完成两轮；种子固定，同一状态重建出同一模型
    return HalfSpaceTrees(n_trees=50, height=8, window_size=10, seed=42)


class BehaviorModel:
    def __init__(self, devices: dict[str, str]) -> None:
        """devices：设备 IP → 设备 ID（站点登记表）。"""
        self._devices = {ip: _Device(device_id, ip) for ip, device_id in devices.items()}
        self._sessions: dict[str, list[_Session]] = {ip: [] for ip in devices}

    def add(self, line: str, now: float) -> None:
        """记一条会话：与已登记设备无关的会话、早已结束的会话忽略，不合格的记录跳过。"""
        try:
            conn = _Conn.model_validate_json(line)
        except ValidationError as e:
            log.warning("correlator.conn_invalid", extra={"error": str(e)})
            return
        if conn.ts + conn.duration < now - STALE_S:
            return
        for device_ip, peer, inbound in (
            (conn.resp_h, conn.orig_h, True),
            (conn.orig_h, conn.resp_h, False),
        ):
            if device_ip in self._sessions:
                failed = conn.conn_state not in OK_STATES or (
                    inbound and conn.resp_bytes < MIN_STREAM_BYTES
                )
                self._sessions[device_ip].append(
                    _Session(
                        peer=peer,
                        ts=conn.ts,
                        uid=conn.uid,
                        failed=failed,
                        bytes_in=conn.orig_bytes if inbound else conn.resp_bytes,
                        bytes_out=conn.resp_bytes if inbound else conn.orig_bytes,
                        duration=conn.duration,
                    )
                )

    def close_window(self, start: float) -> list[SecurityAlertV1]:
        """结束从 start 开始的窗口：逐设备判定或学习，返回需发布的告警。"""
        alerts = []
        for ip, device in self._devices.items():
            sessions, self._sessions[ip] = self._sessions[ip], []
            x, new = _features(sessions, device.seen)
            window = _Window(start, sessions, x, new)
            if device.learned < LEARN_WINDOWS:
                device.learn(window)
                continue
            window.score = device.model.score_one(dict(enumerate(_scale(x))))
            if window.score > SCORE_THRESHOLD and max(device.sigmas(x)) >= MIN_SIGMA:
                device.streak.append(window)
                if len(device.streak) >= ANOMALY_WINDOWS and not device.alerted:
                    device.alerted = True
                    alerts.append(self._alert(device))
            else:
                device.streak.clear()
                device.alerted = False
                device.learn(window)
        return alerts

    def learning(self) -> dict[str, int]:
        """学习期内的设备及已学窗口数。"""
        return {d.id: d.learned for d in self._devices.values() if d.learned < LEARN_WINDOWS}

    def _alert(self, device: _Device) -> SecurityAlertV1:
        streak = device.streak
        sessions = [s for w in streak for s in w.sessions]
        new = sorted({p for w in streak for p in w.new_peers})
        # 攻击方：会话最多的新访问方；没有新访问方时取失败会话最多的访问方
        counts: dict[str, int] = {}
        for s in sessions:
            if s.peer in new or not new:
                counts[s.peer] = counts.get(s.peer, 0) + (1 if new else s.failed)
        src = max(sorted(counts), key=counts.__getitem__)
        first = min((s for s in sessions if s.peer == src), key=lambda s: s.ts)
        x = [fmean(w.x[i] for w in streak) for i in range(len(FEATURES))]
        sigmas = device.sigmas(x)
        baseline = [fmean(h[i] for h in device.history) for i in range(len(FEATURES))]
        top = sorted(range(len(FEATURES)), key=lambda i: abs(sigmas[i]), reverse=True)[:2]
        parts = [f"新访问方 {'、'.join(new)}"] if new else []
        parts.append(
            "偏离最大："
            + "、".join(
                f"{FEATURES[i][0]} {_fmt(i, x[i])}（基线 {_fmt(i, baseline[i])}，"
                f"{sigmas[i]:+.1f}σ）"
                for i in top
            )
        )
        if sigmas[FAILED] >= MIN_SIGMA:
            technique = T_BRUTE_FORCE
        elif sigmas[BYTES_OUT] >= MIN_SIGMA:
            technique = T_EXFILTRATION
        elif new:
            technique = T_VIDEO_CAPTURE
        else:
            technique = T_BRUTE_FORCE
        return SecurityAlertV1(
            schema_version=SCHEMA_VERSION,
            event_id=uuid.uuid5(EVENT_NAMESPACE, f"{device.id}/{streak[0].start}"),
            # 偏离开始的时刻：该访问方在本次偏离中的首个会话
            ts=datetime.fromtimestamp(first.ts, UTC),
            rule_id=MODEL_ID,
            rule_version=MODEL_VERSION,
            # 可参与关联；命中路径含模型告警时处置须人工确认（FR-407）
            mode="enforce",
            category="behavior_anomaly",
            severity="medium",
            src_ip=ip_address(src),
            dst_ip=ip_address(device.ip),
            device_id=device.id,
            technique=technique,
            evidence_ref=f"zeek:conn/{first.uid}",
            source="model",
            confidence=round(min(1.0, max(w.score for w in streak)), 2),
            summary=f"{device.id} 行为偏离基线：" + "；".join(parts),
        )

    def dump(self) -> dict[str, Any]:
        """状态；baseline 为各特征在已学窗口上的均值与标准差，供值班员工具 get_baseline 读取。"""
        return {
            "model": MODEL_ID,
            "version": MODEL_VERSION,
            "window_s": WINDOW_S,
            "learn_windows": LEARN_WINDOWS,
            "devices": {
                d.id: {
                    "learned": d.learned,
                    "seen": sorted(d.seen),
                    "history": list(d.history),
                    "baseline": {
                        name: {
                            "mean": round(fmean(h[i] for h in d.history), 3),
                            "std": round(pstdev(h[i] for h in d.history), 3),
                        }
                        for i, (name, _) in enumerate(FEATURES)
                    }
                    if d.history
                    else {},
                }
                for d in self._devices.values()
            },
        }

    def load(self, state: dict[str, Any]) -> bool:
        """续用存盘的状态；模型版本不同时返回 False、从头学习。按历史窗口重建模型。"""
        if state.get("model") != MODEL_ID or state.get("version") != MODEL_VERSION:
            return False
        by_id = {d.id: d for d in self._devices.values()}
        for device_id, saved in state["devices"].items():
            device = by_id.get(device_id)
            if device is None:
                continue
            for x in saved["history"]:
                device.model.learn_one(dict(enumerate(_scale(x))))
                device.history.append(x)
            device.learned, device.seen = saved["learned"], set(saved["seen"])
        return True


def save_state(model: BehaviorModel, path: Path) -> None:
    """先写临时文件再改名：进程中途退出也不会留下残缺的状态。"""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(model.dump(), ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
