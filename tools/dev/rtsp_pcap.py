"""合成 RTSP 认证样本 pcap（R-02、C-SEC-01）：HYD-NET-0001 的正例与反例。

用法：python tools/dev/rtsp_pcap.py <输出目录>
按 CASES 写出 <样本名>.pcap；预期告警数写在同名 .meta.yaml，由 make test-rules 比对。
地址取文档示例网段（RFC 5737），时间戳固定，输出逐字节可重现。
"""

import struct
import sys
from pathlib import Path

DEVICE = "192.0.2.10"
CLIENTS = ("198.51.100.23", "198.51.100.24")
RTSP_PORT = 554
T0 = 1_800_000_000.0  # 固定起始时间，样本可重现
SYN, FIN, PSH, ACK = 0x02, 0x01, 0x08, 0x10
REASONS = {200: "OK", 401: "Unauthorized"}

# 一次请求：(是否带凭据, 响应码)
CHALLENGE = (False, 401)  # 首次请求不带凭据，设备返回认证质询（Digest）
FAIL = (True, 401)  # 凭据被拒绝
OK = (True, 200)

# 样本名 → 会话列表：(来源序号, 开始时刻 s, 依次发出的请求)；同一连接内请求间隔 2 s
CASES = {
    "hit-5-conns": [(0, 5 * i, [CHALLENGE, FAIL]) for i in range(5)],
    "hit-10-one-conn": [(0, 0, [CHALLENGE] + [FAIL] * 10)],
    "miss-4-conns": [(0, 5 * i, [CHALLENGE, FAIL]) for i in range(4)],
    "miss-5-over-100s": [(0, 25 * i, [CHALLENGE, FAIL]) for i in range(5)],
    "miss-3-and-2-sources": [(0 if i < 3 else 1, 5 * i, [CHALLENGE, FAIL]) for i in range(5)],
    "miss-5-challenge-ok": [(0, 5 * i, [CHALLENGE, OK]) for i in range(5)],
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
    client: str, cport: int, start: float, requests: list[tuple[bool, int]]
) -> list[tuple[float, bytes]]:
    """一条 TCP 连接：握手，逐个 DESCRIBE 请求与响应，关闭。"""
    packets: list[tuple[float, bytes]] = []
    t = start

    def add(
        dt: float, from_client: bool, seq: int, ack: int, flags: int, data: bytes = b""
    ) -> None:
        nonlocal t
        t += dt
        ends = (
            (client, cport, DEVICE, RTSP_PORT)
            if from_client
            else (DEVICE, RTSP_PORT, client, cport)
        )
        packets.append((t, frame(*ends, seq, ack, flags, data)))

    cs, ss = 1000, 5000  # 双方初始序号
    add(0, True, cs, 0, SYN)
    add(0.001, False, ss, cs + 1, SYN | ACK)
    cs, ss = cs + 1, ss + 1
    add(0.001, True, cs, ss, ACK)
    uri = f"rtsp://{DEVICE}:{RTSP_PORT}/stream"
    auth = f'Authorization: Digest username="admin", uri="{uri}", response="0"\r\n'
    for cseq, (credentials, status) in enumerate(requests, 1):
        headers = f"CSeq: {cseq}\r\n{auth if credentials else ''}"
        request = f"DESCRIBE {uri} RTSP/1.0\r\n{headers}\r\n".encode()
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
    for name, sessions in CASES.items():
        packets = [
            p
            for i, (client, start, requests) in enumerate(sessions)
            for p in session(CLIENTS[client], 40001 + i, T0 + start, requests)
        ]
        (out / f"{name}.pcap").write_bytes(pcap(packets))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
