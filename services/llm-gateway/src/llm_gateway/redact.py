"""公网供应商脱敏与还原（C-LLM-03），输出的事实回溯（C-LLM-06、FR-503）。

脱敏：内网地址 → HOST_001 起，设备 ID → DEV_001 起，证据中所有字符串里出现的这些值一并替换；映射表只在
本次调用的内存中。回溯：输出中的实体须能在证据原文或本地 ATT&CK 精简表中查到，否则记为未溯源，随输出返回，
不丢弃输出（D-086）。
"""

import json
import re
from collections.abc import Callable, Iterable, Iterator
from ipaddress import ip_address
from typing import Any

DEVICE_KEYS = {"device_id", "device_ids", "camera_id"}
# 实体边界只看 ASCII：中文字符在 re 中也算 \w，紧挨中文的实体同样要识别
BEFORE, AFTER = r"(?<![A-Za-z0-9_.\-])", r"(?![A-Za-z0-9_\-]|\.\d)"
IPV4 = r"\d{1,3}(?:\.\d{1,3}){3}"
# IPv6 候选至少含两个冒号，再经 ip_address 确认（排除 08:00:00 这类时间）
IPV6 = r"(?<![A-Za-z0-9_:])(?=[0-9A-Fa-f]*:[0-9A-Fa-f]*:)[0-9A-Fa-f:]{2,39}(?![A-Za-z0-9_:])"
IP = re.compile(rf"(?<![\d.]){IPV4}(?!\.?\d)|{IPV6}")
PORT = re.compile(rf"(?:端口|port)\s*[:：]?\s*(\d{{1,5}})(?!\d)|{IPV4}:(\d{{1,5}})(?!\d)", re.I)
CVE = re.compile(r"CVE-\d{4}-\d{4,}")
TECHNIQUE = re.compile(r"(?<![A-Za-z0-9])T\d{4}(?:\.\d{3})?(?!\.?\d)")
DEVICE = re.compile(rf"{BEFORE}[a-z][a-z0-9]*-\d+{AFTER}")
PSEUDONYM = re.compile(r"(?<![A-Za-z0-9_])(?:HOST|DEV)_\d{3,}(?![A-Za-z0-9_])")


def _strings(value: Any, key: str = "") -> Iterator[tuple[str, str]]:
    """(所在字段名, 字符串)；列表元素沿用列表的字段名。"""
    if isinstance(value, dict):
        for k, v in value.items():
            yield from _strings(v, k)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v, key)
    elif isinstance(value, str):
        yield key, value


def _map_strings(value: Any, fn: Callable[[str], str]) -> Any:
    if isinstance(value, dict):
        return {k: _map_strings(v, fn) for k, v in value.items()}
    if isinstance(value, list):
        return [_map_strings(v, fn) for v in value]
    return fn(value) if isinstance(value, str) else value


def _ips(text: str) -> Iterator[str]:
    for m in IP.finditer(text):
        try:
            ip_address(m.group())
        except ValueError:
            continue
        yield m.group()


def _replace(value: Any, table: dict[str, str]) -> Any:
    if not table:
        return value
    # 长的先匹配：172.30.0.12 不会被 172.30.0.1 截断（边界也排除了这种情况）
    alternatives = "|".join(re.escape(k) for k in sorted(table, key=len, reverse=True))
    pattern = re.compile(f"{BEFORE}(?:{alternatives}){AFTER}")
    return _map_strings(value, lambda s: pattern.sub(lambda m: table[m.group()], s))


class Pseudonyms:
    """一次调用内的稳定假名：同一原值始终对应同一假名，输出据此还原。"""

    def __init__(self) -> None:
        self._fake: dict[str, str] = {}
        self._counts = {"HOST": 0, "DEV": 0}

    def _add(self, real: str, kind: str) -> None:
        if real not in self._fake:
            self._counts[kind] += 1
            self._fake[real] = f"{kind}_{self._counts[kind]:03d}"

    def redact(self, data: Any) -> Any:
        for key, text in _strings(data):
            if key in DEVICE_KEYS:
                self._add(text, "DEV")
            for ip in _ips(text):
                if ip_address(ip).is_private:  # 含回环、链路本地
                    self._add(ip, "HOST")
        return _replace(data, self._fake)

    def restore(self, output: Any) -> Any:
        """模型编造的假名不在映射表中，原样保留，由回溯记为未溯源。"""
        return _replace(output, {fake: real for real, fake in self._fake.items()})


def _found(entity: str, context: str) -> bool:
    return re.search(f"{BEFORE}{re.escape(entity)}{AFTER}", context) is not None


def _port(m: re.Match[str]) -> str:
    return m.group(1) or m.group(2)


def _ports(data: Any, context: str) -> set[str]:
    ports = {_port(m) for m in PORT.finditer(context)}

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for k, v in value.items():
                if k.endswith("port") and isinstance(v, int):
                    ports.add(str(v))
                walk(v)
        elif isinstance(value, list):
            for v in value:
                walk(v)

    walk(data)
    return ports


def untraced(output: Any, data: Any, techniques: Iterable[str]) -> list[str]:
    """输出中无法溯源的实体（去重）；data 为未脱敏的证据。"""
    context = json.dumps(data, ensure_ascii=False)
    known_ports, known_techniques = _ports(data, context), set(techniques)
    found: list[str] = []
    for key, text in _strings(output):
        if key in ("device_id", "evidence_refs"):
            found += [text] if not _found(text, context) else []
        found += [ip for ip in _ips(text) if not _found(ip, context)]
        found += [m.group() for m in PORT.finditer(text) if _port(m) not in known_ports]
        found += [m.group() for m in CVE.finditer(text) if not _found(m.group(), context)]
        found += [
            m.group()
            for m in TECHNIQUE.finditer(text)
            if m.group() not in known_techniques and not _found(m.group(), context)
        ]
        found += [m.group() for m in DEVICE.finditer(text) if not _found(m.group(), context)]
        found += PSEUDONYM.findall(text)
    return list(dict.fromkeys(found))
