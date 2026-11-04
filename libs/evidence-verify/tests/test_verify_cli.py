"""hyd-evidence verify 命令行（TK-081，C-EVD-03）：退出码与输出。"""

import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from evidence_service.store import Chain, Entry
from evidence_verify.cli import main


def test_verifies_zip_then_locates_edit_in_extracted_dir(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """演示第 11 步：先校验导出的 zip，解压后改一条记录再校验目录。"""
    chain = Chain(tmp_path / "store", Ed25519PrivateKey.generate())
    chain.append([Entry("alert", "inc-b", {"event_id": "inc-b-a1"}, b'{"n":1}')])
    package = chain.package("inc-b")
    assert package is not None
    zip_path = tmp_path / "evidence-inc-b.zip"
    zip_path.write_bytes(package)

    assert main(["verify", str(zip_path), "--fingerprint", chain.fingerprint]) == 0
    assert "校验通过：关联事件 inc-b，第 1～1 条共 1 条记录" in capsys.readouterr().out

    extracted = tmp_path / "extracted"
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(extracted)
    record = extracted / "chain.jsonl"
    record.write_bytes(record.read_bytes().replace(b"inc-b-a1", b"inc-b-a2"))
    assert main(["verify", str(extracted), "--fingerprint", chain.fingerprint]) == 1
    out = capsys.readouterr().out
    assert "校验未通过" in out
    assert "第 1 条记录（chain.jsonl 第 1 行）内容与其摘要不符" in out


def test_unreadable_package_exits_2(tmp_path: Path) -> None:
    bad = tmp_path / "bad.zip"
    bad.write_bytes(b"not a zip")
    assert main(["verify", str(bad), "--fingerprint", "sha256:00"]) == 2
