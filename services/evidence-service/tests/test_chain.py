"""存证哈希链与证据包结构（TK-080，设计 080-evidence.md §3.2、§4）。"""

import base64
import hashlib
import io
import json
import zipfile
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_pem_public_key

from evidence_service.store import GENESIS, Chain, ChainBroken, Entry, canonical, record_hash

ALERT = b'{"event_id":"a1"}'
CLIP = b"\x00\x00\x00\x18ftypmp42"


def entries(incident_id: str) -> list[Entry]:
    return [
        Entry("alert", incident_id, {"event_id": "a1"}, ALERT),
        Entry("incident", incident_id, {}, b'{"id":"%s"}' % incident_id.encode()),
        Entry(
            "video",
            incident_id,
            {"device_id": "cam-02", "stream": "cam-02", "start": "s", "end": "e"},
            CLIP,
            "mp4",
        ),
        Entry("video_unavailable", incident_id, {"device_id": "cam-02", "reason": "该时段无录像"}),
    ]


@pytest.fixture
def signer() -> Ed25519PrivateKey:
    return Ed25519PrivateKey.generate()


def unzip(package: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(package)) as z:
        return {name: z.read(name) for name in z.namelist()}


def test_package_holds_signed_contiguous_records_of_one_incident(
    tmp_path: Path, signer: Ed25519PrivateKey
) -> None:
    chain = Chain(tmp_path, signer)
    chain.append(entries("inc-a"))
    chain.append(entries("inc-b"))

    package = chain.package("inc-b")

    assert package is not None
    files = unzip(package)
    alert_ref = f"objects/{hashlib.sha256(ALERT).hexdigest()}.json"
    clip_ref = f"objects/{hashlib.sha256(CLIP).hexdigest()}.mp4"
    assert set(files) >= {
        "manifest.json",
        "manifest.sig",
        "public_key.pem",
        "chain.jsonl",
        alert_ref,
        clip_ref,
    }
    public = load_pem_public_key(files["public_key.pem"])
    assert isinstance(public, Ed25519PublicKey)
    public.verify(base64.b64decode(files["manifest.sig"]), files["manifest.json"])

    manifest = json.loads(files["manifest.json"])
    records = [json.loads(line) for line in files["chain.jsonl"].splitlines()]
    assert manifest["format"] == "hyd-evidence/1"
    assert manifest["incident_id"] == "inc-b"
    assert manifest["records"] == {"first_seq": 5, "last_seq": 8, "count": 4}
    assert manifest["chain_head"] == records[-1]["hash"]
    assert manifest["verify_tool_version"] == "0.1.0"
    raw = public.public_bytes(Encoding.Raw, PublicFormat.Raw)
    assert manifest["public_key_fingerprint"] == "sha256:" + hashlib.sha256(raw).hexdigest()
    # manifest 列出除自身与签名外的全部文件及其摘要
    assert set(manifest["files"]) == set(files) - {"manifest.json", "manifest.sig"}
    for path, digest in manifest["files"].items():
        assert hashlib.sha256(files[path]).hexdigest() == digest

    assert [r["incident_id"] for r in records] == ["inc-b"] * 4
    assert [r["kind"] for r in records] == ["alert", "incident", "video", "video_unavailable"]
    assert records[2]["payload_ref"] == clip_ref
    assert records[3]["payload_ref"] is None
    for prev, record in zip(records, records[1:], strict=False):
        assert record["prev_hash"] == prev["hash"]
    for record in records:
        assert record["hash"] == record_hash(record)
        public.verify(base64.b64decode(record["sig"]), bytes.fromhex(record["hash"]))


def test_unknown_incident_has_no_package(tmp_path: Path, signer: Ed25519PrivateKey) -> None:
    chain = Chain(tmp_path, signer)
    chain.append(entries("inc-a"))

    assert chain.package("inc-x") is None


def test_reload_continues_chain_and_stores_payload_once(
    tmp_path: Path, signer: Ed25519PrivateKey
) -> None:
    Chain(tmp_path, signer).append(entries("inc-a"))

    chain = Chain(tmp_path, signer)
    chain.append(entries("inc-b"))

    assert chain.incidents == {"inc-a", "inc-b"}
    lines = [json.loads(line) for line in (tmp_path / "chain.jsonl").read_bytes().splitlines()]
    assert [r["seq"] for r in lines] == list(range(1, 9))
    assert lines[0]["prev_hash"] == GENESIS
    assert lines[4]["prev_hash"] == lines[3]["hash"]
    # 两个关联事件引用同一告警载荷：只存一份，且只读（C-EVD-01）
    objects = sorted((tmp_path / "objects").iterdir())
    assert len(objects) == 4  # 告警、两个关联事件、录像
    assert all(p.stat().st_mode & 0o222 == 0 for p in objects)


def rehash_from(records: list[dict], start: int) -> None:
    """篡改者没有私钥：改动后把其后各条的哈希与衔接重新算一遍，签名保持原样。"""
    for i in range(start, len(records)):
        if i:
            records[i]["prev_hash"] = records[i - 1]["hash"]
        records[i]["hash"] = record_hash(records[i])


@pytest.mark.parametrize(
    ("tamper", "seq", "reason"),
    [
        ("edit", 2, "与重算结果不一致"),
        ("delete", 2, "与上一条不衔接"),
        ("edit_and_rehash", 2, "签名无效"),
        ("swap_signature", 2, "签名无效"),
        ("torn_last_line", 4, "无法解析"),
    ],
)
def test_broken_chain_refuses_to_load(
    tmp_path: Path, signer: Ed25519PrivateKey, tamper: str, seq: int, reason: str
) -> None:
    Chain(tmp_path, signer).append(entries("inc-a"))
    path = tmp_path / "chain.jsonl"
    lines = path.read_bytes().splitlines(keepends=True)
    records = [json.loads(line) for line in lines]
    if tamper == "edit":
        lines[1] = lines[1].replace(b'"kind":"incident"', b'"kind":"alert"')
    elif tamper == "delete":
        del lines[1]
    elif tamper == "torn_last_line":
        lines[3] = lines[3][: len(lines[3]) // 2]  # 写到一半断电
    else:
        if tamper == "edit_and_rehash":
            records[1]["kind"] = "alert"
            rehash_from(records, 1)
        else:
            records[1]["sig"] = records[0]["sig"]
        lines = [canonical(r) + b"\n" for r in records]
    path.write_bytes(b"".join(lines))

    with pytest.raises(ChainBroken, match=f"第 {seq} 条{reason}"):
        Chain(tmp_path, signer)
