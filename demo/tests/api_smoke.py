"""测试三：控制台接口冒烟测试（只读，不改动配置）。

覆盖：鉴权（未登录拒绝、错误口令拒绝、登录、会话、登出后失效）、各只读接口、WebSocket 实时推送。
用法：uv run --all-packages python demo/tests/api_smoke.py
账号口令取 HYD_USER、HYD_PASSWORD，未设置时交互输入。

注意：错误口令那一项会记一次登录失败；60 秒内累计 5 次会触发"管理平台自身遭攻击"告警（login_guard.py）。
"""

import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BASE, Listener, Report, credentials, info, login, ms, session, title  # noqa: E402

# 与 services/api-server/src/api_server/auth.py 的 GRANTED 一致：最低角色 → 可访问的角色
GRANTED = {
    "viewer": {"viewer", "operator", "admin", "auditor"},
    "operator": {"operator", "admin"},
    "admin": {"admin"},
    "auditor": {"auditor"},
}

# 大屏"今日"的起点：本地时区的零点
DAY_START = quote(
    datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
)

READONLY = [
    # (路径, 最低角色, 说明, 对返回体的检查)
    ("/api/site", "viewer", "站点与摄像头登记表", lambda b: "devices" in b and "areas" in b),
    (
        f"/api/kpis?day_start={DAY_START}",
        "viewer",
        "大屏关键指标",
        lambda b: {"online_devices", "active_alerts"} <= b.keys(),
    ),
    ("/api/scene/areas", "viewer", "三维场景区域", lambda b: isinstance(b["items"], list)),
    ("/api/llm/status", "viewer", "AI 模型状态", lambda b: isinstance(b, dict)),
    ("/api/cameras", "admin", "摄像头管理列表", lambda b: isinstance(b["items"], list)),
    ("/api/llm/providers", "admin", "模型供应商列表", lambda b: isinstance(b["items"], list)),
    ("/api/audit-logs", "auditor", "审计日志", lambda b: isinstance(b, (list, dict))),
]


def main() -> int:
    user, password = credentials()
    report = Report("接口冒烟测试")
    print(f"控制台：{BASE}")

    title("1. 鉴权")
    anon = session()
    r = anon.get(f"{BASE}/api/site", timeout=10)
    report.check("未登录访问 /api/site 被拒绝", r.status_code == 401, f"HTTP {r.status_code}")
    r = anon.get(f"{BASE}/api/auth/session", timeout=10)
    report.check("未登录查询会话被拒绝", r.status_code == 401, f"HTTP {r.status_code}")

    t = time.monotonic()
    r = login(session(), user, password + "-wrong")
    report.check(
        "错误口令登录被拒绝",
        r.status_code == 401,
        f"HTTP {r.status_code}，{ms(time.monotonic() - t)}",
    )

    s = session()
    t = time.monotonic()
    r = login(s, user, password)
    ok = report.check(
        "正确口令登录成功",
        r.status_code == 200,
        f"HTTP {r.status_code}，{ms(time.monotonic() - t)}",
    )
    if not ok:
        info(r.text[:200])
        return report.finish()
    role = r.json()["role"]
    cookie = next(iter(s.cookies), None)
    report.check(
        "会话 Cookie 带 Secure、HttpOnly",
        cookie is not None and cookie.secure and cookie.has_nonstandard_attr("HttpOnly"),
        f"角色 {role}",
    )
    r = s.get(f"{BASE}/api/auth/session", timeout=10)
    report.check(
        "查询当前会话",
        r.status_code == 200 and r.json().get("username") == user,
        f"{r.json().get('username')} / {r.json().get('role')}，{r.json().get('expires_at')} 到期"
        if r.status_code == 200
        else f"HTTP {r.status_code}",
    )

    title("2. 只读接口")
    for path, need, label, valid in READONLY:
        t = time.monotonic()
        r = s.get(f"{BASE}{path}", timeout=15)
        spent = ms(time.monotonic() - t)
        if role not in GRANTED[need]:
            report.check(
                f"{label} {path.split('?')[0]}",
                r.status_code == 403,
                f"角色 {role} 无权访问，应返回 403（实际 HTTP {r.status_code}）",
            )
            continue
        body_ok = r.status_code == 200 and valid(r.json())
        report.check(f"{label} {path.split('?')[0]}", body_ok, f"HTTP {r.status_code}，{spent}")
        if path == "/api/site" and body_ok:
            devices = r.json()["devices"]
            info(f"登记设备 {len(devices)} 台：" + "、".join(d["id"] for d in devices[:12]))
        if path.startswith("/api/kpis") and body_ok:
            k = r.json()
            info(
                "在线设备 {}，活跃告警 {}，今日已处置 {}".format(
                    *(k[x]["value"] for x in ("online_devices", "active_alerts", "contained_today"))
                )
            )

    title("3. 实时推送 WebSocket /ws")
    t = time.monotonic()
    ws = Listener(s)
    connected = ws.start()
    report.check(
        "已登录建立 WS 连接", connected and ws.error is None, ws.error or ms(time.monotonic() - t)
    )
    if connected and ws.error is None:
        frame, _ = ws.wait(lambda f: f["channel"] == "system", timeout=12)
        report.check("收到心跳帧（5 秒一次）", frame is not None)
        devices = ws.frames("devices")
        registered = len(s.get(f"{BASE}/api/site", timeout=10).json()["devices"])
        report.check(
            "连接时补推全部登记设备的状态",
            len(devices) == registered,
            f"补推 {len(devices)} 台，登记表 {registered} 台"
            + ("（登记表为空：先在控制台添加摄像头）" if registered == 0 else ""),
        )
        online = [d["data"]["id"] for d in devices if d["data"]["state"] != "offline"]
        info(f"在线 {len(online)} 台：" + "、".join(online[:12]))
        info(
            "近 24 小时补推：告警 {}，关联事件 {}，处置执行 {}".format(
                len(ws.frames("alerts")), len(ws.frames("incidents")), len(ws.frames("executions"))
            )
        )
        tracks, _ = ws.wait(lambda f: f["channel"] == "tracks", timeout=10)
        info("视觉跟踪帧：" + ("已收到" if tracks else "10 秒内没有（画面里没人时属正常）"))
        ws.stop()

    anon_ws = Listener(session())
    anon_ws.start()
    time.sleep(1)
    rejected = anon_ws.error is not None or anon_ws.count() == 0
    report.check("未登录的 WS 连接被拒绝", rejected, "服务端以 1008 关闭" if rejected else "")
    anon_ws.stop()

    title("4. 登出")
    r = s.post(f"{BASE}/api/auth/logout", timeout=10)
    report.check("登出", r.status_code == 204, f"HTTP {r.status_code}")
    r = s.get(f"{BASE}/api/site", timeout=10)
    report.check("登出后会话失效", r.status_code == 401, f"HTTP {r.status_code}")

    return report.finish()


if __name__ == "__main__":
    sys.exit(main())
