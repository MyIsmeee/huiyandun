"""时区代表城市坐标表：登录页俯冲按浏览器时区飞向本地（web/console/src/panels/LoginPage/globe/zones.json）。

用法：python tools/dev/tz_coordinates.py [zoneinfo 目录，缺省 /usr/share/zoneinfo] <输出 JSON>
取自 IANA 时区数据库（tzdata，公有领域）：zone.tab 与 zone1970.tab 给出每个时区代表城市的经纬度，
tzdata.zi 的 Link 行给出别名（如 Asia/Chongqing → Asia/Shanghai、Asia/Calcutta → Asia/Kolkata，
部分浏览器的 Intl 仍返回旧名）。输出随代码版本化，tzdata 升级时重新生成并更新 deploy/third-party.yaml 的哈希。
"""

import json
import re
import sys
from pathlib import Path

COORD = re.compile(r"^([+-])(\d{2})(\d{2})(\d{2})?([+-])(\d{3})(\d{2})(\d{2})?$")


def degrees(sign: str, d: str, m: str, s: str | None) -> float:
    value = int(d) + int(m) / 60 + int(s or 0) / 3600
    return round(-value if sign == "-" else value, 4)


def coordinates(text: str) -> dict[str, list[float]]:
    """zone.tab / zone1970.tab：国家码、ISO 6709 坐标（±DDMM±DDDMM 或带秒）、时区名。"""
    out: dict[str, list[float]] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        _, coord, zone, *_ = line.split("\t")
        match = COORD.match(coord)
        if not match:
            raise ValueError(f"无法解析坐标 {coord}（{zone}）")
        a, b, c, d, e, f, g, h = match.groups()
        out[zone] = [degrees(a, b, c, d), degrees(e, f, g, h)]
    return out


def main(zoneinfo: Path, output: Path) -> None:
    zones = coordinates((zoneinfo / "zone.tab").read_text(encoding="utf-8"))
    # zone1970.tab 在两者都有的时区上取它的坐标（较新），并补上 zone.tab 没有的
    zones.update(coordinates((zoneinfo / "zone1970.tab").read_text(encoding="utf-8")))
    zi = (zoneinfo / "tzdata.zi").read_text(encoding="utf-8").splitlines()
    version = zi[0].removeprefix("# version ").strip()
    links = {
        name: target
        for line in zi
        if line.startswith("L ")
        for target, name in [line.split()[1:3]]
        if target in zones and name not in zones
    }
    output.write_text(
        json.dumps(
            {
                "version": version,
                "zones": dict(sorted(zones.items())),
                "links": dict(sorted(links.items())),
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"tzdata {version}：{len(zones)} 个时区、{len(links)} 个别名 → {output}")


if __name__ == "__main__":
    args = sys.argv[1:]
    main(Path(args[0]) if len(args) == 2 else Path("/usr/share/zoneinfo"), Path(args[-1]))
