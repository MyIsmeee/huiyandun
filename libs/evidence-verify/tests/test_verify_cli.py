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


def test_corrupted_or_unsupported_entry_exits_2(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """包内某个文件的压缩流被改坏，或用了读不了的压缩方式：按读不了的包处理（退出码 2），不以 traceback 收场。"""
    payload = bytes(range(256)) * 40
    damaged = tmp_path / "damaged.zip"
    with zipfile.ZipFile(damaged, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", payload)
    raw = bytearray(damaged.read_bytes())
    start = raw.index(b"manifest.json") + len("manifest.json")
    raw[start : start + 8] = b"\xff" * 8  # 压缩流开头
    damaged.write_bytes(raw)
    unsupported = tmp_path / "unsupported.zip"
    with zipfile.ZipFile(unsupported, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", payload)
    raw = bytearray(unsupported.read_bytes())
    for marker in (b"PK\x03\x04", b"PK\x01\x02"):  # 本地文件头与中央目录中的压缩方式改为未定义的 99
        at = raw.index(marker) + (8 if marker.endswith(b"\x04") else 10)
        raw[at : at + 2] = (99).to_bytes(2, "little")
    unsupported.write_bytes(raw)

    for package in (damaged, unsupported):
        assert main(["verify", str(package), "--fingerprint", "sha256:00"]) == 2
        assert "无法读取证据包" in capsys.readouterr().err
