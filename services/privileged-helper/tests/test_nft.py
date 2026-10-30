"""nft 固定模板：以假的 nft 记录参数（单元测试不改宿主防火墙）；JSON 输出取自 nftables 1.0.9 实测。"""

import asyncio
import json
from ipaddress import ip_address

import pytest

from privileged_helper.nft import SETUP, Nft, NftError

LISTED = {
    "nftables": [
        {"metainfo": {"version": "1.0.9"}},
        {
            "set": {
                "family": "inet",
                "name": "block4",
                "table": "hyd",
                "elem": [
                    {
                        "elem": {
                            "val": "172.30.0.100",
                            "timeout": 150,
                            "expires": 121,
                            "counter": {"packets": 60, "bytes": 3600},
                        }
                    }
                ],
            }
        },
    ]
}


class FakeNft:
    def __init__(self, *results: tuple[int, str, str]) -> None:
        self.results = list(results)
        self.calls: list[tuple[list[str], str | None]] = []

    async def __call__(self, args: list[str], stdin: str | None) -> tuple[int, str, str]:
        self.calls.append((args, stdin))
        return self.results.pop(0) if self.results else (0, "", "")


def test_setup_creates_table_once() -> None:
    missing = FakeNft((1, "", "Error: No such file or directory"))
    asyncio.run(Nft(missing).setup())
    assert missing.calls == [(["list", "table", "inet", "hyd"], None), (["-f", "-"], SETUP)]

    existing = FakeNft((0, "table inet hyd {}", ""))
    asyncio.run(Nft(existing).setup())
    assert len(existing.calls) == 1  # 已存在不重建：重复创建会叠加丢弃规则


@pytest.mark.parametrize(
    ("ip", "expected"),
    [
        (
            "172.30.0.100",
            ["add", "element", "inet", "hyd", "block4", "{ 172.30.0.100 timeout 150s }"],
        ),
        (
            "2001:db8::1",
            ["add", "element", "inet", "hyd", "block6", "{ 2001:db8::1 timeout 150s }"],
        ),
    ],
)
def test_block_uses_fixed_template(ip: str, expected: list[str]) -> None:
    fake = FakeNft()
    asyncio.run(Nft(fake).block(ip_address(ip), 150))
    assert fake.calls == [(expected, None)]


def test_unblock_tolerates_expired_element() -> None:
    fake = FakeNft((1, "", "Error: Could not process rule: No such file or directory"))
    asyncio.run(Nft(fake).unblock(ip_address("172.30.0.100")))


def test_unblock_raises_other_errors() -> None:
    fake = FakeNft((1, "", "Error: Operation not permitted"))
    with pytest.raises(NftError, match="not permitted"):
        asyncio.run(Nft(fake).unblock(ip_address("172.30.0.100")))


def test_counters_of_present_and_absent_element() -> None:
    nft = Nft(FakeNft((0, json.dumps(LISTED), ""), (0, json.dumps(LISTED), "")))
    assert asyncio.run(nft.counters(ip_address("172.30.0.100"))) == (60, 121)
    assert asyncio.run(nft.counters(ip_address("172.30.0.101"))) is None
