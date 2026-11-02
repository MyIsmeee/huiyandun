"""scenario-runner（TK-100）：剧本解析与校验、事件匹配、攻击结果判定。不启动容器。"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scenario_runner.py"
_spec = importlib.util.spec_from_file_location("scenario_runner", SCRIPT)
assert _spec and _spec.loader
runner = importlib.util.module_from_spec(_spec)
sys.modules["scenario_runner"] = runner  # dataclass 定义时按模块名查找所在模块
_spec.loader.exec_module(runner)
attack_blocked, load, matches, parse_args, parse_at, timeline = (
    runner.attack_blocked,
    runner.load,
    runner.matches,
    runner.parse_args,
    runner.parse_at,
    runner.timeline,
)

ROOT = Path(__file__).resolve().parents[3]


def write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "s.yaml"
    path.write_text(text, encoding="utf-8")
    return path


class RecordingRunner(runner.Runner):
    def __init__(self) -> None:
        self.streams = {"cam-02": "cam-02"}
        self.calls: list[tuple[str, ...]] = []

    def compose(self, *args: str) -> str:
        self.calls.append(args)
        return ""


def pushed(r: RecordingRunner) -> str:
    """最后一次替换推流配置的 runOnInit。"""
    return json.loads(r.calls[-1][r.calls[-1].index("--post-data") + 1])["runOnInit"]


def test_replay_pushes_clip_from_2_minutes_ago() -> None:
    r = RecordingRunner()

    r.act({"action": "replay_camera", "camera": "cam-02"}, elapsed=150)

    assert "-ss 30 " in pushed(r) and "/media/$MTX_PATH.mp4" in pushed(r)


def test_restore_continues_from_current_position() -> None:
    """从头播放会与 2 分钟前看到的画面重复，被判为重放（FR-302）。"""
    r = RecordingRunner()

    r.act({"action": "restore_camera", "camera": "cam-02"}, elapsed=185.4)

    assert "-ss 185 " in pushed(r)


def test_setup_starts_vision_after_media_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    """视觉引擎停到素材从头播放之后才启动，只看到本轮素材（D-090）；就绪后素材再从头播放一次，开场取这次
    推流就绪的时刻，引擎启动期间已在看画面（复核阻断 2）。"""
    clock = iter(range(100))
    monkeypatch.setattr(runner.time, "monotonic", lambda: next(clock))
    r = RecordingRunner()

    start = r.setup(ttl_s=None)

    assert [(c[0], c[-1]) for c in r.calls] == [
        ("stop", "vision-engine"),
        ("restart", "mediamtx"),
        ("up", "mediamtx"),
        ("up", "vision-engine"),
        ("restart", "mediamtx"),
        ("up", "mediamtx"),
    ]
    assert start == 0  # 第二次推流就绪后读取的第一个时刻


def test_main_scenario_loads() -> None:
    scenario = load(ROOT / "demo/scenarios/main.yaml")

    assert scenario.ttl_s == 150  # FR-404
    assert [s.at_s for s in scenario.steps] == sorted(s.at_s for s in scenario.steps)
    assert scenario.steps[-1].at_s + scenario.steps[-1].expect["within_s"] <= 6 * 60  # DM-13


@pytest.mark.parametrize(("text", "seconds"), [("0:00", 0), ("1:20", 80), ("12:05", 725)])
def test_parse_at(text: str, seconds: int) -> None:
    assert parse_at(text) == seconds


@pytest.mark.parametrize("text", ["80", "1:60", "a:10", "-1:00"])
def test_parse_at_rejects_malformed(text: str) -> None:
    with pytest.raises(ValueError, match="分:秒"):
        parse_at(text)


@pytest.mark.parametrize(
    ("step", "error"),
    [
        ('{ name: x, at: "0:10", do: { action: replay_pcap } }', "未知动作"),
        ('{ name: x, at: "0:10", do: { action: freeze_camera } }', "须且只须有 camera"),
        ('{ name: x, at: "0:10", do: { action: start_attack, target: a, camera: b } }', "须且只须"),
        ('{ name: x, at: "0:10", expect: { subject: a } }', "subject 与 within_s"),
        ('{ name: x, at: "0:10", expect: { subject: a, within_s: 5, mtach: {} } }', "未知字段"),
        ('{ name: x, at: "0:10", expect: { attack: allowed } }', "只能为 blocked"),
        ('{ name: x, at: "0:10", expect: { attack: blocked } }', "须与 start_attack 同一步"),
        ('{ name: x, at: "0:10", wait: 3 }', "未知字段"),
    ],
)
def test_invalid_step_rejected(tmp_path: Path, step: str, error: str) -> None:
    with pytest.raises(ValueError, match=error):
        load(write(tmp_path, f"id: t\nsteps:\n  - {step}\n"))


def test_unknown_override_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="未知字段"):
        load(write(tmp_path, "id: t\noverrides: { ttl: 1 }\nsteps: []\n"))


def test_resume_keeps_steps_aligned_with_media(tmp_path: Path) -> None:
    """续跑（FROM_STEP）：开场仍对应素材 0:00，第 N 步按原时刻到点，前面的步骤不执行。"""
    steps = '  - { name: a, at: "0:00" }\n  - { name: b, at: "0:20" }\n'
    scenario = load(write(tmp_path, f"id: t\nsteps:\n{steps}"))

    assert [(i, at, s.name) for i, at, s in timeline(scenario, 2, 100.0)] == [(2, 120.0, "b")]


def test_from_step_after_scenario_not_swallowed_by_compose() -> None:
    """Makefile 把 --from-step 放在剧本之后、`--` 之前（05 §5.3）。"""
    args, compose = parse_args(
        ["main.yaml", "--from-step", "3", "--", "docker", "compose", "-f", "c.yaml"]
    )

    assert (args.scenario, args.from_step) == (Path("main.yaml"), 3)
    assert compose == ["docker", "compose", "-f", "c.yaml"]


def test_matches_scalar_list_field_and_options() -> None:
    event = {"camera_id": "cam-02", "device_ids": ["cam-01", "cam-02"], "state": "contained"}

    assert matches(event, {"camera_id": "cam-02"})
    assert matches(event, {"device_ids": "cam-02"})  # 事件字段为数组：包含即可
    assert matches(event, {"state": ["verifying", "contained"]})  # 期望值为数组：取其一
    assert not matches(event, {"camera_id": "cam-01"})
    assert not matches(event, {"missing": "x"})


def test_attack_blocked_only_when_every_attempt_fails() -> None:
    failed = "attempt 1: connection failed: timed out\nattempt 2: connection failed: timed out\n"
    mixed = failed + "attempt 3: RTSP/1.0 401 Unauthorized\n"

    assert attack_blocked(failed + "rtsp-bruteforce: 0/2 denied by rtsp://rtsp-target:8554/cam")
    assert not attack_blocked(mixed)
    assert not attack_blocked("")  # 未运行任何尝试不算封禁生效
