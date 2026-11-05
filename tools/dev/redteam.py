"""红方手动命令（D-105，07 §7）：演示与走查时由队员现场执行，只制造真实流量或切换画面源，不发布任何事件。

用法：python tools/dev/redteam.py <命令> [参数] -- <docker compose 命令及全局参数>
  attack                     attack-sim 对自建靶机 rtsp-target 连续认证尝试（触发 HYD-NET-0001）
  attack-slow                低速尝试，低于规则阈值，由设备行为模型发现（FR-205）
  tamper freeze <摄像头>      把该路调试素材的画面源切换为当前画面的定格帧（FR-301）
  tamper replay <摄像头>      切回约 2 分钟前的片段（FR-302）
  tamper restore <摄像头>     恢复为按原时间线继续播放

画面篡改只作用于 mediamtx 推流的调试素材（路径名即摄像头编号）；素材的真实播放进度记在
/tmp/hyd-tamper-<摄像头>.json，恢复时从原时间线的当前位置续播，不与看过的画面重复（否则被判为重放）。
"""

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import yaml

TIMEOUT_S = 120  # 单条 docker compose 命令的上限（CD-04）
ATTACK_PARAMS = Path(__file__).resolve().parents[2] / "demo/scenarios/attack-sim.yaml"
# 重放 2 分钟前的片段：须在 FR-302 的 30～180 s 内
REPLAY_BACK_S = 120
MEDIAMTX_API = "http://127.0.0.1:9997/v3"  # 只监听容器内
STATE_DIR = Path("/tmp")
DONE = {"freeze": "画面已定格", "replay": "已切回约 2 分钟前的片段", "restore": "已恢复"}
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


def position(state: dict[str, float], now: float, duration: float) -> float:
    """素材原时间线的当前播放秒数：篡改期间原时间线照常前进，循环播放。"""
    return (state["base"] + now - state["since"]) % duration


def source_for(action: str, path: str, pos: float, duration: float) -> str:
    """mediamtx 路径的推流命令。"""
    if action == "freeze":
        return FREEZE_CMD.format(path=path)
    if action == "replay":
        return STREAM_CMD.format(offset=(pos - REPLAY_BACK_S) % duration)
    return STREAM_CMD.format(offset=pos)


class Compose:
    def __init__(self, compose: list[str]) -> None:
        self._compose = compose

    def run(self, *args: str, check: bool = True) -> str:
        return subprocess.run(
            [*self._compose, *args],
            check=check,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=TIMEOUT_S,
        ).stdout

    def mediamtx(self, *args: str) -> str:
        return self.run("exec", "-T", "mediamtx", *args)

    def started(self, service: str) -> float:
        """服务容器的启动时刻：mediamtx 重启后素材从头播放，记下的进度作废。"""
        cid = self.run("ps", "-q", service).strip()
        out = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.StartedAt}}", cid],
            check=True, stdout=subprocess.PIPE, text=True, timeout=TIMEOUT_S,
        ).stdout.strip()  # fmt: skip
        return datetime.fromisoformat(out[:19] + "+00:00").timestamp()  # 精确到秒即可


def attack(compose: Compose, slow: bool) -> int:
    """攻击方只在 attack-net 内打 rtsp-target（DP-09、C-SEC-11）；参数登记于 attack-sim.yaml。"""
    env: list[str] = []
    if slow:
        params = yaml.safe_load(ATTACK_PARAMS.read_text(encoding="utf-8"))["slow"]
        env = [
            "-e",
            f"HYD_ATTEMPTS={params['attempts']}",
            "-e",
            f"HYD_INTERVAL_S={params['interval_s']}",
        ]
    out = compose.run("run", "--rm", "--no-deps", "-T", *env, "attack-sim", check=False)
    print(out, end="")
    return 0


def tamper(compose: Compose, action: str, camera: str) -> int:
    path = camera  # 调试素材的 mediamtx 路径名即摄像头编号（D-101）
    info = json.loads(compose.mediamtx("wget", "-qO-", f"{MEDIAMTX_API}/paths/get/{path}"))
    duration = float(
        compose.mediamtx(
            "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
            f"/media/{path}.mp4",
        ).strip()
    )  # fmt: skip
    now = time.time()
    state_file = STATE_DIR / f"hyd-tamper-{camera}.json"
    state = json.loads(state_file.read_text()) if state_file.is_file() else None
    if state is None or state["since"] < compose.started("mediamtx"):
        # 首次篡改：原时间线从该路径开始推流算起
        ready = datetime.fromisoformat(info["readyTime"]).timestamp()
        state = {"base": now - ready, "since": now}
        state_file.write_text(json.dumps(state))
    pos = position(state, now, duration)
    if action == "freeze":
        # 定格帧取自同一路当前画面（FR-307）
        compose.mediamtx(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-rtsp_transport", "tcp",
            "-i", f"rtsp://127.0.0.1:8554/{path}", "-frames:v", "1", f"/tmp/freeze-{path}.png",
        )  # fmt: skip
    body = {"runOnInit": source_for(action, path, pos, duration)}
    compose.mediamtx(
        "wget", "-q", "-O", "-", "--header", "Content-Type: application/json",
        "--post-data", json.dumps(body), f"{MEDIAMTX_API}/config/paths/replace/{path}",
    )  # fmt: skip
    if action == "restore":
        state_file.unlink(missing_ok=True)
    print(f"{camera}：{DONE[action]}")
    return 0


def main() -> int:
    argv = sys.argv[1:]
    split = argv.index("--") if "--" in argv else len(argv)
    parser = argparse.ArgumentParser(prog="redteam")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("attack")
    commands.add_parser("attack-slow")
    t = commands.add_parser("tamper")
    t.add_argument("action", choices=["freeze", "replay", "restore"])
    t.add_argument("camera")
    args = parser.parse_args(argv[:split])
    compose = Compose(argv[split + 1 :])
    if args.command == "tamper":
        return tamper(compose, args.action, args.camera)
    return attack(compose, slow=args.command == "attack-slow")


if __name__ == "__main__":
    sys.exit(main())
