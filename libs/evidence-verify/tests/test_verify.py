"""离线校验工具（TK-081，FR-703、C-EVD-03）：用 evidence-service 生成真实证据包，逐类篡改后校验并定位。"""

import base64
import io
import json
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from evidence_service.store import Chain, Entry, canonical, record_hash
from evidence_verify.verify import verify

CHAIN_CHANGED = "chain.jsonl 与 manifest 记录的摘要不符（文件被改）"
MANIFEST_BAD = "manifest 签名无效：manifest.json 或 manifest.sig 被改"


def entries(incident_id: str) -> list[Entry]:
    return [
        Entry(
            "alert",
            incident_id,
            {"event_id": f"{incident_id}-a1"},
            b'{"n":"%s"}' % incident_id.encode(),
        ),
        Entry("incident", incident_id, {}, b'{"id":"%s"}' % incident_id.encode()),
        Entry("video", incident_id, {"device_id": "cam-02"}, b"ftyp" + incident_id.encode(), "mp4"),
        Entry("video_unavailable", incident_id, {"device_id": "cam-02", "reason": "该时段无录像"}),
    ]


def package(root: Path, key: Ed25519PrivateKey) -> tuple[dict[str, bytes], str]:
    """inc-b 的证据包（第 5～8 条：告警、关联事件、录像、录像不可用）与签名公钥指纹。"""
    chain = Chain(root, key)
    chain.append(entries("inc-a"))
    chain.append(entries("inc-b"))
    data = chain.package("inc-b")
    assert data is not None
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}, chain.fingerprint


@pytest.fixture
def pkg(tmp_path: Path) -> tuple[dict[str, bytes], str]:
    return package(tmp_path / "store", Ed25519PrivateKey.generate())


def records(files: dict[str, bytes]) -> list[dict]:
    return [json.loads(line) for line in files["chain.jsonl"].splitlines()]


def with_records(files: dict[str, bytes], rows: list[dict]) -> dict[str, bytes]:
    return files | {"chain.jsonl": b"".join(canonical(r) + b"\n" for r in rows)}


def test_untouched_package_passes(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    assert verify(files, fingerprint) == []
    assert verify(files, fingerprint.removeprefix("sha256:").upper()) == []


def test_package_resigned_with_another_key_is_untrusted(
    tmp_path: Path, pkg: tuple[dict[str, bytes], str]
) -> None:
    """换钥整包重签后签名全部有效，只有比对另行取得的指纹才能识破（080 §4 信任起点）。"""
    _, trusted = pkg
    forged, forged_fingerprint = package(tmp_path / "forged", Ed25519PrivateKey.generate())
    assert verify(forged, trusted) == [
        f"公钥指纹与可信值不符（包内为 {forged_fingerprint}），整个包不可信"
    ]


def test_edited_record_is_located(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    rows = records(files)
    rows[1]["meta"] = {"note": "改过"}
    assert verify(with_records(files, rows), fingerprint) == [
        CHAIN_CHANGED,
        "第 6 条记录（chain.jsonl 第 2 行）内容与其摘要不符（记录被改）",
    ]


def test_edited_record_with_recomputed_hash_fails_signature(
    pkg: tuple[dict[str, bytes], str],
) -> None:
    files, fingerprint = pkg
    rows = records(files)
    rows[1]["meta"] = {"note": "改过"}
    rows[1]["hash"] = record_hash(rows[1])
    assert verify(with_records(files, rows), fingerprint) == [
        CHAIN_CHANGED,
        "第 6 条记录（chain.jsonl 第 2 行）签名无效",
        "第 7 条记录（chain.jsonl 第 3 行）与上一条不衔接（其间记录被删、插入或被改）",
    ]


def test_replaced_record_signature_is_located(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    rows = records(files)
    rows[1]["sig"] = rows[0]["sig"]
    assert verify(with_records(files, rows), fingerprint) == [
        CHAIN_CHANGED,
        "第 6 条记录（chain.jsonl 第 2 行）签名无效",
    ]


def test_edited_manifest_fails_manifest_signature(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    manifest = json.loads(files["manifest.json"])
    manifest["exported_at"] = "2020-01-01T00:00:00.000+00:00"
    edited = files | {"manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2).encode()}
    assert verify(edited, fingerprint) == [MANIFEST_BAD]


def test_replaced_manifest_signature_fails(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    assert verify(files | {"manifest.sig": b"AAAA"}, fingerprint) == [MANIFEST_BAD]


def test_edited_payload_is_located(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    ref = records(files)[2]["payload_ref"]
    assert verify(files | {ref: b"ftypother"}, fingerprint) == [
        f"{ref} 与 manifest 记录的摘要不符（文件被改）",
        f"第 7 条记录（chain.jsonl 第 3 行）引用的载荷 {ref} 与文件名中的摘要不符（载荷被改）",
    ]


def test_deleted_middle_record_breaks_link(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    rows = records(files)
    del rows[1]
    assert verify(with_records(files, rows), fingerprint) == [
        CHAIN_CHANGED,
        "第 7 条记录（chain.jsonl 第 2 行）与上一条不衔接（其间记录被删、插入或被改）",
        "记录区间与 manifest 不符：manifest 为第 5～8 条共 4 条，包内为第 5～8 条共 3 条（记录被删或被加）",
    ]


def test_deleted_last_record_mismatches_manifest(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    assert verify(with_records(files, records(files)[:-1]), fingerprint) == [
        CHAIN_CHANGED,
        "记录区间与 manifest 不符：manifest 为第 5～8 条共 4 条，包内为第 5～7 条共 3 条（记录被删或被加）",
        "最后一条记录的摘要与 manifest 的 chain_head 不符",
    ]


def test_garbled_line_is_reported_without_crash(pkg: tuple[dict[str, bytes], str]) -> None:
    files, fingerprint = pkg
    lines = files["chain.jsonl"].splitlines()
    lines[1] = b'{"seq": "x"'
    problems = verify(files | {"chain.jsonl": b"\n".join(lines) + b"\n"}, fingerprint)
    assert "chain.jsonl 第 2 行无法解析" in problems


def test_unsupported_key_type_is_reported(pkg: tuple[dict[str, bytes], str]) -> None:
    """cryptography 不支持的公钥算法抛 UnsupportedAlgorithm（不是 ValueError），须报问题而非崩溃（复核建议 3）。"""
    files, fingerprint = pkg
    der = (
        Ed25519PrivateKey.generate()
        .public_key()
        .public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    )
    unknown = der.replace(bytes.fromhex("06032b6570"), bytes.fromhex("06032b657f"))  # 未知算法 OID
    pem = (
        b"-----BEGIN PUBLIC KEY-----\n"
        + base64.b64encode(unknown)
        + b"\n-----END PUBLIC KEY-----\n"
    )
    assert verify(files | {"public_key.pem": pem}, fingerprint) == ["public_key.pem 无法解析"]
