"""hyd-evidence verify <证据包 zip 或解压目录> --fingerprint sha256:…（C-EVD-03）。

退出码：0 通过，1 未通过，2 用法错误或包无法读取。
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path

from evidence_verify.verify import verify


def read(path: Path) -> dict[str, bytes]:
    """zip 只读入内存、不解压到磁盘；目录用于演示时解压后改一条记录再校验。"""
    if path.is_dir():
        return {
            p.relative_to(path).as_posix(): p.read_bytes() for p in path.rglob("*") if p.is_file()
        }
    with zipfile.ZipFile(path) as z:
        return {name: z.read(name) for name in z.namelist() if not name.endswith("/")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="hyd-evidence", description="慧眼盾证据包离线校验：防篡改存证、可独立校验"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("verify", help="校验证据包")
    cmd.add_argument("package", type=Path, help="证据包 zip，或其解压目录")
    cmd.add_argument(
        "--fingerprint",
        required=True,
        help="另行取得的可信公钥指纹：evidence-service 启动日志 evidence.started 的 "
        "public_key_fingerprint",
    )
    args = parser.parse_args(argv)
    try:
        files = read(args.package)
    except (OSError, zipfile.BadZipFile) as e:
        print(f"无法读取证据包：{e}", file=sys.stderr)
        return 2

    problems = verify(files, args.fingerprint)
    if problems:
        print("校验未通过：")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    manifest = json.loads(files["manifest.json"])
    records = manifest["records"]
    print(
        f"校验通过：关联事件 {manifest['incident_id']}，第 {records['first_seq']}～"
        f"{records['last_seq']} 条共 {records['count']} 条记录、{len(files)} 个文件，"
        "签名有效，公钥指纹与可信值一致"
    )
    return 0
