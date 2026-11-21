"""USB 摄像头：插在边缘主机上、由 ingest 读取设备并编码推流，go2rtc 从 ingest 取流（与推流摄像头相同）。

设备以 /dev/v4l/by-id 下的名字标识：拔插、换 USB 口后 /dev/videoN 的编号会变，by-id 名字不变。每个 UVC 摄像头
有两个节点，index0 为视频采集、index1 为元数据，只列 index0。api-server 只读挂载宿主 /dev 用于列出设备名，
没有打开设备的权限；ingest 另获视频设备（主设备号 81）的访问权限（deploy/compose/compose.yaml）。
"""

import re
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path
from typing import Any

BY_ID = "v4l/by-id"
CAPTURE_SUFFIX = "-video-index0"
DEVICE_RE = re.compile(
    r"[A-Za-z0-9._:-]{1,200}"
)  # 与契约 UsbDeviceId 一致；拼进 ffmpeg 命令，不得含空白
# USB 摄像头没有网络地址：设备 IP 用本机回环段的占位地址，只为登记表各摄像头 IP 唯一，网络告警不会匹配到它
PLACEHOLDER_NET = IPv4Network("127.0.1.0/24")
# ingest 容器内的宿主 /dev 挂载点；ffmpeg 读设备、编码为浏览器可播放的 H.264，推到 ingest 本机的同名路径
INGEST_DEV = "/hostdev"
COMMAND = (
    "ffmpeg -hide_banner -loglevel error -f v4l2 -i {dev}/" + BY_ID + "/{device} -an -r 15 "
    "-c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p "
    "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)


def display_name(device: str) -> str:
    """by-id 名字 → 便于辨认的设备名：usb-GEMBIRD_Generic_UVC_1.00_camera-video-index0 → GEMBIRD Generic UVC 1.00 camera"""
    name = device.removesuffix(CAPTURE_SUFFIX)
    name = re.sub(r"^usb-", "", name)
    return name.replace("_", " ").strip() or device


def list_devices(dev_dir: Path) -> list[tuple[str, str]]:
    """宿主上的 USB 视频采集设备：(设备标识, 设备名)，按标识排序。目录不存在（没有摄像头）时为空。"""
    by_id = dev_dir / BY_ID
    if not by_id.is_dir():
        return []
    return sorted(
        (p.name, display_name(p.name))
        for p in by_id.iterdir()
        if p.name.endswith(CAPTURE_SUFFIX) and DEVICE_RE.fullmatch(p.name)
    )


def command(device: str) -> str:
    if not DEVICE_RE.fullmatch(device):
        raise ValueError(f"非法的设备标识：{device!r}")
    return COMMAND.format(dev=INGEST_DEV, device=device)


def ingest_path(device: str) -> dict[str, Any]:
    """ingest 中该摄像头路径的整份配置：本机 ffmpeg 读设备推流，进程退出后重启（拔掉后插回即恢复）。"""
    return {"source": "publisher", "runOnInit": command(device), "runOnInitRestart": True}


def placeholder_ip(used: set[str]) -> str:
    for host in PLACEHOLDER_NET.hosts():
        if str(host) not in used:
            return str(host)
    raise ValueError("USB 摄像头的占位地址已用完")


def is_placeholder(ip: str) -> bool:
    try:
        return IPv4Address(ip) in PLACEHOLDER_NET
    except ValueError:
        return False
