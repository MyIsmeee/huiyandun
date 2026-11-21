#!/usr/bin/env python3
"""受控 RTSP 推流劫持（DP-09、C-SEC-11）：对单一自建目标 rtsp-target 发 ANNOUNCE，企图以自己的码流顶替设备画面，
触发检测规则 HYD-NET-0002。只发声明、不发送任何码流：目标不给远端发布权限，回 401；即便被接受也随即断开。
只用标准库，镜像内不含任何通用扫描/利用工具。参数经环境变量注入，规范值登记于 demo/scenarios/attack-sim.yaml。"""

import os
import socket
import sys
import time

# 声明一路 H.264 视频；只是声明，后面不建立传输、不发送数据
SDP = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=hyd-attack-sim\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n"


def announce(host: str, port: int, url: str, cseq: int) -> str:
    """新建一条连接发一次 ANNOUNCE，返回响应首行（状态行）。

    每次尝试都重连：目标拒绝后会关闭连接；被处置封禁后连接会直接失败或被复位，由调用方捕获并照常继续。
    """
    request = (
        f"ANNOUNCE {url} RTSP/1.0\r\n"
        f"CSeq: {cseq}\r\n"
        f"User-Agent: hyd-attack-sim\r\n"
        f"Content-Type: application/sdp\r\n"
        f"Content-Length: {len(SDP)}\r\n\r\n"
        f"{SDP}"
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
    attempts = int(os.environ.get("HYD_HIJACK_ATTEMPTS", "3"))
    interval = float(os.environ.get("HYD_HIJACK_INTERVAL_S", "2"))

    url = f"rtsp://{host}:{port}/{path}"
    refused = 0
    for cseq in range(1, attempts + 1):
        if cseq > 1:
            time.sleep(interval)
        try:
            status = announce(host, port, url, cseq)
        except OSError as exc:  # 连接被拒、超时或被复位：目标已被封禁或不可达
            status = f"connection failed: {exc}"
        else:
            if " 200" not in status:
                refused += 1
        print(f"attempt {cseq}: {status}", file=sys.stderr)
    print(f"rtsp-hijack: {refused}/{attempts} refused by {url}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
