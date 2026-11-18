"""测试五：攻防闭环端到端测试（会真实发起攻击并处置，结束后自动复位）。

流程与断言：
  0. 复位演示环境（make demo-reset），订阅控制台实时推送
  1. 红方对自建靶机 cam-11 弱口令爆破（make attack）
       → 探针告警 auth_bruteforce → 关联事件 HYD-NET-0101 → 自动封禁攻击源（处置执行 contained）
  2. 红方把画面换成约 45 秒前的录像（make tamper ACTION=replay）
       → 跨域关联事件 HYD-X-0001（网络爆破 + 画面重放合并为同一起攻击）
  3. 导出证据包，离线校验通过；改动包内一条记录后再校验，必须报篡改
  4. 一键回滚封禁 → 处置执行 rolled_back
  5. 复位（make demo-reset），画面与封禁恢复原状
每步打印耗时（从攻击发起算起）。

用法：uv run --all-packages python demo/tests/attack_e2e.py [--no-replay] [--keep]
  --no-replay  只测爆破与封禁（约 30 秒），不篡改画面
  --keep       结束时不复位，保留告警与封禁给控制台展示
账号须为 operator 或 admin（回滚与导出证据要求）；取 HYD_USER、HYD_PASSWORD，未设置时交互输入。
注意：会在控制台告警栏留下本次测试的告警，正式演示前请在控制台"清空告警"。
"""

import argparse
import json
import re
import subprocess
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BASE,
    Listener,
    Report,
    credentials,
    info,
    login_or_exit,
    paint,
    title,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "out"
TARGET_IP = (
    "172.30.0.12"  # 自建靶机 rtsp-target 的固定地址；它在登记表中的编号按此查找（编号只增不复用）
)
CAMERA = "cam-02"  # 靶机画面源（调试素材路径）
WARMUP_S = 60  # 画面刚被篡改过时，重放前须正常播放：回退 45 s + 比较窗口 10 s
EVIDENCE = "huiyandun-evidence-service-1"


def run(cmd: list[str], label: str, timeout: int = 180) -> bool:
    """执行命令并把输出缩进显示。"""
    info(f"$ {' '.join(cmd)}")
    proc = subprocess.run(
        cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout
    )
    for line in proc.stdout.splitlines():
        if line.strip() and not line.strip().startswith(("make[", "docker compose", "Container ")):
            print(paint(f"    │ {line}", "2"))
    if proc.returncode != 0:
        print(paint(f"  {label}失败（退出码 {proc.returncode}）", "1;31"))
    return proc.returncode == 0


def since(t0: float, t: float) -> str:
    return f"攻击发起后 {t - t0:.1f} s"


def fingerprint() -> str | None:
    logs = subprocess.run(["docker", "logs", EVIDENCE], capture_output=True, text=True, timeout=30)
    found = re.findall(
        r'"public_key_fingerprint": "(sha256:[0-9a-f]{64})"', logs.stdout + logs.stderr
    )
    return found[-1] if found else None


def verify(path: Path, fp: str) -> tuple[int, str]:
    proc = subprocess.run(
        ["uv", "run", "--all-packages", "hyd-evidence", "verify", str(path), "--fingerprint", fp],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def tamper_copy(package: Path) -> Path:
    """解压证据包，改动哈希链第一条记录的 meta，模拟有人事后篡改证据。"""
    target = OUT / f"{package.stem}-tampered"
    if target.exists():
        subprocess.run(["rm", "-rf", str(target)], check=True)
    with zipfile.ZipFile(package) as z:
        z.extractall(target)
    chain = target / "chain.jsonl"
    lines = chain.read_text(encoding="utf-8").splitlines()
    record = json.loads(lines[0])
    record["meta"] = {**(record.get("meta") or {}), "note": "tampered-by-test"}
    lines[0] = json.dumps(record, ensure_ascii=False)
    chain.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--no-replay", action="store_true", help="只测爆破与封禁，不篡改画面")
    parser.add_argument("--keep", action="store_true", help="结束时不复位")
    args = parser.parse_args()

    user, password = credentials()
    report = Report("攻防闭环端到端测试")
    s = login_or_exit(user, password)
    role = s.get(f"{BASE}/api/auth/session", timeout=10).json()["role"]
    if role not in ("operator", "admin"):
        sys.exit(f"账号角色为 {role}：回滚与导出证据需要 operator 或 admin")

    site = s.get(f"{BASE}/api/site", timeout=10).json()
    device = next((d["id"] for d in site["devices"] if d["ip"] == TARGET_IP), None)
    if device is None:
        print(
            paint(
                f"登记表中没有靶机 {TARGET_IP}：先在控制台添加摄像头（拉流 rtsp://{TARGET_IP}:8554/cam）",
                "1;31",
            )
        )
        return 1
    info(f"靶机 {TARGET_IP} 登记为 {device}")

    title("0. 准备：复位演示环境")
    tampered = any(
        '"tampered": true' in f.read_text() for f in Path("/tmp").glob("hyd-tamper-*.json")
    )
    if subprocess.run(["ip", "link", "show", "hyd-span"], capture_output=True).returncode != 0:
        print(
            paint(
                "  抓包镜像口 hyd-span 不在，探针将看不到攻击流量；先执行 make attack-show 恢复",
                "1;31",
            )
        )
        return 1
    if not run(["make", "--no-print-directory", "-s", "demo-reset"], "复位"):
        return 1
    if tampered and not args.no_replay:
        for left in range(WARMUP_S, 0, -1):
            print(
                f"\r  画面预热（重放须切回识别引擎看过的片段）：还剩 {left:>3} s",
                end="",
                flush=True,
            )
            time.sleep(1)
        print()
        run(["make", "--no-print-directory", "-s", "demo-reset"], "复位")

    ws = Listener(s)
    if not report.check("订阅控制台实时推送", ws.start() and ws.error is None, ws.error or ""):
        return report.finish()
    time.sleep(1.5)
    mark = ws.count()

    title(f"1. 红方：对 {device} 弱口令爆破")
    t0 = time.monotonic()
    run(["make", "--no-print-directory", "-s", "attack"], "攻击")

    alert, t = ws.wait(
        lambda f: (
            f["channel"] == "alerts"
            and f["data"].get("category") == "auth_bruteforce"
            and f["data"].get("device_id") == device
        ),
        timeout=30,
        since=mark,
    )
    report.check(
        "探针检出口令爆破告警",
        alert is not None,
        f"{alert['data']['rule_id']}，来源 {alert['data']['src_ip']}，{since(t0, t)}"
        if alert
        else "30 s 内未收到",
    )

    inc, t = ws.wait(
        lambda f: (
            f["channel"] == "incidents"
            and f["data"].get("rule_id") == "HYD-NET-0101"
            and device in f["data"].get("device_ids", [])
        ),
        timeout=30,
        since=mark,
    )
    report.check(
        "关联引擎生成事件 HYD-NET-0101",
        inc is not None,
        f"{inc['data']['id']}「{inc['data']['title']}」，{since(t0, t)}"
        if inc
        else "30 s 内未收到",
    )
    incident_id = inc["data"]["id"] if inc else None

    execution, t = ws.wait(
        lambda f: (
            f["channel"] == "executions"
            and f["data"].get("state") == "contained"
            and (incident_id is None or f["data"].get("incident_id") == incident_id)
        ),
        timeout=40,
        since=mark,
    )
    report.check(
        "自动封禁攻击源生效",
        execution is not None,
        f"封禁 {execution['data']['target']}，{execution['data']['ttl_s']} s 后自动到期，{since(t0, t)}"
        if execution
        else "40 s 内未见 contained",
    )

    cross_id = None
    if not args.no_replay:
        title(f"2. 红方：把 {device} 的画面换成 45 秒前的录像")
        time.sleep(5)
        t_replay = time.monotonic()
        run(
            ["make", "--no-print-directory", "-s", "tamper", "ACTION=replay", f"CAMERA={CAMERA}"],
            "篡改画面",
        )
        info("等待识别画面重放（约 15 s）…")
        cross, t = ws.wait(
            lambda f: f["channel"] == "incidents" and f["data"].get("rule_id") == "HYD-X-0001",
            timeout=60,
            since=mark,
        )
        report.check(
            "跨域关联事件 HYD-X-0001（爆破 + 画面重放）",
            cross is not None,
            f"{cross['data']['id']}，等级 {cross['data']['severity']}，篡改后 {t - t_replay:.1f} s"
            if cross
            else "60 s 内未收到（画面预热不足时会识别不出）",
        )
        if cross:
            cross_id = cross["data"]["id"]
            techniques = ", ".join(cross["data"].get("techniques", []))
            info(f"ATT&CK：{techniques}；命中路径 {len(cross['data'].get('hit_path', []))} 条事件")

    title("3. 存证：导出证据包并离线校验")
    target_incident = cross_id or incident_id
    package = None
    if target_incident:
        OUT.mkdir(exist_ok=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            r = s.post(f"{BASE}/api/incidents/{target_incident}/evidence/export", timeout=60)
            if r.status_code == 200:
                package = OUT / f"evidence-{target_incident}.zip"
                package.write_bytes(r.content)
                break
            if r.status_code != 404:
                break
            print("\r  存证尚未写入（关联事件后约 30 s），稍候重试…", end="", flush=True)
            time.sleep(5)
        print()
        report.check(
            "导出证据包",
            package is not None,
            f"{package.relative_to(ROOT)}，{package.stat().st_size / 1e6:.1f} MB"
            if package
            else f"HTTP {r.status_code}",
        )
    fp = fingerprint()
    if package and fp:
        info(f"可信公钥指纹（取自 evidence-service 启动日志）：{fp}")
        code, out = verify(package, fp)
        report.check("原始证据包校验通过", code == 0, out.splitlines()[0] if out else "")
        bad = tamper_copy(package)
        code, out = verify(bad, fp)
        report.check(
            "篡改一条记录后校验报错",
            code == 1,
            (out.splitlines()[1] if len(out.splitlines()) > 1 else out)[:120],
        )

    title("4. 处置回滚：一键解封")
    if execution:
        exec_id = execution["data"]["id"]
        mark2 = ws.count()
        t1 = time.monotonic()
        r = s.post(f"{BASE}/api/executions/{exec_id}/rollback", timeout=15)
        report.check("提交回滚请求", r.status_code == 200, f"HTTP {r.status_code}")
        rolled, t = ws.wait(
            lambda f: (
                f["channel"] == "executions"
                and f["data"].get("id") == exec_id
                and f["data"].get("state") == "rolled_back"
            ),
            timeout=30,
            since=mark2,
        )
        report.check(
            "封禁已解除（rolled_back）",
            rolled is not None,
            f"{t - t1:.1f} s" if rolled else "30 s 内未见",
        )
        today = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        r = s.get(f"{BASE}/api/kpis", params={"day_start": today.isoformat()}, timeout=10)
        if r.status_code == 200:
            k = r.json()
            info(
                f"今日已处置 {k['contained_today']['value']}，最近处置用时 {k['last_contain_ms']['value']} ms"
            )
    ws.stop()

    if not args.keep:
        title("5. 复位演示环境")
        report.check(
            "make demo-reset", run(["make", "--no-print-directory", "-s", "demo-reset"], "复位")
        )
    else:
        info("已按 --keep 保留现场；结束后执行 make demo-reset")

    return report.finish()


if __name__ == "__main__":
    sys.exit(main())
