"""合成 RTSP 样本 pcap（R-02、C-SEC-01）：HYD-NET-0001（认证爆破）与 HYD-NET-0002（推流劫持）的正例与反例。

用法：python tools/dev/rtsp_pcap.py <输出目录>
按 CASES 写出 <规则 ID>/<样本名>.pcap；预期告警数写在同名 .meta.yaml，由 make test-rules 比对。
地址取文档示例网段（RFC 5737），时间戳固定，输出逐字节可重现。
"""

import struct
import sys
from pathlib import Path

DEVICE = "192.0.2.10"
# 推流接收端（边缘主机的 ingest）：向它推流是正常接入，回放时以 HYD_PUSH_SERVERS 告知探针（tools/dev/check_rules.py）
PUSH_SERVER = "192.0.2.200"
CLIENTS = ("198.51.100.23", "198.51.100.24")
RTSP_PORT = 554
T0 = 1_800_000_000.0  # 固定起始时间，样本可重现
SYN, FIN, PSH, ACK = 0x02, 0x01, 0x08, 0x10
REASONS = {200: "OK", 401: "Unauthorized"}

# 一次请求：(是否带凭据, 响应码[, 方法[, 正文]])；方法缺省为 DESCRIBE
type Request = tuple[bool, int] | tuple[bool, int, str] | tuple[bool, int, str, str]
CHALLENGE = (False, 401)  # 首次请求不带凭据，设备返回认证质询（Digest）
FAIL = (True, 401)  # 凭据被拒绝
OK = (True, 200)
# 推流：ANNOUNCE 声明要发布的码流，SETUP 建立传输，RECORD 开始发送
SDP = "v=0\r\nm=video 0 RTP/AVP 96\r\n"
ANNOUNCE, RECORD = (True, 200, "ANNOUNCE", SDP), (True, 200, "RECORD")
ANNOUNCE_DENIED = (False, 401, "ANNOUNCE", SDP)
PULL = [OK, (True, 200, "SETUP"), (True, 200, "PLAY"), (True, 200, "TEARDOWN")]  # 正常取流
# 请求行出现在正文里而不在报文开头：不是推流请求
QUOTED = (True, 200, "SET_PARAMETER", f"ANNOUNCE rtsp://{DEVICE}:{RTSP_PORT}/stream RTSP/1.0\r\n")

# 规则 ID → 样本名 → 会话列表：(来源序号, 开始时刻 s, 依次发出的请求[, 目标地址])；同一连接内请求间隔 2 s
CASES: dict[str, dict[str, list[tuple]]] = {
    "HYD-NET-0001": {
        "hit-5-conns": [(0, 5 * i, [CHALLENGE, FAIL]) for i in range(5)],
        "hit-10-one-conn": [(0, 0, [CHALLENGE] + [FAIL] * 10)],
        "miss-4-conns": [(0, 5 * i, [CHALLENGE, FAIL]) for i in range(4)],
        "miss-5-over-100s": [(0, 25 * i, [CHALLENGE, FAIL]) for i in range(5)],
        "miss-3-and-2-sources": [(0 if i < 3 else 1, 5 * i, [CHALLENGE, FAIL]) for i in range(5)],
        "miss-5-challenge-ok": [(0, 5 * i, [CHALLENGE, OK]) for i in range(5)],
    },
    "HYD-NET-0002": {
        "hit-announce-denied": [(0, 0, [ANNOUNCE_DENIED])],
        "hit-announce-record": [(0, 0, [ANNOUNCE, (True, 200, "SETUP"), RECORD])],
        "hit-repeated-in-60s": [(0, 10 * i, [ANNOUNCE_DENIED]) for i in range(4)],
        "hit-2-sources": [(0, 0, [ANNOUNCE_DENIED]), (1, 5, [ANNOUNCE_DENIED])],
        "miss-pull": [(0, 5 * i, PULL) for i in range(3)],
        "miss-push-server": [(0, 0, [ANNOUNCE, (True, 200, "SETUP"), RECORD], PUSH_SERVER)],
        "miss-request-line-in-body": [(0, 0, [OK, QUOTED])],
    },
}


def checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\0"
    total = sum(struct.unpack(f"!{len(data) // 2}H", data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return ~total & 0xFFFF


def frame(
    src: str, sport: int, dst: str, dport: int, seq: int, ack: int, flags: int, payload: bytes
) -> bytes:
    """以太网 + IPv4 + TCP，校验和正确。"""
    s, d = (bytes(map(int, a.split("."))) for a in (src, dst))
    tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, ack, 5 << 4, flags, 65535, 0, 0) + payload
    pseudo = s + d + struct.pack("!BBH", 0, 6, len(tcp))
    tcp = tcp[:16] + struct.pack("!H", checksum(pseudo + tcp)) + tcp[18:]
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp), 0, 0x4000, 64, 6, 0, s, d)
    ip = ip[:10] + struct.pack("!H", checksum(ip)) + ip[12:]
    return b"\x02\0\0\0\0\x02\x02\0\0\0\0\x01\x08\x00" + ip + tcp


def session(
    client: str, cport: int, start: float, requests: list[Request], server: str = DEVICE
) -> list[tuple[float, bytes]]:
    """一条 TCP 连接：握手，逐个请求与响应，关闭。"""
    packets: list[tuple[float, bytes]] = []
    t = start

    def add(
        dt: float, from_client: bool, seq: int, ack: int, flags: int, data: bytes = b""
    ) -> None:
        nonlocal t
        t += dt
        ends = (
            (client, cport, server, RTSP_PORT)
            if from_client
            else (server, RTSP_PORT, client, cport)
        )
        packets.append((t, frame(*ends, seq, ack, flags, data)))

    cs, ss = 1000, 5000  # 双方初始序号
    add(0, True, cs, 0, SYN)
    add(0.001, False, ss, cs + 1, SYN | ACK)
    cs, ss = cs + 1, ss + 1
    add(0.001, True, cs, ss, ACK)
    uri = f"rtsp://{server}:{RTSP_PORT}/stream"
    auth = f'Authorization: Digest username="admin", uri="{uri}", response="0"\r\n'
    for cseq, (credentials, status, *rest) in enumerate(requests, 1):
        method = rest[0] if rest else "DESCRIBE"
        body = rest[1] if len(rest) > 1 else ""
        headers = f"CSeq: {cseq}\r\n{auth if credentials else ''}"
        if body:
            headers += f"Content-Length: {len(body)}\r\n"
        request = f"{method} {uri} RTSP/1.0\r\n{headers}\r\n{body}".encode()
        add(0.001 if cseq == 1 else 2, True, cs, ss, PSH | ACK, request)
        cs += len(request)
        response = f"RTSP/1.0 {status} {REASONS[status]}\r\nCSeq: {cseq}\r\n\r\n".encode()
        add(0.002, False, ss, cs, PSH | ACK, response)
        ss += len(response)
        add(0.001, True, cs, ss, ACK)
    add(0.01, True, cs, ss, FIN | ACK)
    add(0.001, False, ss, cs + 1, FIN | ACK)
    add(0.001, True, cs + 1, ss + 1, ACK)
    return packets


def pcap(packets: list[tuple[float, bytes]]) -> bytes:
    out = struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)  # 链路层：以太网
    for ts, data in sorted(packets, key=lambda p: p[0]):
        usec = round(ts * 1_000_000)
        out += (
            struct.pack("<IIII", usec // 1_000_000, usec % 1_000_000, len(data), len(data)) + data
        )
    return out


def main(out: Path) -> None:
    for rule_id, cases in CASES.items():
        (out / rule_id).mkdir(parents=True, exist_ok=True)
        for name, sessions in cases.items():
            packets = [
                p
                for i, (client, start, requests, *server) in enumerate(sessions)
                for p in session(CLIENTS[client], 40001 + i, T0 + start, requests, *server)
            ]
            (out / rule_id / f"{name}.pcap").write_bytes(pcap(packets))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
