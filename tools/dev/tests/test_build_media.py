"""演示视频剪接（DM-12、FR-306）：以假 docker 记录调用，不真正运行 ffmpeg。"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "build_media.py"
FAKE_DOCKER = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case " $* " in *" --entrypoint ffprobe "*) echo "$FAKE_DURATION" ;; esac
"""


@pytest.fixture
def media(tmp_path: Path) -> Path:
    media = tmp_path / "media"
    (media / "src").mkdir(parents=True)
    for name in ("a.mp4", "b.mp4"):
        (media / "src" / name).write_bytes(b"")
    (media / "cam-01.meta.yaml").write_text(
        "segments:\n  - { file: b.mp4 }\n  - { file: a.mp4 }\n", encoding="utf-8"
    )
    return media


def run(media: Path, duration: str) -> tuple[subprocess.CompletedProcess[str], str]:
    bin_dir = media.parent / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER, encoding="utf-8")
    docker.chmod(0o755)
    log = media.parent / "docker.log"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_LOG": str(log),
        "FAKE_DURATION": duration,
    }
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(media), "mediamtx:test"],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    return result, log.read_text(encoding="utf-8") if log.exists() else ""


def test_segments_concatenated_in_meta_order(media: Path) -> None:
    result, calls = run(media, "500.0")
    assert result.returncode == 0, result.stderr
    ffmpeg = calls.splitlines()[0]
    assert "--network none" in ffmpeg
    assert "-i /media/src/b.mp4 -i /media/src/a.mp4" in ffmpeg
    assert "concat=n=2:v=1:a=0" in ffmpeg
    assert ffmpeg.endswith("/media/cam-01.mp4")


def test_output_shorter_than_8_minutes_rejected(media: Path) -> None:
    output = media / "cam-01.mp4"
    output.write_bytes(b"")
    result, _ = run(media, "479.9")
    assert result.returncode == 1
    assert "FR-306" in result.stderr
    assert not output.exists()


def test_missing_source_rejected_before_encoding(media: Path) -> None:
    (media / "src" / "a.mp4").unlink()
    result, calls = run(media, "500.0")
    assert result.returncode == 1
    assert "a.mp4" in result.stderr
    assert calls == ""
