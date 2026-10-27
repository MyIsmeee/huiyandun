"""CV 模型权重的下载与校验（C-CV-01、C-CV-07、C-RU-01、C-RU-06、G-15）。

用法：python tools/dev/models.py fetch|verify <models 目录>
权重不入库（R-03）：fetch 按 registry.yaml 的 source 下载压缩包，校验哈希后取出 source_member，
写到 <models 目录>/weights/<file>；已存在且哈希一致时跳过。verify 检查每个模型的字段、类别、许可证、
模型卡与权重哈希。任一不符以 1 退出。
"""

import hashlib
import io
import sys
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

import yaml

FIELDS = (
    "name",
    "version",
    "task",
    "file",
    "sha256",
    "source",
    "source_sha256",
    "source_member",
    "license",
    "card",
    "purpose",
    "owner",
)
# 类别白名单：人脸检测/识别、ReID、属性识别不得加入（G-04、C-CV-01）
TASKS = {"pose"}  # 人体检测与骨骼关键点
# G-08 白名单中适用于模型权重的许可证（SPDX）
LICENSES = {"Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0"}
TIMEOUT_S = 300  # 单个压缩包下载上限


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(models: Path, model: dict[str, Any]) -> str | None:
    target = models / "weights" / model["file"]
    if target.exists() and sha256(target.read_bytes()) == model["sha256"]:
        return None
    with urllib.request.urlopen(model["source"], timeout=TIMEOUT_S) as response:
        archive = response.read()
    if sha256(archive) != model["source_sha256"]:
        return f"{model['name']}: 压缩包哈希不符，拒绝使用"
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        weights = z.read(model["source_member"])
    if sha256(weights) != model["sha256"]:
        return f"{model['name']}: 权重哈希不符，拒绝使用"
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(weights)
    return None


def verify(models: Path, model: dict[str, Any]) -> list[str]:
    name = model.get("name", "<未命名>")
    missing = [field for field in FIELDS if not model.get(field)]
    if missing:
        return [f"{name}: 缺少字段 {field}" for field in missing]
    errors = []
    if model["task"] not in TASKS:
        errors.append(f"{name}: 类别 {model['task']} 不在白名单（C-CV-01）")
    if model["license"] not in LICENSES:
        errors.append(f"{name}: 许可证 {model['license']} 不在白名单（G-08）")
    if not (models / model["card"]).is_file():
        errors.append(f"{name}: 缺少模型卡 {model['card']}（C-CV-07）")
    weights = models / "weights" / model["file"]
    if not weights.is_file():
        errors.append(f"{name}: 权重未下载，先运行 make fetch-models")
    elif sha256(weights.read_bytes()) != model["sha256"]:
        errors.append(f"{name}: 权重哈希不符（G-15）")
    return errors


def main(command: str, models: Path) -> int:
    registry = yaml.safe_load((models / "registry.yaml").read_text(encoding="utf-8"))
    if command == "fetch":
        errors = [e for m in registry["models"] if (e := fetch(models, m))]
    else:
        errors = [e for m in registry["models"] for e in verify(models, m)]
    for error in errors:
        print(error, file=sys.stderr)
    if not errors:
        print(f"{len(registry['models'])} 个模型{'已下载' if command == 'fetch' else '校验通过'}")
    return 1 if errors else 0


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("fetch", "verify"):
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
