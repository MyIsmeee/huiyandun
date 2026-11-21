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


def test_setup_applies_template_in_one_transaction() -> None:
    """每次启动都整份写入：一次 nft -f 事务，已有集合保留、规则先清空再写，重复执行不叠加。"""
    fake = FakeNft()
    asyncio.run(Nft(fake).setup())
    asyncio.run(Nft(fake).setup())
    assert fake.calls == [(["-f", "-"], SETUP)] * 2


def test_setup_failure_raises() -> None:
    fake = FakeNft((1, "", "Error: Operation not permitted"))
    with pytest.raises(NftError, match="not permitted"):
        asyncio.run(Nft(fake).setup())


def test_template_resets_tcp_before_dropping() -> None:
    """切断已建立的会话：两条链都先对 TCP 回复 RST、再丢弃其余协议；规则写入前先清空，集合不清空。"""
    declared, flushes, rules = SETUP.split("flush chain", 1)[0], SETUP.count("flush chain"), {}
    assert "flush set" not in SETUP and "delete" not in SETUP and flushes == 2
    assert declared.count("set block") == 2
    body = SETUP.rsplit("table inet hyd {", 1)[1]
    for chain in ("forward", "input"):
        lines = [x.strip() for x in body.split(f"chain {chain} {{")[1].split("}")[0].splitlines()]
        rules[chain] = [x for x in lines if x]
    for chain, lines in rules.items():
        resets = [i for i, x in enumerate(lines) if x.endswith("reject with tcp reset")]
        drops = [i for i, x in enumerate(lines) if x.endswith("drop")]
        assert resets and drops and max(resets) < min(drops), chain
        # 先判协议再查集合：否则非 TCP 报文在复位规则处也被计数一次
        assert all(lines[i].startswith("meta l4proto tcp ") for i in resets), chain
    # 设备发往攻击方的报文只出现在转发路径上；本机不对自己发出的报文设规则（否则会丢掉回给攻击方的 RST）
    assert any("daddr @block4" in x for x in rules["forward"])
    assert not any("daddr" in x for x in rules["input"]) and "hook output" not in SETUP


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
