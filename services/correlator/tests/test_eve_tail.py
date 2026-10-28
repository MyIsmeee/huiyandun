"""跟随读取 EVE 文件：续读、轮转、截断（TK-032、#98）。"""

from collections.abc import Iterator
from pathlib import Path

import pytest

from correlator.eve import EveTail


@pytest.fixture
def eve(tmp_path: Path) -> Path:
    return tmp_path / "eve.json"


@pytest.fixture
def tail(eve: Path, tmp_path: Path) -> Iterator[EveTail]:
    tail = EveTail(eve, tmp_path / "position.json")
    yield tail
    tail.close()


def append(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(text)


def texts(tail: EveTail) -> list[str]:
    return [line.text for line in tail.poll()]


def test_waits_for_file_then_reads_new_lines(eve: Path, tail: EveTail) -> None:
    assert texts(tail) == []
    append(eve, "a\nb\n")
    assert texts(tail) == ["a", "b"]
    assert texts(tail) == []
    append(eve, "c\n")
    assert texts(tail) == ["c"]


def test_partial_line_held_until_complete(eve: Path, tail: EveTail) -> None:
    """Suricata 可能正写到一半：不完整的末行等换行写入后再返回。"""
    append(eve, 'a\n{"half')
    assert texts(tail) == ["a"]
    append(eve, '": 1}\n')
    assert texts(tail) == ['{"half": 1}']


def test_restart_resumes_after_last_committed_line(eve: Path, tmp_path: Path) -> None:
    """已确认的行不重读，未确认的行重读：不丢、不重。"""
    append(eve, "a\nb\nc\n")
    first = EveTail(eve, tmp_path / "position.json")
    a, _, _ = first.poll()
    first.commit(a)
    first.close()
    second = EveTail(eve, tmp_path / "position.json")
    assert texts(second) == ["b", "c"]
    second.close()


def test_rotation_drains_old_file_then_reads_new(eve: Path, tail: EveTail) -> None:
    append(eve, "a\n")
    assert texts(tail) == ["a"]
    rotated = eve.with_name("eve.json.1")
    eve.rename(rotated)
    append(rotated, "b\n")  # 改名后、重新打开前仍写入旧文件
    append(eve, "c\n")
    assert texts(tail) == ["b"]
    assert texts(tail) == []  # 读完旧文件后切换
    assert texts(tail) == ["c"]


def test_truncation_reads_from_start(eve: Path, tail: EveTail) -> None:
    append(eve, "a\nb\n")
    assert texts(tail) == ["a", "b"]
    eve.write_text("", encoding="utf-8")
    assert texts(tail) == []
    append(eve, "c\n")
    assert texts(tail) == ["c"]


def test_restart_after_file_replaced_reads_new_file(eve: Path, tmp_path: Path) -> None:
    append(eve, "a\nb\n")
    first = EveTail(eve, tmp_path / "position.json")
    first.commit(first.poll()[-1])
    first.close()
    eve.rename(eve.with_name("eve.json.1"))
    append(eve, "c\n")
    second = EveTail(eve, tmp_path / "position.json")
    assert texts(second) == ["c"]
    second.close()


def test_rotation_before_new_file_created(eve: Path, tail: EveTail) -> None:
    append(eve, "a\n")
    assert texts(tail) == ["a"]
    eve.rename(eve.with_name("eve.json.1"))
    assert texts(tail) == []  # 新文件尚未创建：继续等待
    append(eve, "b\n")
    assert texts(tail) == []
    assert texts(tail) == ["b"]


def test_restart_after_truncation_reads_from_start(eve: Path, tmp_path: Path) -> None:
    """停机期间文件被截断后又写入，短于已确认的位置：从头读。"""
    append(eve, "aaaa\nbbbb\n")
    first = EveTail(eve, tmp_path / "position.json")
    first.commit(first.poll()[-1])
    first.close()
    eve.write_text("c\n", encoding="utf-8")
    second = EveTail(eve, tmp_path / "position.json")
    assert texts(second) == ["c"]
    second.close()
