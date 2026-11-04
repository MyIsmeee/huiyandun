"""存证哈希链（设计 080-evidence.md §3.2、§4）：只追加、逐条 Ed25519 签名（D-098），按关联事件导出证据包。

没有修改或删除接口（C-EVD-01）。evidence-service 是唯一写入方（D-04），调用方保证 append 串行。
"""

import base64
import hashlib
import io
import json
import os
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

FORMAT = "hyd-evidence/1"
VERIFY_TOOL_VERSION = "0.1.0"  # 能校验 FORMAT 的 hyd-evidence verify 最低版本（TK-081）
GENESIS = "0" * 64
HASHED = ("seq", "prev_hash", "kind", "incident_id", "payload_ref", "meta", "created_at")


class ChainBroken(Exception):
    """链上记录与重算结果不一致：不在已损坏的链后追加。"""


@dataclass(frozen=True)
class Entry:
    kind: str
    incident_id: str
    meta: dict[str, Any]
    payload: bytes | None = None
    ext: str = "json"


def canonical(value: Any) -> bytes:
    """键排序、无空白、UTF-8：记录摘要与 chain.jsonl 的每一行都用此序列化。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def record_hash(record: dict[str, Any]) -> str:
    return sha256(canonical({k: record[k] for k in HASHED}))


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Chain:
    def __init__(self, root: Path, key: Ed25519PrivateKey) -> None:
        """读入并逐条重算哈希、验签已有的链；无法解析、不一致或签名无效时抛 ChainBroken。

        只重算哈希挡不住改记录后把其后各条重新计算的篡改：验签须用私钥才能伪造。"""
        self._root = root
        self._key = key
        self._file = root / "chain.jsonl"
        public = key.public_key()
        self._public_pem = public.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        self._public = public
        self.fingerprint = "sha256:" + sha256(public.public_bytes(Encoding.Raw, PublicFormat.Raw))
        (root / "objects").mkdir(parents=True, exist_ok=True)
        self._records: list[dict[str, Any]] = []
        if self._file.exists():
            for seq, line in enumerate(self._file.read_bytes().splitlines(), 1):
                self._check(seq, line)
        self.incidents = {r["incident_id"] for r in self._records}

    def _check(self, seq: int, line: bytes) -> None:
        """写到一半断电留下的残行同样按第几条报错。"""
        prev = self._records[-1]["hash"] if self._records else GENESIS
        try:
            record = json.loads(line)
            if record["seq"] != seq or record["prev_hash"] != prev:
                raise ChainBroken(f"存证链第 {seq} 条与上一条不衔接")
            if record["hash"] != record_hash(record):
                raise ChainBroken(f"存证链第 {seq} 条与重算结果不一致")
            self._public.verify(base64.b64decode(record["sig"]), bytes.fromhex(record["hash"]))
        except (ValueError, KeyError, TypeError) as e:  # JSON 与 Base64 的解析错误均为 ValueError
            raise ChainBroken(f"存证链第 {seq} 条无法解析") from e
        except InvalidSignature as e:
            raise ChainBroken(f"存证链第 {seq} 条签名无效") from e
        self._records.append(record)

    def append(self, entries: list[Entry]) -> None:
        """载荷与其目录项先 fsync，记录整批追加后 fsync：断电后链上的记录不会指向不存在的载荷；
        一个关联事件的记录在链上连续（080 §3.1）。"""
        prev = self._records[-1]["hash"] if self._records else GENESIS
        added: list[dict[str, Any]] = []
        for entry in entries:
            record: dict[str, Any] = {
                "seq": len(self._records) + len(added) + 1,
                "prev_hash": prev,
                "kind": entry.kind,
                "incident_id": entry.incident_id,
                "payload_ref": None if entry.payload is None else self._store(entry),
                "meta": entry.meta,
                "created_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
            }
            record["hash"] = prev = record_hash(record)
            record["sig"] = base64.b64encode(self._key.sign(bytes.fromhex(prev))).decode()
            added.append(record)
        if any(r["payload_ref"] is not None for r in added):
            _fsync_dir(self._root / "objects")
        with self._file.open("ab") as f:
            f.write(b"".join(canonical(r) + b"\n" for r in added))
            f.flush()
            os.fsync(f.fileno())
        self._records += added
        self.incidents.update(r["incident_id"] for r in added)

    def _store(self, entry: Entry) -> str:
        """按内容寻址，写入后只读；同一载荷只存一份。"""
        assert entry.payload is not None
        ref = f"objects/{sha256(entry.payload)}.{entry.ext}"
        path = self._root / ref
        if not path.exists():
            tmp = path.with_name(path.name + ".tmp")
            with tmp.open("wb") as f:
                f.write(entry.payload)
                f.flush()
                os.fsync(f.fileno())
            tmp.chmod(0o444)
            tmp.replace(path)
        return ref

    def package(self, incident_id: str) -> bytes | None:
        """证据包 zip（080 §4）；该关联事件没有记录时为 None。"""
        records = [r for r in self._records if r["incident_id"] == incident_id]
        if not records:
            return None
        files = {
            "chain.jsonl": b"".join(canonical(r) + b"\n" for r in records),
            "public_key.pem": self._public_pem,
        }
        for r in records:
            if r["payload_ref"] is not None:
                files[r["payload_ref"]] = (self._root / r["payload_ref"]).read_bytes()
        manifest = json.dumps(
            {
                "format": FORMAT,
                "incident_id": incident_id,
                "exported_at": datetime.now(UTC).isoformat(timespec="milliseconds"),
                "records": {
                    "first_seq": records[0]["seq"],
                    "last_seq": records[-1]["seq"],
                    "count": len(records),
                },
                "chain_head": records[-1]["hash"],
                "files": {path: sha256(data) for path, data in files.items()},
                "public_key_fingerprint": self.fingerprint,
                "verify_tool_version": VERIFY_TOOL_VERSION,
            },
            ensure_ascii=False,
            indent=2,
        ).encode()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("manifest.json", manifest)
            z.writestr("manifest.sig", base64.b64encode(self._key.sign(manifest)))
            for path, data in files.items():
                z.writestr(path, data)
        return buf.getvalue()
