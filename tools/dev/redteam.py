"""红方手动命令（D-105，ops.md §4.1）：演示与走查时由队员现场执行，只制造真实流量或切换画面源，不发布任何事件。

用法：python tools/dev/redteam.py <命令> [参数] -- <docker compose 命令及全局参数>
  attack                     attack-sim 对自建靶机 rtsp-target 连续认证尝试（触发 HYD-NET-0001）
  attack-slow                低速尝试，低于规则阈值，由设备行为模型发现（FR-205）
  attack-hijack              attack-sim 对 rtsp-target 发推流声明，企图顶替设备画面（触发 HYD-NET-0002）
  tamper freeze <摄像头>      把该路调试素材的画面源切换为当前画面的定格帧（FR-301）
  tamper replay <摄像头>      切回约 45 秒前的片段（FR-302）
  tamper restore <摄像头>     切回原始节目，回到它的当前进度

画面篡改只作用于 mediamtx 推流的调试素材（路径名即摄像头编号）。原始节目 src-<摄像头> 从素材第 0 秒起循环推流、
从不跳转（mediamtx.yml），摄像头路径平时转发它：篡改时把摄像头路径换成从素材某处起播，恢复时切回转发。
原始节目的进度由它的推流时刻推算，不受篡改影响。/tmp/hyd-tamper-<摄像头>.json 只记是否处于篡改中，
供 make demo-reset 判断哪些路需要恢复。
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
# 重放约 45 秒前的片段：须在 FR-302 的 30～180 s 内。越短，恢复后需要的预热越短（识别引擎须看过被重放的片段：
# 回退秒数 + 10 s 比较窗口），make demo-story 的预热据此取 60 s
REPLAY_BACK_S = 45
MEDIAMTX_API = "http://127.0.0.1:9997/v3"  # 只监听容器内
STATE_DIR = Path("/tmp")
DONE = {
    "freeze": "画面已定格",
    "replay": f"已切回约 {REPLAY_BACK_S} 秒前的片段",
    "restore": "已恢复",
}
# 定格帧推流：H.264 全帧内编码、固定量化，解码后逐帧相同（D-080）；$RTSP_PORT、$MTX_PATH 由 mediamtx 展开
FREEZE_CMD = (
    "ffmpeg -hide_banner -loglevel error -re -loop 1 -framerate 25 -i /tmp/freeze-{path}.png "
    "-c:v libx264 -preset ultrafast -tune stillimage -x264-params keyint=1 -qp 20 -pix_fmt yuv420p "
    "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)
# 从素材的指定秒数起循环推流（直接复制编码，从最近的关键帧开始，素材关键帧间隔 ≤ 2 s）
STREAM_CMD = (
    "ffmpeg -hide_banner -loglevel error -re -ss {offset:.0f} -stream_loop -1 -i /media/{path}.mp4 "
    "-c copy -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)


def program_position(now: float, program_ready: float, duration: float) -> float:
    """原始节目的当前播放秒数：从推流时刻起由素材第 0 秒循环播放、从不跳转。"""
    return (now - program_ready) % duration


def path_config(action: str, path: str, pos: float, duration: float) -> dict[str, str | bool]:
    """摄像头路径的整份配置（config/paths/replace 整体替换）：恢复为转发原始节目，篡改为容器内推流。"""
    if action == "restore":
        return {"source": f"rtsp://127.0.0.1:8554/src-{path}", "runOnInit": ""}
    if action == "freeze":
        command = FREEZE_CMD.format(path=path)
    else:
        command = STREAM_CMD.format(path=path, offset=(pos - REPLAY_BACK_S) % duration)
    return {"source": "publisher", "runOnInit": command, "runOnInitRestart": True}


class Compose:
    def __init__(self, compose: list[str]) -> None:
        self._compose = compose

    def call(self, *args: str) -> subprocess.CompletedProcess[str]:
        """执行并返回退出码与输出，不因非零退出码报错。"""
        return subprocess.run(
            [*self._compose, *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=TIMEOUT_S,
        )

    def run(self, *args: str) -> str:
        res = self.call(*args)
        res.check_returncode()
        return res.stdout

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


def attack(compose: Compose, slow: bool = False, hijack: bool = False) -> int:
    """攻击方只在 attack-net 内打 rtsp-target（DP-09、C-SEC-11）；参数登记于 attack-sim.yaml。"""
    options: list[str] = []
    if slow:
        params = yaml.safe_load(ATTACK_PARAMS.read_text(encoding="utf-8"))["slow"]
        options = [
            "-e",
            f"HYD_ATTEMPTS={params['attempts']}",
            "-e",
            f"HYD_INTERVAL_S={params['interval_s']}",
        ]
    elif hijack:
        params = yaml.safe_load(ATTACK_PARAMS.read_text(encoding="utf-8"))["hijack"]
        options = [
            "--entrypoint",
            "rtsp-hijack",
            "-e",
            f"HYD_HIJACK_ATTEMPTS={params['attempts']}",
            "-e",
            f"HYD_HIJACK_INTERVAL_S={params['interval_s']}",
        ]
    res = compose.call("run", "--rm", "--no-deps", "-T", *options, "attack-sim")
    print(res.stdout, end="")
    if res.returncode != 0:
        # attack-sim 跑完总是返回 0（尝试被拒、连接被封禁都算跑完）：非零说明容器没能运行
        print(f"attack-sim 未能运行（退出码 {res.returncode}），没有发出攻击流量", file=sys.stderr)
    return res.returncode


def tamper(compose: Compose, action: str, camera: str) -> int:
    path = camera  # 调试素材的 mediamtx 路径名即摄像头编号（D-101）
    program = json.loads(compose.mediamtx("wget", "-qO-", f"{MEDIAMTX_API}/paths/get/src-{path}"))
    duration = float(
        compose.mediamtx(
            "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
            f"/media/{path}.mp4",
        ).strip()
    )  # fmt: skip
    ready = datetime.fromisoformat(program["readyTime"]).timestamp()
    pos = program_position(time.time(), ready, duration)
    if action == "freeze":
        # 定格帧取自同一路当前画面（FR-307）
        compose.mediamtx(
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-rtsp_transport", "tcp",
            "-i", f"rtsp://127.0.0.1:8554/{path}", "-frames:v", "1", f"/tmp/freeze-{path}.png",
        )  # fmt: skip
    body = path_config(action, path, pos, duration)
    compose.mediamtx(
        "wget", "-q", "-O", "-", "--header", "Content-Type: application/json",
        "--post-data", json.dumps(body), f"{MEDIAMTX_API}/config/paths/replace/{path}",
    )  # fmt: skip
    (STATE_DIR / f"hyd-tamper-{camera}.json").write_text(
        json.dumps({"tampered": action != "restore"})
    )
    print(f"{camera}：{DONE[action]}")
    return 0


def main() -> int:
    argv = sys.argv[1:]
    split = argv.index("--") if "--" in argv else len(argv)
    parser = argparse.ArgumentParser(prog="redteam")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("attack")
    commands.add_parser("attack-slow")
    commands.add_parser("attack-hijack")
    t = commands.add_parser("tamper")
    t.add_argument("action", choices=["freeze", "replay", "restore"])
    t.add_argument("camera")
    args = parser.parse_args(argv[:split])
    compose = Compose(argv[split + 1 :])
    if args.command == "tamper":
        return tamper(compose, args.action, args.camera)
    return attack(
        compose, slow=args.command == "attack-slow", hijack=args.command == "attack-hijack"
    )


if __name__ == "__main__":
    sys.exit(main())
