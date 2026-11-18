"""录屏用的攻击演示（make attack-show）：分步骤讲清楚红方在做什么，只攻击自建靶机（DP-09、C-SEC-11）。

用法：python tools/dev/attack_show.py [--yes] -- <docker compose 命令及全局参数>

  准备    复位演示环境（解除封禁、清空去重期、恢复画面）；画面刚被篡改过时先预热，然后等待按回车开始
  第一步  锁定目标：演示摄像头 cam-07 的 RTSP 服务
  第二步  口令爆破：轮换常见弱口令逐个尝试，慧眼盾封禁后余下的尝试连接被切断
  第三步  画面篡改：把摄像头画面换成 45 秒前的录像（重放）
  结束    提示去控制台查看研判过程；make demo-reset 复位

攻击流量与画面篡改与 make attack、make tamper 相同，参数登记于 demo/scenarios/attack-sim.yaml 的 show。
"""

import argparse
import contextlib
import io
import re
import subprocess
import sys
import time
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import redteam  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TARGET = (
    "rtsp://172.30.0.12:8554/cam"  # rtsp-target 在 attack-net 中的固定地址，登记为演示摄像头 cam-07
)
CAMERA = "cam-02"  # 画面篡改作用的调试素材路径，即 cam-07 的画面源
WARMUP_S = 60  # 恢复画面后须先正常播放：重放回退 45 s + 比较窗口 10 s（Makefile demo-story）
ATTEMPT = re.compile(r"attempt (\d+): ([^:]+):(\S+) -> (.*)")
COLOR = sys.stdout.isatty()


def paint(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if COLOR else text


def step(title: str) -> None:
    print()
    print(paint(f"▌{title}", "1;36"))


def attempt_line(line: str) -> tuple[str, bool] | None:
    """attack-sim 的一行输出 → (显示文本, 是否被切断)；不是尝试记录时为 None。"""
    m = ATTEMPT.match(line.strip())
    if m is None:
        return None
    n, user, password, status = m.groups()
    blocked = status.startswith("connection failed")
    if blocked:
        result = paint("✗ 连接被切断", "1;31")
    elif " 401" in status:
        result = paint("✗ 401 口令错误", "33")
    else:
        result = status
    return f"  第 {int(n):>2} 次   {user} / {password:<10} {result}", blocked


def bruteforce(compose: redteam.Compose, params: dict) -> None:
    options = [
        "-e", f"HYD_ATTEMPTS={params['attempts']}",
        "-e", f"HYD_INTERVAL_S={params['interval_s']}",
        "-e", f"HYD_WORDLIST={','.join(str(w) for w in params['wordlist'])}",
    ]  # fmt: skip
    command = [*compose._compose, "run", "--rm", "--no-deps", "-T", *options, "attack-sim"]
    announced = False
    with subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
    ) as proc:
        assert proc.stdout is not None
        for line in proc.stdout:
            parsed = attempt_line(line)
            if parsed is None:
                continue
            text, blocked = parsed
            print(text, flush=True)
            if blocked and not announced:
                announced = True
                print(paint("  ⛔ 攻击源 172.30.0.100 已被慧眼盾封禁，后续尝试全部被切断", "1;31"))
    if proc.returncode != 0:
        print(paint(f"attack-sim 未能运行（退出码 {proc.returncode}）", "1;31"), file=sys.stderr)


def ensure_capture(compose: redteam.Compose) -> None:
    """探针的抓包镜像口在宿主重启后消失（capture-tap 只执行一次即退出，网卡配置不持久），此时攻击检测不到：
    缺失即重跑 capture-tap。只检查默认的演示抓包源（hyd-attack 网桥上的 hyd-span）"""
    if subprocess.run(["ip", "link", "show", "hyd-span"], capture_output=True).returncode == 0:
        return
    print(paint("  抓包镜像口不在（宿主重启过？），正在恢复，否则探针看不到攻击流量", "33"))
    res = compose.call("up", "-d", "--no-deps", "capture-tap")
    if res.returncode != 0:
        print(res.stdout, file=sys.stderr)
        raise SystemExit("capture-tap 未能运行，攻击将检测不到")
    for _ in range(20):
        if subprocess.run(["ip", "link", "show", "hyd-span"], capture_output=True).returncode == 0:
            return
        time.sleep(0.5)
    raise SystemExit("抓包镜像口仍未就绪，攻击将检测不到")


def countdown(seconds: int, message: str) -> None:
    for left in range(seconds, 0, -1):
        print(f"\r{message}：还剩 {left:>3} s", end="", flush=True)
        time.sleep(1)
    print(f"\r{message}：完成{' ' * 12}")


def main() -> int:
    argv = sys.argv[1:]
    split = argv.index("--") if "--" in argv else len(argv)
    parser = argparse.ArgumentParser(prog="attack-show")
    parser.add_argument("--yes", action="store_true", help="不等待回车，直接开始")
    args = parser.parse_args(argv[:split])
    compose = redteam.Compose(argv[split + 1 :])
    params = yaml.safe_load(redteam.ATTACK_PARAMS.read_text(encoding="utf-8"))["show"]

    print(paint("慧眼盾 · 红方攻击演示（只攻击自建靶机）", "1"))
    step("准备：复位演示环境")
    tampered = any(
        '"tampered": true' in f.read_text() for f in redteam.STATE_DIR.glob("hyd-tamper-*.json")
    )
    ensure_capture(compose)
    subprocess.run(["make", "--no-print-directory", "-s", "demo-reset"], cwd=ROOT, check=True)
    if tampered:
        countdown(WARMUP_S, "画面预热（识别引擎须先看过将被重放的画面）")
    if not args.yes:
        input(paint("准备完成。开始录屏后按回车开始攻击演示…", "1;32"))
    # 再清一次去重期：预热期间上一轮的余波可能先拼出跨域事件、压下本轮（make demo-story）
    compose.call("exec", "-T", "api-server", "hyd-api", "demo-reset")

    step("第一步：锁定目标")
    print(f"  目标：演示摄像头 cam-07   {TARGET}")
    print("  方式：RTSP 认证接口，用常见弱口令逐个尝试")
    time.sleep(2)

    step(f"第二步：口令爆破（{params['attempts']} 次，每 {params['interval_s']} s 一次）")
    bruteforce(compose, params)
    time.sleep(3)

    step("第三步：篡改画面（重放攻击）")
    with contextlib.redirect_stdout(io.StringIO()):
        redteam.tamper(compose, "replay", CAMERA)
    print(f"  已把 cam-07 的实时画面换成 {redteam.REPLAY_BACK_S} 秒前的录像，掩盖现场的真实情况")

    step("攻击结束")
    print('  到控制台查看：告警栏的跨域事件、右侧"事件研判"面板中 AI 的逐步调查过程')
    print("  约 15 秒后识别出画面重放；演示结束后执行 make demo-reset 复位")
    return 0


if __name__ == "__main__":
    sys.exit(main())
