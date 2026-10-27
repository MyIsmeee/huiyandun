"""按 <流名>.meta.yaml 的片段清单剪接演示视频（DM-12、FR-306）。

用法：python tools/dev/build_media.py <素材目录> <mediamtx 镜像>
原始片段在 <素材目录>/src/，成品写到 <素材目录>/<流名>.mp4；视频均不入库（R-01）。
ffmpeg 在 mediamtx 镜像中断网运行，宿主机无需安装。成品短于 8 分钟时删除并以 1 退出。
"""

import subprocess
import sys
from pathlib import Path

import yaml

MIN_DURATION_S = 480  # 单次播放不少于 8 分钟（FR-306）
# 统一为 site.yaml 标定所用的 1280×720；不足处居中补黑边
VIDEO_FILTER = (
    "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:-1:-1,"
    "fps=25,setsar=1,format=yuv420p"
)
# 浏览器 WebRTC 不支持 B 帧；每 2 s 一个关键帧，新接入的观看端无需久等首帧；去除音轨
ENCODE = ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-bf", "0", "-g", "50"]


def docker(media: Path, image: str, program: str, *args: str) -> str:
    cmd = ["docker", "run", "--rm", "--network", "none", "-v", f"{media}:/media"]
    cmd += ["--entrypoint", program, image, *args]
    # 单路约 9 分钟素材在 CPU 上转码数分钟，30 分钟为上限
    return subprocess.run(cmd, check=True, stdout=subprocess.PIPE, text=True, timeout=1800).stdout


def build(media: Path, image: str, stream: str, files: list[str]) -> float:
    inputs = [arg for name in files for arg in ("-i", f"/media/src/{name}")]
    graph = "".join(f"[{i}:v]{VIDEO_FILTER}[v{i}];" for i in range(len(files)))
    graph += "".join(f"[v{i}]" for i in range(len(files)))
    graph += f"concat=n={len(files)}:v=1:a=0[out]"
    output = f"/media/{stream}.mp4"
    docker(
        media,
        image,
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        *inputs,
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        *ENCODE,
        "-movflags",
        "+faststart",
        output,
    )
    probe = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output]
    return float(docker(media, image, "ffprobe", *probe))


def main(media: Path, image: str) -> int:
    for meta in sorted(media.glob("*.meta.yaml")):
        stream = meta.name.removesuffix(".meta.yaml")
        files = [s["file"] for s in yaml.safe_load(meta.read_text(encoding="utf-8"))["segments"]]
        missing = [name for name in files if not (media / "src" / name).is_file()]
        if missing:
            print(f"{meta.name}：src/ 中缺少 {', '.join(missing)}", file=sys.stderr)
            return 1
        duration = build(media, image, stream, files)
        if duration < MIN_DURATION_S:
            (media / f"{stream}.mp4").unlink(missing_ok=True)
            print(
                f"{stream}.mp4：{duration:.0f} 秒，短于 {MIN_DURATION_S} 秒（FR-306）",
                file=sys.stderr,
            )
            return 1
        print(f"{stream}.mp4：{duration:.0f} 秒，{len(files)} 个片段")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]).resolve(), sys.argv[2]))
