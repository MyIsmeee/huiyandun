"""测试四：平台自身防护——控制台登录爆破检测（HYD-WEB-0001）。

用一个不存在的账号连续登录失败 5 次（60 秒内），验证：每次都被拒绝、控制台告警栏实时收到
"管理平台自身遭攻击"告警（经 WS 推送），且告警标出了来源地址；之后正确账号仍可正常登录。
用法：uv run --all-packages python demo/tests/login_guard.py

同一来源每 60 秒只告警一次：连续重跑须间隔 60 秒以上，否则第二次收不到新告警。
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BASE,
    Listener,
    Report,
    credentials,
    info,
    login,
    login_or_exit,
    ms,
    session,
    title,
)

RULE_ID = "HYD-WEB-0001"
ATTEMPTS = 5
FAKE_USER = "attacker-test"
GUESSES = ["admin", "123456", "password", "admin123", "hyd@2026", "root", "qwerty"]


def main() -> int:
    user, password = credentials()
    report = Report("平台自身防护测试")
    print(f"控制台：{BASE}")

    title("1. 以值班员身份订阅告警推送")
    watcher = login_or_exit(user, password)
    ws = Listener(watcher)
    report.check("WS 已连接", ws.start() and ws.error is None, ws.error or "")
    time.sleep(1)  # 等补推的历史帧收完，只看之后的新告警
    mark = ws.count()

    title(f"2. 模拟攻击者连续猜口令（账号 {FAKE_USER}）")
    attacker = session()
    t0 = time.monotonic()
    rejected = 0
    for i, guess in enumerate(GUESSES[:ATTEMPTS], 1):
        r = login(attacker, FAKE_USER, guess)
        mark_ = "✗ 401 拒绝" if r.status_code == 401 else f"HTTP {r.status_code}"
        print(f"  第 {i} 次  {FAKE_USER} / {guess:<10} → {mark_}")
        rejected += r.status_code == 401
    report.check(f"{ATTEMPTS} 次错误口令全部被拒绝", rejected == ATTEMPTS, f"{rejected}/{ATTEMPTS}")

    title("3. 检查告警")
    frame, at = ws.wait(
        lambda f: f["channel"] == "alerts" and f["data"].get("rule_id") == RULE_ID,
        timeout=10,
        since=mark,
    )
    ok = report.check(
        f"控制台收到 {RULE_ID} 登录爆破告警",
        frame is not None,
        f"第 {ATTEMPTS} 次失败后 {ms(at - t0)} 推送到控制台"
        if frame
        else "10 秒内未收到；60 秒内已告警过一次时会去重，等 1 分钟再试",
    )
    if ok:
        a = frame["data"]
        report.check("告警标出来源地址", bool(a.get("src_ip")), f"来源 {a.get('src_ip')}")
        report.check("告警等级为高", a.get("severity") == "high", a.get("severity", ""))
        info(f"ATT&CK {a.get('technique')}  {a.get('summary')}")
    ws.stop()

    title("4. 正常用户不受影响")
    r = login(session(), user, password)
    report.check("正确账号仍可登录", r.status_code == 200, f"HTTP {r.status_code}")

    return report.finish()


if __name__ == "__main__":
    sys.exit(main())
