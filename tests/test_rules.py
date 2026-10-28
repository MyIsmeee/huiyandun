"""检测规则的静态约束：样本可由脚本重现，外部规则快照与登记一致。回放校验见 make test-rules。"""

import hashlib
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "rules/tests/HYD-NET-0001"


def test_samples_reproducible(tmp_path: Path) -> None:
    """R-02：入库的合成样本与生成脚本的输出逐字节一致，每个样本都有同名 .meta.yaml。"""
    subprocess.run(
        [sys.executable, ROOT / "tools/dev/rtsp_pcap.py", tmp_path], check=True, timeout=30
    )
    generated = {p.name: p.read_bytes() for p in tmp_path.glob("*.pcap")}
    assert generated == {p.name: p.read_bytes() for p in SAMPLES.glob("*.pcap")}
    assert {p.name.removesuffix(".meta.yaml") for p in SAMPLES.glob("*.meta.yaml")} == {
        name.removesuffix(".pcap") for name in generated
    }


def test_vendor_rulesets_registered() -> None:
    """C-RU-01：rules/vendor/ 下的快照逐一登记于 deploy/third-party.yaml，哈希一致。"""
    registry = yaml.safe_load((ROOT / "deploy/third-party.yaml").read_text(encoding="utf-8"))
    registered = {r["file"]: r["sha256"] for r in registry["rulesets"]}
    snapshots = {
        p.relative_to(ROOT).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in (ROOT / "rules/vendor").rglob("*.tar.gz")
    }
    assert snapshots == registered
