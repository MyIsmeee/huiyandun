"""跟随读取 Suricata EVE 文件（TK-032）：逐行返回新写入的完整记录；已处理到的位置以
(inode, 偏移) 持久化，重启后从该处续读，不丢、不重。

文件按改名轮转时先读完旧文件、再从新文件开头读；被截断时从头读（#98）。重启时文件已被替换，
则从新文件开头读。
"""

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO


@dataclass(frozen=True)
class Line:
    text: str
    inode: int
    end: int  # 该行之后的字节偏移


class EveTail:
    def __init__(self, path: Path, state_file: Path) -> None:
        self._path = path
        self._state_file = state_file
        self._file: BinaryIO | None = None
        self._inode = 0
        self._partial = b""  # 尚未写完的末行

    def poll(self) -> list[Line]:
        """返回上次调用以来新写入的完整行；文件尚不存在时返回空列表。"""
        if self._file is None and not self._open():
            return []
        lines = self._read()
        if not lines:
            self._follow()
        return lines

    def commit(self, line: Line) -> None:
        """记录该行已处理：先写临时文件再改名，进程中途退出也不会留下残缺的状态。"""
        tmp = self._state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"inode": line.inode, "offset": line.end}), encoding="utf-8")
        tmp.replace(self._state_file)

    def close(self) -> None:
        if self._file is not None:
            self._file.close()
            self._file = None

    def _open(self) -> bool:
        try:
            file = self._path.open("rb")
        except FileNotFoundError:
            return False
        stat = os.fstat(file.fileno())
        if self._state_file.exists():
            state = json.loads(self._state_file.read_text(encoding="utf-8"))
            if state["inode"] == stat.st_ino and state["offset"] <= stat.st_size:
                file.seek(state["offset"])
        self._file, self._inode, self._partial = file, stat.st_ino, b""
        return True

    def _read(self) -> list[Line]:
        assert self._file is not None
        data = self._file.read()
        if not data:
            return []
        offset = self._file.tell() - len(data) - len(self._partial)
        *complete, self._partial = (self._partial + data).split(b"\n")
        lines = []
        for raw in complete:
            offset += len(raw) + 1
            if raw.strip():
                lines.append(Line(raw.decode("utf-8", "replace"), self._inode, offset))
        return lines

    def _follow(self) -> None:
        """已读到末尾：检查文件是否被替换或截断。"""
        assert self._file is not None
        try:
            stat = self._path.stat()
        except FileNotFoundError:
            return  # 轮转中：旧文件已改名，新文件尚未创建
        if stat.st_ino != self._inode:
            self.close()
            self._open()
        elif stat.st_size < self._file.tell():
            self._file.seek(0)
            self._partial = b""
