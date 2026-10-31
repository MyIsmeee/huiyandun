"""scenario-runner（TK-100、DM-11）：按剧本时间轴执行动作，并断言每步的预期事件。

用法：python tools/dev/scenario_runner.py <剧本.yaml> [--from-step N] -- <docker compose 命令及全局参数>
动作经 docker compose 在宿主机执行；事件由 scenario-runner 服务在 core-net 内订阅、逐行写到标准输出。
任一步失败时退出码为 1。设计见 HYD 设计文档 100-demo-run.md。
"""

import argparse
import json
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

ACTIONS = {"start_attack": "target", "freeze_camera": "camera", "restore_camera": "camera"}
STEP_KEYS = {"name", "at", "do", "expect", "note"}
EVENT_EXPECT_KEYS = {"subject", "match", "within_s"}
TIMEOUT_S = 120  # 单条 docker compose 命令的上限（CD-04）
# 定格帧推流：H.264 全帧内编码、固定量化，解码后逐帧相同（D-080）；$RTSP_PORT、$MTX_PATH 由 mediamtx 展开
FREEZE_CMD = (
    "ffmpeg -hide_banner -loglevel error -re -loop 1 -framerate 25 -i /tmp/freeze-{path}.png "
    "-c:v libx264 -preset ultrafast -tune stillimage -x264-params keyint=1 -qp 20 -pix_fmt yuv420p "
    "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)
MEDIAMTX_API = "http://127.0.0.1:9997/v3/config/paths/replace/"  # 只监听容器内


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
        if expect is not None and set(expect) != {"attack"}:
            _check_keys(where, expect, EVENT_EXPECT_KEYS)
            if not {"subject", "within_s"} <= set(expect):
                raise ValueError(f"{where}：expect 须有 subject 与 within_s")
        if expect is not None and expect.get("attack", "blocked") != "blocked":
            raise ValueError(f"{where}：expect.attack 只能为 blocked")
        if expect is not None and "attack" in expect and (do or {}).get("action") != "start_attack":
            raise ValueError(f"{where}：expect.attack 须与 start_attack 同一步")
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

    def close(self) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.close()
        self._proc.wait(timeout=TIMEOUT_S)


class Runner:
    def __init__(self, compose: list[str], site_file: Path) -> None:
        self._compose = compose
        site = yaml.safe_load(site_file.read_text(encoding="utf-8"))
        self.streams = {c["id"]: c["stream"] for c in site["cameras"]}

    def compose(self, *args: str) -> str:
        return subprocess.run(
            [*self._compose, *args],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=TIMEOUT_S,
        ).stdout

    def setup(self, ttl_s: int | None) -> None:
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
        # 各路素材从头播放，剧本时刻与素材时间线对齐；同时清除上次中断遗留的冻结
        self.compose("restart", "mediamtx")
        self.compose("up", "-d", "--no-deps", "--wait", "mediamtx")

    def act(self, do: dict[str, str]) -> str:
        action = do["action"]
        if action == "start_attack":
            # 攻击方只在 attack-net 内打 rtsp-target（DP-09）；输出供 expect.attack 判断
            return self.compose("run", "--rm", "--no-deps", "-T", "attack-sim")
        path = self.streams[do["camera"]]
        if action == "freeze_camera":
            # 定格帧取自同一路当前画面（FR-307）
            self.compose(
                "exec", "-T", "mediamtx", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-rtsp_transport", "tcp", "-i", f"rtsp://127.0.0.1:8554/{path}",
                "-frames:v", "1", f"/tmp/freeze-{path}.png",
            )  # fmt: skip
            body = {"runOnInit": FREEZE_CMD.format(path=path)}
        else:
            body = {}  # 回到 mediamtx.yml 的默认推流
        self.compose(
            "exec", "-T", "mediamtx", "wget", "-q", "-O", "-",
            "--header", "Content-Type: application/json",
            "--post-data", json.dumps(body), MEDIAMTX_API + path,
        )  # fmt: skip
        return ""


def run(scenario: Scenario, site_file: Path, compose: list[str], from_step: int) -> int:
    runner = Runner(compose, site_file)
    cameras = {s.do["camera"] for s in scenario.steps if s.do and "camera" in s.do}
    if cameras - runner.streams.keys():
        raise ValueError(f"站点未登记摄像头 {sorted(cameras - runner.streams.keys())}")
    expects = [s.expect for s in scenario.steps if s.expect and "subject" in s.expect]
    observer = Observer(compose, sorted({e["subject"] for e in expects}))
    failed = 0
    try:
        runner.setup(scenario.ttl_s)
        for i, at, step in timeline(scenario, from_step, time.monotonic()):
            time.sleep(max(0.0, at - time.monotonic()))
            stamp = f"{step.at_s // 60}:{step.at_s % 60:02d}"
            print(f"[{i}/{len(scenario.steps)}] {stamp} {step.name}", flush=True)
            if step.note:
                print(f"    提示：{step.note}", flush=True)
            try:
                output = runner.act(step.do) if step.do else ""
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
            else:
                hit = observer.wait(
                    step.expect["subject"],
                    step.expect.get("match", {}),
                    at,
                    at + step.expect["within_s"],
                )
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
