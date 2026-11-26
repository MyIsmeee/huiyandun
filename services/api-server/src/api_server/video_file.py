"""视频文件摄像头（D-145、FR-914）：浏览器上传的视频暂存在卷 camera-videos，ingest 只读挂载后循环播放。

视频是临时的：api-server 启动时清空卷（FR-915），原始文件名在被摄像头引用前只记在内存中，被引用后由登记表保存。
10 分钟内未被引用的上传由登记表的定期比对删除。日志只记上传编号，不记文件内容（G-14）。
"""

import re
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path, PurePosixPath
from shutil import disk_usage
from typing import Annotated, Any

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from api_server.auth import require
from py_contracts.api import VideoFile

MAX_BYTES = 2 * 1024**3  # 单个视频的上限（D-145）
RESERVE_BYTES = 2 * 1024**3  # 写入后磁盘至少留的空间：录像与数据库同盘
ORPHAN_S = 600  # 上传后这么久仍未被摄像头引用即删除
NAME_MAX = 200
ID_RE = re.compile(r"[0-9a-f]{32}")  # 与契约 VideoFileId 一致；拼进 ffmpeg 命令（D-103）
MISSING = "video_file: 视频已失效，请重新选择"
INGEST_DIR = "/videos"  # ingest 容器内卷 camera-videos 的只读挂载点
# 编码参数与 USB 摄像头相同（usb.COMMAND）：浏览器可播放的 H.264，15 fps 足够识别
COMMAND = (
    "ffmpeg -hide_banner -loglevel error -re -stream_loop -1 -i " + INGEST_DIR + "/{video_id} "
    "-an -r 15 -c:v libx264 -preset ultrafast -tune zerolatency -g 30 -pix_fmt yuv420p "
    "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:$RTSP_PORT/$MTX_PATH"
)


def ingest_path(video_id: str) -> dict[str, Any]:
    """ingest 中该摄像头路径的整份配置：本机 ffmpeg 循环播放视频推到同名路径，退出后重启。
    命令中只有服务端生成并校验过的上传编号，原始文件名不进入命令（D-103）。"""
    if not ID_RE.fullmatch(video_id):
        raise ValueError(f"非法的上传编号：{video_id!r}")
    return {
        "source": "publisher",
        "runOnInit": COMMAND.format(video_id=video_id),
        "runOnInitRestart": True,
    }


class VideoFiles:
    """卷中的视频与尚未被摄像头引用的上传（编号 → 原始文件名）。"""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self._pending: dict[str, str] = {}

    async def save(self, chunks: AsyncIterator[bytes], length: int, name: str) -> VideoFile:
        """流式写入 <编号>.part，收满 length 字节后改名；中途断开或长度不符即删除。"""
        video_id = uuid.uuid4().hex
        part = anyio.Path(self.dir / f"{video_id}.part")
        size = 0
        done = False
        try:
            async with await anyio.open_file(part, "wb") as f:
                async for chunk in chunks:
                    size += len(chunk)
                    if size > length:
                        break
                    await f.write(chunk)
            if size != length:
                raise HTTPException(400, "上传不完整：收到的长度与 Content-Length 不符")
            await part.rename(self.dir / video_id)
            done = True
        finally:
            if not done:
                with anyio.CancelScope(shield=True):  # 连接断开、请求被取消时仍删除
                    await part.unlink(missing_ok=True)
        # 去掉浏览器给出的路径部分
        base = PurePosixPath(name.replace("\\", "/")).name[:NAME_MAX] or video_id
        self._pending[video_id] = base
        return VideoFile.model_validate({"id": video_id, "name": base, "size_bytes": size})

    def name(self, video_id: str) -> str:
        """尚未被引用的上传的原始文件名；已失效（被清理、已被其他摄像头引用）时 400。"""
        if video_id not in self._pending:
            raise HTTPException(400, MISSING)
        return self._pending[video_id]

    def claim(self, video_id: str) -> None:
        """摄像头已保存引用：文件名改由登记表保存，同一上传不能再被其他摄像头引用。"""
        self._pending.pop(video_id, None)

    async def remove(self, video_id: str) -> None:
        self._pending.pop(video_id, None)
        await anyio.Path(self.dir / video_id).unlink(missing_ok=True)

    async def clear(self) -> None:
        """api-server 启动时清空卷：上次运行的视频文件摄像头已全部失效（FR-915）。"""
        self._pending.clear()
        async for path in anyio.Path(self.dir).iterdir():
            await path.unlink(missing_ok=True)

    async def prune(self, referenced: set[str]) -> None:
        """删除上传后超过 10 分钟仍未被任何摄像头引用的视频；写入中的 .part 不动（断开时由上传自行删除）。"""
        cutoff = time.time() - ORPHAN_S
        async for path in anyio.Path(self.dir).iterdir():
            if ID_RE.fullmatch(path.name) and path.name not in referenced:
                if (await path.stat()).st_mtime < cutoff:
                    await self.remove(path.name)


router = APIRouter(prefix="/api")


@router.post("/cameras/video-files", status_code=201, dependencies=[Depends(require("admin"))])
async def upload_video_file(
    request: Request, name: Annotated[str, Query(min_length=1, max_length=255)]
) -> VideoFile:
    """请求体为文件原始字节；先按 Content-Length 检查大小与磁盘空间，再流式写盘。"""
    length = request.headers.get("content-length")
    if length is None:
        raise HTTPException(411, "须给出 Content-Length")
    size = int(length)
    if size > MAX_BYTES:
        raise HTTPException(413, "视频超过 2 GB")
    videos: VideoFiles = request.app.state.videos
    free = (await anyio.to_thread.run_sync(disk_usage, videos.dir)).free
    if free - size < RESERVE_BYTES:
        raise HTTPException(507, "边缘主机磁盘空间不足")
    return await videos.save(request.stream(), size, name)
