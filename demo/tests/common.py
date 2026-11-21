"""演示测试脚本的公共部分：控制台登录、WS 订阅、结果打印。

账号口令取环境变量 HYD_USER、HYD_PASSWORD，未设置时在终端交互输入（不落文件）。
控制台地址取 HYD_URL，默认 https://127.0.0.1；本机 Caddy 用自签 CA，默认不校验证书，
设置 HYD_CA=hyd-local-ca.crt 时按该 CA 校验。
"""

import asyncio
import getpass
import json
import os
import sys
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import requests  # noqa: TID251 - 演示用的命令行测试脚本，不在服务的请求路径上
import urllib3
import websockets

BASE = os.environ.get("HYD_URL", "https://127.0.0.1").rstrip("/")
CA = os.environ.get("HYD_CA")
VERIFY: bool | str = CA if CA else False
if not CA:
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

COLOR = sys.stdout.isatty()


def paint(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if COLOR else text


def title(text: str) -> None:
    print()
    print(paint(f"▌{text}", "1;36"))


def info(text: str) -> None:
    print(paint(f"  {text}", "2"))


@dataclass
class Report:
    """逐项记录结果，最后打印汇总；任一项失败时退出码为 1。"""

    name: str
    rows: list[tuple[str, bool, str]] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)

    def check(self, label: str, ok: bool, detail: str = "") -> bool:
        mark = paint("✓ 通过", "1;32") if ok else paint("✗ 失败", "1;31")
        print(f"  {mark}  {label}" + (paint(f"  — {detail}", "2") if detail else ""))
        self.rows.append((label, ok, detail))
        return ok

    def finish(self) -> int:
        passed = sum(ok for _, ok, _ in self.rows)
        failed = len(self.rows) - passed
        spent = time.monotonic() - self.started
        print()
        line = f"{self.name}：共 {len(self.rows)} 项，通过 {passed}，失败 {failed}，用时 {spent:.1f} 秒"
        print(paint(line, "1;32" if failed == 0 else "1;31"))
        if failed:
            for label, ok, detail in self.rows:
                if not ok:
                    print(paint(f"  ✗ {label}  {detail}", "31"))
        return 0 if failed == 0 else 1


def credentials() -> tuple[str, str]:
    user = os.environ.get("HYD_USER") or input("控制台账号：").strip()
    password = os.environ.get("HYD_PASSWORD") or getpass.getpass(f"{user} 的口令：")
    return user, password


class _Session(requests.Session):
    """写操作须携带 X-Request-ID（审计用）：每个请求生成一个新的。"""

    def request(self, method, url, *args, **kwargs):  # type: ignore[override]
        headers = {"X-Request-ID": str(uuid.uuid4()), **(kwargs.pop("headers", None) or {})}
        return super().request(method, url, *args, headers=headers, **kwargs)


def session() -> requests.Session:
    s = _Session()
    s.verify = VERIFY
    return s


def login(s: requests.Session, user: str, password: str) -> requests.Response:
    return s.post(
        f"{BASE}/api/auth/login", json={"username": user, "password": password}, timeout=15
    )


def login_or_exit(user: str, password: str) -> requests.Session:
    s = session()
    r = login(s, user, password)
    if r.status_code != 200:
        sys.exit(paint(f"登录失败（HTTP {r.status_code}）：{r.text[:200]}", "1;31"))
    return s


def ms(seconds: float) -> str:
    return f"{seconds * 1000:.0f} ms" if seconds < 1 else f"{seconds:.1f} s"


class Listener:
    """在后台线程订阅 WS /ws，收集每一帧（含连接时的补推），供用例按条件等待。"""

    def __init__(self, s: requests.Session) -> None:
        self._cookie = "; ".join(f"{c.name}={c.value}" for c in s.cookies)
        self._frames: list[tuple[float, dict[str, Any]]] = []
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self._stop = False
        self.error: str | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self, timeout: float = 10) -> bool:
        self._thread.start()
        return self._ready.wait(timeout)

    def stop(self) -> None:
        self._stop = True

    def _run(self) -> None:
        try:
            asyncio.run(self._loop())
        except Exception as e:  # noqa: BLE001 - 线程内的任何异常都记录给主线程
            self.error = repr(e)
            self._ready.set()

    async def _loop(self) -> None:
        import ssl

        url = BASE.replace("https://", "wss://").replace("http://", "ws://") + "/ws"
        ctx = None
        if url.startswith("wss://"):
            ctx = ssl.create_default_context(cafile=CA) if CA else ssl._create_unverified_context()
        async with websockets.connect(
            url,
            ssl=ctx,
            additional_headers={"Cookie": self._cookie},
            max_size=None,
            open_timeout=10,
        ) as ws:
            self._ready.set()
            while not self._stop:
                try:
                    text = await asyncio.wait_for(ws.recv(), timeout=1)
                except TimeoutError:
                    continue
                with self._lock:
                    self._frames.append((time.monotonic(), json.loads(text)))

    def frames(self, channel: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            return [f for _, f in self._frames if channel is None or f["channel"] == channel]

    def count(self) -> int:
        with self._lock:
            return len(self._frames)

    def wait(
        self, predicate: Callable[[dict[str, Any]], bool], timeout: float, since: int = 0
    ) -> tuple[dict[str, Any] | None, float]:
        """等待第 since 帧之后第一帧满足 predicate 的帧，返回 (帧, 到达时刻)；超时返回 (None, 0)。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                for t, f in self._frames[since:]:
                    if predicate(f):
                        return f, t
            if self.error:
                return None, 0
            time.sleep(0.2)
        return None, 0


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def now_utc() -> datetime:
    return datetime.now(UTC)
