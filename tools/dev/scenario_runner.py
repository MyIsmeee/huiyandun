"""scenario-runner（TK-100、DM-11）：按剧本时间轴执行动作，并断言每步的预期事件。

用法：python tools/dev/scenario_runner.py <剧本.yaml> [--from-step N] -- <docker compose 命令及全局参数>
动作经 docker compose 在宿主机执行；事件由 scenario-runner 服务在 core-net 内订阅、逐行写到标准输出。
任一步失败时退出码为 1。设计见 HYD 设计文档 100-demo-run.md。
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ACTIONS = {
    "start_attack": "target",
    "start_slow_attack": "target",
    "freeze_camera": "camera",
    "replay_camera": "camera",
    "restore_camera": "camera",
    "verify_evidence": "camera",
}
STEP_KEYS = {"name", "at", "do", "expect", "note"}
EVENT_EXPECT_KEYS = {"subject", "match", "within_s", "absent"}
TIMEOUT_S = 120  # 单条 docker compose 命令的上限（CD-04）
# 定格帧推流：H.264 全帧内编码、固定量化，解码后逐帧相同（D-080）；$RTSP_PORT、$MTX_PATH 由 mediamtx 展开
FREEZE_CMD = (
    "ffmpeg -hide_banner -loglevel error -re -loop 1 -framerate 25 -i /tmp/freeze-{path}.png "
    "-c:v libx264 -preset ultrafast -tune stillimage -x264-params keyint=1 -qp 20 -pix_fmt yuv420p "
    "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)
# 从素材的指定秒数起循环推流，同 mediamtx.yml 的默认推流（直接复制编码，从最近的关键帧开始，误差 ≤ 2 s）
STREAM_CMD = (
    "ffmpeg -hide_banner -loglevel error -re -ss {offset:.0f} -stream_loop -1 -i /media/$MTX_PATH.mp4 "
    "-c copy -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)
# 重放 2 分钟前的片段：须在 FR-302 的 30～180 s 内，且是视觉引擎看到过的画面（不落在冻结期间）
REPLAY_BACK_S = 120
MEDIAMTX_API = "http://127.0.0.1:9997/v3/config/paths/replace/"  # 只监听容器内
BEHAVIOR_STATE = "/var/lib/correlator/behavior.json"  # 行为模型存盘状态，与 correlator 的配置一致
INCIDENT = "hyd.correlator.incident.v1"
# 在 evidence-service 容器内取证据包（内部接口只在 core-net，080 §3.3）；界面导出经 api-server 审计，取的是同一个包
FETCH_PACKAGE = (
    "import sys, urllib.parse, urllib.request; sys.stdout.buffer.write(urllib.request.urlopen("
    "'http://127.0.0.1:8200/internal/incidents/' + urllib.parse.quote(sys.argv[1], safe='') + "
    "'/package', timeout=60).read())"
)
# 信任起点：evidence-service 启动日志 evidence.started 输出的公钥指纹（080 §4）
FINGERPRINT = re.compile(r'"public_key_fingerprint": "(sha256:[0-9a-f]{64})"')
VERIFY_CMD = ["uv", "run", "-q", "--package", "evidence-verify", "hyd-evidence", "verify"]


@dataclass(frozen=True)
class Step:
    name: str
    at_s: int
    do: dict[str, str] | None = None
    expect: dict[str, Any] | None = None
    note: str | None = None


@dataclass(frozen=True)
class Scenario:
    id: str
    ttl_s: int | None
    steps: list[Step]


def parse_at(text: str) -> int:
    minutes, _, seconds = str(text).partition(":")
    if not (minutes.isdigit() and seconds.isdigit() and int(seconds) < 60):
        raise ValueError(f"时刻须为 分:秒，实为 {text!r}")
    return int(minutes) * 60 + int(seconds)


def _check_keys(where: str, given: dict[str, Any], allowed: set[str]) -> None:
    unknown = set(given) - allowed
    if unknown:
        raise ValueError(f"{where}：未知字段 {sorted(unknown)}")


def load(path: Path) -> Scenario:
    """解析并校验剧本；未知字段、动作与非法时刻一律报错（07 §7）。"""
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    _check_keys("剧本", data, {"id", "overrides", "steps"})
    overrides = data.get("overrides") or {}
    _check_keys("overrides", overrides, {"playbook_ttl_s"})
    steps = []
    for i, raw in enumerate(data["steps"], 1):
        where = f"第 {i} 步"
        _check_keys(where, raw, STEP_KEYS)
        do, expect = raw.get("do"), raw.get("expect")
        if do is not None:
            action = do.get("action")
            if action not in ACTIONS:
                raise ValueError(f"{where}：未知动作 {action!r}")
            if set(do) != {"action", ACTIONS[action]}:
                raise ValueError(f"{where}：{action} 须且只须有 {ACTIONS[action]}")
        if expect is not None and set(expect) not in ({"attack"}, {"evidence"}):
            _check_keys(where, expect, EVENT_EXPECT_KEYS)
            if not {"subject", "within_s"} <= set(expect):
                raise ValueError(f"{where}：expect 须有 subject 与 within_s")
            if expect.get("absent", True) is not True:
                raise ValueError(f"{where}：expect.absent 只能为 true")
        if expect is not None and expect.get("attack", "blocked") != "blocked":
            raise ValueError(f"{where}：expect.attack 只能为 blocked")
        if expect is not None and "attack" in expect and (do or {}).get("action") != "start_attack":
            raise ValueError(f"{where}：expect.attack 须与 start_attack 同一步")
        if expect is not None and expect.get("evidence", "verified") != "verified":
            raise ValueError(f"{where}：expect.evidence 只能为 verified")
        if (
            expect is not None
            and "evidence" in expect
            and (do or {}).get("action") != "verify_evidence"
        ):
            raise ValueError(f"{where}：expect.evidence 须与 verify_evidence 同一步")
        steps.append(Step(raw["name"], parse_at(raw["at"]), do, expect, raw.get("note")))
    return Scenario(data["id"], overrides.get("playbook_ttl_s"), steps)


def matches(event: dict[str, Any], expected: dict[str, Any]) -> bool:
    """标量相等；事件字段为数组时包含期望值；期望值为数组时取其一。"""
    for key, want in expected.items():
        got = event.get(key)
        options = want if isinstance(want, list) else [want]
        values = got if isinstance(got, list) else [got]
        if not any(v in options for v in values):
            return False
    return True


def timeline(scenario: Scenario, from_step: int, start: float) -> list[tuple[int, float, Step]]:
    """要执行的步骤（序号、到点时刻、步骤）。开场 start 始终对应素材 0:00（setup 重启推流）：
    续跑时跳过前面的步骤、到第 N 步的时刻再开始，素材相关的断言仍与时间线对齐（05 §5.3）。"""
    return [(i, start + s.at_s, s) for i, s in enumerate(scenario.steps, 1) if i >= from_step]


def attack_blocked(output: str) -> bool:
    """attack-sim 每次尝试输出一行 `attempt N: <状态>`；全部连接失败即封禁生效。"""
    attempts = [line for line in output.splitlines() if line.startswith("attempt ")]
    return bool(attempts) and all(": connection failed" in line for line in attempts)


def evidence_verified(output: str) -> bool:
    """verify_evidence 的输出为被改记录的序号、原包与篡改后两次校验的输出，以换页符分隔：
    原包须通过，篡改后须未通过并定位到被改的那一条。"""
    parts = output.split("\f")
    if len(parts) != 3:
        return False
    seq, intact, tampered = parts
    return "校验通过" in intact and "校验未通过" in tampered and f"第 {seq} 条记录" in tampered


class Observer:
    """启动观测端并在后台收集事件：(收到时刻, 主题, 事件)。"""

    def __init__(self, compose: list[str], subjects: list[str]) -> None:
        cmd = [*compose, "run", "--rm", "--no-deps", "-T", "scenario-runner", *subjects]
        self._proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8"
        )
        self._events: list[tuple[float, str, dict[str, Any]]] = []
        self._cond = threading.Condition()
        self._ready = False
        threading.Thread(target=self._read, daemon=True).start()
        with self._cond:
            if not self._cond.wait_for(lambda: self._ready, timeout=TIMEOUT_S):
                raise RuntimeError("观测端未就绪")

    def _read(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            data = json.loads(line)
            with self._cond:
                if data.get("ready"):
                    self._ready = True
                else:
                    self._events.append((time.monotonic(), data["subject"], data["event"]))
                self._cond.notify_all()

    def wait(self, subject: str, match: dict[str, Any], since: float, until: float) -> float | None:
        """返回窗口内第一条匹配事件的收到时刻；超时为 None。"""

        def found() -> float | None:
            return next(
                (
                    t
                    for t, s, e in self._events
                    if since <= t <= until and s == subject and matches(e, match)
                ),
                None,
            )

        with self._cond:
            while (hit := found()) is None and time.monotonic() < until:
                self._cond.wait(timeout=max(0.0, until - time.monotonic()))
            return hit

    def latest(self, subject: str, match: dict[str, Any]) -> dict[str, Any] | None:
        """已收到的最近一条匹配事件。"""
        with self._cond:
            return next(
                (e for _, s, e in reversed(self._events) if s == subject and matches(e, match)),
                None,
            )

    def close(self) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.close()
        self._proc.wait(timeout=TIMEOUT_S)


class Runner:
    def __init__(self, compose: list[str], site_file: Path) -> None:
        self._compose = compose
        site = yaml.safe_load(site_file.read_text(encoding="utf-8"))
        self.streams = {c["id"]: c["stream"] for c in site["cameras"]}
        attack = yaml.safe_load((site_file.parent / "attack-sim.yaml").read_text(encoding="utf-8"))
        self.slow = attack["slow"]

    def compose(self, *args: str) -> str:
        return subprocess.run(
            [*self._compose, *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=TIMEOUT_S,
        ).stdout

    def setup(self, ttl_s: int | None) -> float:
        """准备开场，返回开场时刻（素材 0:00）。"""
        if ttl_s is not None:
            # 只覆盖本次演示的 TTL（FR-404）；再次 make demo-up 即恢复 Playbook 的默认值
            with tempfile.NamedTemporaryFile("w", suffix=".yaml") as override:
                yaml.safe_dump(
                    {
                        "services": {
                            "playbook-executor": {"environment": {"HYD_TTL_OVERRIDE_S": str(ttl_s)}}
                        }
                    },
                    override,
                )
                override.flush()
                self.compose(
                    "-f", override.name, "up", "-d", "--no-deps", "--wait", "playbook-executor"
                )
        # 行为模型从预先学好的基线快照开始（TK-115）：上一轮的攻击不留在状态里，全新环境也不必等学习期。
        # 先停下再删，避免窗口结束时又写回状态
        self.compose("stop", "correlator")
        self.compose(
            "run", "--rm", "--no-deps", "-T", "--entrypoint", "rm", "correlator", "-f",
            BEHAVIOR_STATE,
        )  # fmt: skip
        self.compose("up", "-d", "--no-deps", "--wait", "correlator")
        # 视觉引擎停到素材从头播放之后再启动：只看到本轮素材，参考画面取素材开头（D-090）；否则开场前看到的
        # 旧画面会留在重放历史里，素材播到同一位置时被判为重放（TK-114）。同时清除上次中断遗留的冻结
        self.compose("stop", "vision-engine")
        self.restart_media()
        self.compose("up", "-d", "--no-deps", "--wait", "vision-engine")
        # 引擎就绪后素材再从头播放，剧本时刻与素材时间线对齐，开场的攀爬等画面不因引擎启动而错过。
        # 启动期间看到的开头约 10 s 在 30 s 内重复出现，不足重放判定的最短间隔（FR-302）
        self.restart_media()
        return time.monotonic()

    def restart_media(self) -> None:
        self.compose("restart", "mediamtx")
        self.compose("up", "-d", "--no-deps", "--wait", "mediamtx")

    def act(self, do: dict[str, str], elapsed: float) -> str:
        """elapsed 为距开场的秒数，即素材当前的播放进度（setup 重启推流）。"""
        action = do["action"]
        if action == "start_attack":
            # 攻击方只在 attack-net 内打 rtsp-target（DP-09）；输出供 expect.attack 判断
            return self.compose("run", "--rm", "--no-deps", "-T", "attack-sim")
        if action == "start_slow_attack":
            # 低速模式：低于 HYD-NET-0001 阈值（FR-205），参数登记于 attack-sim.yaml
            return self.compose(
                "run", "--rm", "--no-deps", "-T",
                "-e", f"HYD_ATTEMPTS={self.slow['attempts']}",
                "-e", f"HYD_INTERVAL_S={self.slow['interval_s']}",
                "attack-sim",
            )  # fmt: skip
        path = self.streams[do["camera"]]
        if action == "freeze_camera":
            # 定格帧取自同一路当前画面（FR-307）
            self.compose(
                "exec", "-T", "mediamtx", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-rtsp_transport", "tcp", "-i", f"rtsp://127.0.0.1:8554/{path}",
                "-frames:v", "1", f"/tmp/freeze-{path}.png",
            )  # fmt: skip
            body = {"runOnInit": FREEZE_CMD.format(path=path)}
        elif action == "replay_camera":
            # 推流源切回此前片段（FR-302、D-065）
            body = {"runOnInit": STREAM_CMD.format(offset=max(0.0, elapsed - REPLAY_BACK_S))}
        else:
            # 从当前进度续播：回到默认推流会从头播放，与此前看到的画面重复，被判为重放
            body = {"runOnInit": STREAM_CMD.format(offset=elapsed)}
        self.compose(
            "exec", "-T", "mediamtx", "wget", "-q", "-O", "-",
            "--header", "Content-Type: application/json",
            "--post-data", json.dumps(body), MEDIAMTX_API + path,
        )  # fmt: skip
        return ""

    def package(self, incident_id: str) -> bytes:
        return subprocess.run(
            [*self._compose, "exec", "-T", "evidence-service", "python3", "-c", FETCH_PACKAGE,
             incident_id],
            check=True,
            stdout=subprocess.PIPE,
            timeout=TIMEOUT_S,
        ).stdout  # fmt: skip

    def verify_evidence(self, incident: dict[str, Any] | None) -> str:
        """演示第 11 步（TK-081）：按启动日志的公钥指纹校验关联事件的证据包，再解压、改第一条记录后校验目录。
        与演示者在界面导出后用 hyd-evidence verify 的操作相同。输出格式见 evidence_verified。"""
        if incident is None:
            return "未收到该摄像头的关联事件"
        fingerprints = FINGERPRINT.findall(
            self.compose("logs", "--no-log-prefix", "evidence-service")
        )
        if not fingerprints:
            return "evidence-service 日志中没有公钥指纹"
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / f"evidence-{incident['id']}.zip"
            package.write_bytes(self.package(incident["id"]))
            intact = self._verify(package, fingerprints[-1])
            extracted = Path(tmp) / "extracted"
            with zipfile.ZipFile(package) as z:
                z.extractall(extracted)
            chain = extracted / "chain.jsonl"
            first, *rest = chain.read_bytes().splitlines(keepends=True)
            record = json.loads(first)
            record["meta"] = {**record["meta"], "note": "篡改"}
            chain.write_bytes(
                json.dumps(record, ensure_ascii=False).encode() + b"\n" + b"".join(rest)
            )
            tampered = self._verify(extracted, fingerprints[-1])
        return f"{record['seq']}\f公钥指纹 {fingerprints[-1]}\n{intact}\f{tampered}"

    def _verify(self, package: Path, fingerprint: str) -> str:
        return subprocess.run(
            [*VERIFY_CMD, str(package), "--fingerprint", fingerprint],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=TIMEOUT_S,
        ).stdout


def run(scenario: Scenario, site_file: Path, compose: list[str], from_step: int) -> int:
    runner = Runner(compose, site_file)
    cameras = {s.do["camera"] for s in scenario.steps if s.do and "camera" in s.do}
    if cameras - runner.streams.keys():
        raise ValueError(f"站点未登记摄像头 {sorted(cameras - runner.streams.keys())}")
    expects = [s.expect for s in scenario.steps if s.expect and "subject" in s.expect]
    # 关联事件始终订阅：verify_evidence 按摄像头找到最近的关联事件
    observer = Observer(compose, sorted({e["subject"] for e in expects} | {INCIDENT}))
    failed = 0
    try:
        start = runner.setup(scenario.ttl_s)
        for i, at, step in timeline(scenario, from_step, start):
            time.sleep(max(0.0, at - time.monotonic()))
            stamp = f"{step.at_s // 60}:{step.at_s % 60:02d}"
            print(f"[{i}/{len(scenario.steps)}] {stamp} {step.name}", flush=True)
            if step.note:
                print(f"    提示：{step.note}", flush=True)
            try:
                if step.do and step.do["action"] == "verify_evidence":
                    camera = {"device_ids": step.do["camera"]}
                    output = runner.verify_evidence(observer.latest(INCIDENT, camera))
                else:
                    output = runner.act(step.do, time.monotonic() - start) if step.do else ""
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                # 记为本步失败并继续：后续的恢复画面等步骤照常执行，最后仍打印汇总
                failed += 1
                print(f"    失败：动作出错：{e}", flush=True)
                if e.output:
                    print(e.output, flush=True)
                continue
            if step.expect is None:
                continue
            if "attack" in step.expect:
                ok, detail = attack_blocked(output), "攻击连接全部失败"
            elif "evidence" in step.expect:
                ok, detail = evidence_verified(output), "原包校验通过，篡改后定位到被改记录"
            else:
                hit = observer.wait(
                    step.expect["subject"],
                    step.expect.get("match", {}),
                    at,
                    at + step.expect["within_s"],
                )
                if step.expect.get("absent"):
                    ok = hit is None
                    waited = f"{hit - at:.1f} s 收到，不应出现" if hit else "未出现"
                else:
                    ok = hit is not None
                    waited = (
                        f"{hit - at:.1f} s 收到" if hit else f"{step.expect['within_s']} s 内未收到"
                    )
                detail = f"{step.expect['subject']} {waited}"
            failed += not ok
            print(f"    {'通过' if ok else '失败'}：{detail}", flush=True)
            if not ok and output:
                print(output, flush=True)
    finally:
        observer.close()
    total = len(scenario.steps) - from_step + 1
    print(f"剧本 {scenario.id}：{total - failed}/{total} 步通过", flush=True)
    return 1 if failed else 0


def parse_args(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    """以 `--` 分隔：前面是本脚本的参数（顺序不限），后面原样是 docker compose 命令。"""
    cut = argv.index("--") if "--" in argv else len(argv)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scenario", type=Path)
    parser.add_argument("--from-step", type=int, default=1)
    return parser.parse_args(argv[:cut]), argv[cut + 1 :]


def main() -> int:
    args, compose = parse_args(sys.argv[1:])
    scenario = load(args.scenario)
    if not 1 <= args.from_step <= len(scenario.steps):
        sys.exit(f"--from-step 须在 1～{len(scenario.steps)}")
    # 站点配置与剧本同目录（demo/scenarios/），不依赖当前目录
    return run(scenario, args.scenario.parent / "site.yaml", compose, args.from_step)


if __name__ == "__main__":
    sys.exit(main())
