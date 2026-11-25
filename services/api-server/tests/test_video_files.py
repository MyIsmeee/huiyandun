"""视频文件摄像头的上传（D-145、FR-914）：大小与磁盘空间检查、流式写盘、中断清理、未引用上传的清理。"""

import asyncio
import os
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import ClientDisconnect

from api_server import video_file
from api_server.app import create_app
from api_server.config import ApiConfig

rid = iter(range(10**6))
VIDEO = b"\x00\x00\x00\x18ftypmp42" + os.urandom(4096)


def headers() -> dict[str, str]:
    return {"X-Request-ID": f"req-video-{next(rid)}"}


@pytest.fixture
def videos(tmp_path: Path) -> Path:
    path = tmp_path / "camera-videos"
    path.mkdir()
    return path


@pytest.fixture
def client(db: tuple[ApiConfig, ApiConfig], password: str, videos: Path) -> Iterator[TestClient]:
    config = db[1].model_copy(update={"camera_video_dir": videos})
    with TestClient(create_app(config), base_url="https://testserver") as c:
        body = {"username": "admin", "password": password}
        assert c.post("/api/auth/login", json=body, headers=headers()).status_code == 200
        yield c


def upload(client: TestClient, content: Any, name: str = "门口.mp4", **extra: str) -> Any:
    return client.post(
        "/api/cameras/video-files",
        params={"name": name},
        content=content,
        headers=headers() | {"Content-Type": "application/octet-stream"} | extra,
    )


def test_upload_saved_with_original_name(client: TestClient, videos: Path) -> None:
    r = upload(client, VIDEO, name="C:\\fakepath\\走廊 东.mp4")
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["name"], body["size_bytes"]) == ("走廊 东.mp4", len(VIDEO))
    assert [p.name for p in videos.iterdir()] == [body["id"]]
    assert (videos / body["id"]).read_bytes() == VIDEO

    long = upload(client, VIDEO, name="长" * 250 + ".mp4").json()
    assert long["name"] == "长" * 200


def test_upload_requires_admin(client: TestClient, password: str, videos: Path) -> None:
    body = {"username": "operator", "password": password}
    assert client.post("/api/auth/login", json=body, headers=headers()).status_code == 200
    assert upload(client, VIDEO).status_code == 403
    assert list(videos.iterdir()) == []


def test_upload_too_large(client: TestClient, videos: Path) -> None:
    """AC-2：按 Content-Length 拒绝，不读请求体，卷中无残留。"""
    r = upload(client, b"x", **{"Content-Length": str(video_file.MAX_BYTES + 1)})
    assert r.status_code == 413
    assert r.json()["message"] == "视频超过 2 GB"
    assert list(videos.iterdir()) == []


def test_upload_without_length(client: TestClient, videos: Path) -> None:
    """分块传输没有 Content-Length：无法预先检查大小与磁盘空间。"""
    assert upload(client, iter([VIDEO])).status_code == 411
    assert list(videos.iterdir()) == []


def test_upload_disk_full(
    client: TestClient, videos: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-3：写入后剩余不足 2 GiB（录像与数据库同盘）时 507；恰好够时接受。"""
    free = [video_file.RESERVE_BYTES + len(VIDEO) - 1]
    monkeypatch.setattr(video_file, "disk_usage", lambda _: SimpleNamespace(free=free[0]))
    r = upload(client, VIDEO)
    assert r.status_code == 507
    assert r.json()["message"] == "边缘主机磁盘空间不足"
    assert list(videos.iterdir()) == []
    free[0] += 1
    assert upload(client, VIDEO).status_code == 201


async def chunks(*parts: bytes | BaseException) -> AsyncIterator[bytes]:
    for part in parts:
        if isinstance(part, BaseException):
            raise part
        yield part


def test_upload_aborted_cleans_up(videos: Path) -> None:
    """AC-4：中途断开、请求体短于声明的长度时删除写了一半的文件。"""
    files = video_file.VideoFiles(videos)
    with pytest.raises(ClientDisconnect):
        asyncio.run(files.save(chunks(VIDEO[:100], ClientDisconnect()), len(VIDEO), "a.mp4"))
    assert list(videos.iterdir()) == []
    with pytest.raises(HTTPException) as e:
        asyncio.run(files.save(chunks(VIDEO[:100]), len(VIDEO), "a.mp4"))
    assert e.value.status_code == 400
    assert list(videos.iterdir()) == []


def test_orphan_upload_removed(videos: Path) -> None:
    """AC-9：10 分钟内未被摄像头引用的上传删除；刚上传的与已被引用的保留。"""
    files = video_file.VideoFiles(videos)
    old, used, fresh = (
        asyncio.run(files.save(chunks(VIDEO), len(VIDEO), f"{n}.mp4")).id.root
        for n in ("old", "used", "fresh")
    )
    stale = time.time() - video_file.ORPHAN_S - 60
    for name in (old, used):
        os.utime(videos / name, (stale, stale))

    asyncio.run(files.prune({used}))
    assert {p.name for p in videos.iterdir()} == {used, fresh}
    with pytest.raises(HTTPException):
        files.name(old)
    assert files.name(fresh) == "fresh.mp4"
