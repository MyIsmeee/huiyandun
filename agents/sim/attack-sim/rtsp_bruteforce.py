#!/usr/bin/env python3
"""受控 RTSP 认证爆破（DP-09、C-SEC-11）：对单一自建目标 rtsp-target 反复发送带凭据的 DESCRIBE，
触发检测规则 HYD-NET-0001。只用标准库，镜像内不含任何通用扫描/利用工具。参数经环境变量注入，
规范值登记于 demo/scenarios/attack-sim.yaml。"""

import base64
import os
import socket
import sys


def describe(host: str, port: int, url: str, cseq: int, authorization: str) -> str:
    """新建一条连接发一次带凭据的 DESCRIBE，返回响应首行（状态行）。

    每次尝试都重连：RTSP 目标在认证失败后会关闭连接；被处置封禁后连接会直接失败——
    这正是后续 verify() 判定封禁生效的信号，由调用方捕获并计为失败，不中断其余尝试。
    """
    request = (
        f"DESCRIBE {url} RTSP/1.0\r\n"
        f"CSeq: {cseq}\r\n"
        f"Authorization: {authorization}\r\n"
        f"User-Agent: hyd-attack-sim\r\n\r\n"
    )
    with socket.create_connection((host, port), timeout=5) as sock:
        sock.settimeout(5)
        sock.sendall(request.encode("ascii"))
        response = sock.recv(4096).decode("latin-1")
    return response.splitlines()[0] if response else ""


def main() -> int:
    host = os.environ.get("HYD_TARGET", "rtsp-target")
    port = int(os.environ.get("HYD_TARGET_PORT", "8554"))
    path = os.environ.get("HYD_RTSP_PATH", "cam")
    # 故意错误的凭据：目标对每次尝试都回 401（这里不是真实口令，仅模拟攻击方的猜测）
    user = os.environ.get("HYD_USER", "admin")
    guess = os.environ.get("HYD_PASSWORD", "wrong-password")
    attempts = int(os.environ.get("HYD_ATTEMPTS", "6"))

    url = f"rtsp://{host}:{port}/{path}"
    authorization = "Basic " + base64.b64encode(f"{user}:{guess}".encode()).decode("ascii")

    denied = 0
    for cseq in range(1, attempts + 1):
        try:
            status = describe(host, port, url, cseq, authorization)
        except OSError as exc:  # 连接被拒/超时：目标已被封禁或不可达
            status = f"connection failed: {exc}"
        else:
            if " 401" in status:
                denied += 1
        print(f"attempt {cseq}: {status}", file=sys.stderr)
    print(f"rtsp-bruteforce: {denied}/{attempts} denied by {url}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
