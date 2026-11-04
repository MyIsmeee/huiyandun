"""hyd-evidence verify 命令行（TK-081，C-EVD-03）：退出码与输出。"""

import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from evidence_service.store import Chain, Entry
from evidence_verify import cli
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


@pytest.mark.filterwarnings("ignore:Duplicate name")  # 构造同名条目时 zipfile 的提示
def test_duplicate_entry_names_exit_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """zip 可含同名条目：不同解压工具取到的可能是伪造的那份，校验的与人看到的不是同一份（复核阻断 1）。"""
    chain = Chain(tmp_path / "store", Ed25519PrivateKey.generate())
    chain.append([Entry("alert", "inc-b", {"event_id": "inc-b-a1"}, b'{"n":1}')])
    package = chain.package("inc-b")
    assert package is not None
    original = tmp_path / "original.zip"
    original.write_bytes(package)
    forged = tmp_path / "forged.zip"
    with zipfile.ZipFile(original) as src, zipfile.ZipFile(forged, "w") as dst:
        dst.writestr("chain.jsonl", b'{"forged":true}\n')
        for name in src.namelist():
            dst.writestr(name, src.read(name))

    assert main(["verify", str(forged), "--fingerprint", chain.fingerprint]) == 2
    assert "同名文件" in capsys.readouterr().err


def test_oversized_package_exits_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """按条目声明的解压后大小先行拒绝，不把超大包读进内存（复核建议 2）。"""
    monkeypatch.setattr(cli, "MAX_TOTAL_BYTES", 16)
    big = tmp_path / "big.zip"
    with zipfile.ZipFile(big, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("chain.jsonl", b"0" * 17)

    assert main(["verify", str(big), "--fingerprint", "sha256:00"]) == 2
    assert "过大" in capsys.readouterr().err
