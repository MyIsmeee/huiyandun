"""证据包离线校验（设计 080-evidence.md §4）：只读包内文件，不访问网络，不依赖慧眼盾的其他部分。

格式按 080 §4 独立实现，不 import evidence-service：校验方不复用写入方的代码。
信任起点是另行取得的公钥指纹：包内自带公钥，篡改者可以换钥后整包重签，所以指纹不符即判整包不可信、
不再看签名。指纹相符后检查全部项目并逐条写明位置，不在第一处问题就停。
"""

import base64
import hashlib
import json
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_pem_public_key

FORMAT = "hyd-evidence/1"
VERSION = (0, 1, 0)  # 与 pyproject.toml 一致；包的 verify_tool_version 高于此即无法校验
HASHED = ("seq", "prev_hash", "kind", "incident_id", "payload_ref", "meta", "created_at")
REQUIRED = ("manifest.json", "manifest.sig", "public_key.pem", "chain.jsonl")
MANIFEST_TEXT = ("format", "incident_id", "chain_head", "public_key_fingerprint")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    """键排序、无空白、UTF-8：记录摘要的序列化方式。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _signed(key: Ed25519PublicKey, sig: str | bytes, data: bytes) -> bool:
    try:
        key.verify(base64.b64decode(sig, validate=True), data)
    except (InvalidSignature, ValueError):  # Base64 解析错误是 ValueError
        return False
    return True


def verify(files: dict[str, bytes], trusted_fingerprint: str) -> list[str]:
    """返回发现的问题，空列表即校验通过。files 为包内路径 → 内容。"""
    missing = [name for name in REQUIRED if name not in files]
    if missing:
        return [f"缺少文件：{'、'.join(missing)}"]
    try:
        key = load_pem_public_key(files["public_key.pem"])
    except ValueError:
        return ["public_key.pem 无法解析"]
    if not isinstance(key, Ed25519PublicKey):
        return ["public_key.pem 不是 Ed25519 公钥"]
    actual = "sha256:" + sha256(key.public_bytes(Encoding.Raw, PublicFormat.Raw))
    trusted = trusted_fingerprint.strip().lower()
    if actual != (trusted if trusted.startswith("sha256:") else "sha256:" + trusted):
        return [f"公钥指纹与可信值不符（包内为 {actual}），整个包不可信"]

    problems: list[str] = []
    manifest = _manifest(files, key, actual, problems)
    if manifest is not None:
        _files(files, manifest["files"], problems)
    _chain(files, key, manifest, problems)
    return problems


def _manifest(
    files: dict[str, bytes], key: Ed25519PublicKey, fingerprint: str, problems: list[str]
) -> dict[str, Any] | None:
    """签名无效时仍解析，用于定位其余问题；结构不对时返回 None。"""
    if not _signed(key, files["manifest.sig"], files["manifest.json"]):
        problems.append("manifest 签名无效：manifest.json 或 manifest.sig 被改")
    try:
        m = json.loads(files["manifest.json"])
        valid = (
            all(isinstance(m[k], str) for k in (*MANIFEST_TEXT, "verify_tool_version"))
            and all(isinstance(m["records"][k], int) for k in ("first_seq", "last_seq", "count"))
            and all(isinstance(v, str) for v in m["files"].values())
        )
    except (ValueError, KeyError, TypeError, AttributeError):
        valid = False
    if not valid:
        problems.append("manifest.json 无法解析或缺少字段")
        return None
    if m["format"] != FORMAT:
        problems.append(f"不支持的格式 {m['format']}，本工具校验 {FORMAT}")
    try:
        needed = tuple(int(x) for x in m["verify_tool_version"].split("."))
    except ValueError:
        needed = None
    if needed is None or needed > VERSION:
        problems.append(f"此包须用 hyd-evidence verify {m['verify_tool_version']} 及以上版本校验")
    if m["public_key_fingerprint"] != fingerprint:
        problems.append("manifest 记录的公钥指纹与 public_key.pem 不符")
    return m


def _files(files: dict[str, bytes], listed: dict[str, str], problems: list[str]) -> None:
    for path, digest in listed.items():
        if path not in files:
            problems.append(f"缺少 manifest 列出的文件 {path}")
        elif sha256(files[path]) != digest:
            problems.append(f"{path} 与 manifest 记录的摘要不符（文件被改）")
    for path in sorted(set(files) - set(listed) - {"manifest.json", "manifest.sig"}):
        problems.append(f"多出 manifest 未列出的文件 {path}")


def _chain(
    files: dict[str, bytes],
    key: Ed25519PublicKey,
    manifest: dict[str, Any] | None,
    problems: list[str],
) -> None:
    """逐条重算摘要、验签、检查衔接与载荷；包内第一条的 prev_hash 指向包外的记录，无从比对。"""
    records: list[dict[str, Any]] = []
    for line_no, line in enumerate(files["chain.jsonl"].splitlines(), 1):
        try:
            r = json.loads(line)
            digest = sha256(canonical({k: r[k] for k in HASHED}))
            if not (
                isinstance(r["seq"], int)
                and isinstance(r["hash"], str)
                and isinstance(r["sig"], str)
                and isinstance(r["payload_ref"], str | None)
            ):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            problems.append(f"chain.jsonl 第 {line_no} 行无法解析")
            continue
        where = f"第 {r['seq']} 条记录（chain.jsonl 第 {line_no} 行）"
        if r["hash"] != digest:
            problems.append(f"{where}内容与其摘要不符（记录被改）")
        try:
            signed = _signed(key, r["sig"], bytes.fromhex(r["hash"]))
        except ValueError:
            signed = False
        if not signed:
            problems.append(f"{where}签名无效")
        if records and (
            r["seq"] != records[-1]["seq"] + 1 or r["prev_hash"] != records[-1]["hash"]
        ):
            problems.append(f"{where}与上一条不衔接（其间记录被删、插入或被改）")
        if manifest is not None and r["incident_id"] != manifest["incident_id"]:
            problems.append(f"{where}不属于关联事件 {manifest['incident_id']}")
        ref = r["payload_ref"]
        if ref is not None and ref not in files:
            problems.append(f"{where}引用的载荷 {ref} 缺失")
        elif ref is not None and sha256(files[ref]) != ref.rsplit("/", 1)[-1].split(".", 1)[0]:
            problems.append(f"{where}引用的载荷 {ref} 与文件名中的摘要不符（载荷被改）")
        records.append(r)

    if not records:
        problems.append("chain.jsonl 没有可解析的记录")
        return
    if manifest is None:
        return
    expected = manifest["records"]
    first, last = records[0]["seq"], records[-1]["seq"]
    if (first, last, len(records)) != (
        expected["first_seq"],
        expected["last_seq"],
        expected["count"],
    ):
        problems.append(
            f"记录区间与 manifest 不符：manifest 为第 {expected['first_seq']}～"
            f"{expected['last_seq']} 条共 {expected['count']} 条，包内为第 {first}～{last} 条"
            f"共 {len(records)} 条（记录被删或被加）"
        )
    if records[-1]["hash"] != manifest["chain_head"]:
        problems.append("最后一条记录的摘要与 manifest 的 chain_head 不符")
