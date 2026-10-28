"""检测规则测试（CI-19、C-SEC-01）。

用法：python tools/dev/check_rules.py <suricata 镜像> <rules 目录>
先以 suricata -T 加载镜像内的全部规则（ET Open 与自研），语法错误即失败；再逐个回放
<rules 目录>/tests/<规则 ID>/*.pcap，只加载该规则所在的文件（HYD-NET-xxxx 在 hyd-net.rules），
统计 metadata hyd_rule_id 为该规则的告警数，与同名 .meta.yaml 的 alerts 比对。任一不符以 1 退出。
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

CONFIG = "/etc/suricata/hyd.yaml"
RULES = "/etc/suricata/rules"
TIMEOUT_S = 300  # 加载全部 ET Open 规则约需 30 s


def suricata(
    image: str, *args: str, volumes: tuple[str, ...] = ()
) -> subprocess.CompletedProcess[str]:
    mounts = [arg for v in volumes for arg in ("-v", v)]
    return subprocess.run(
        ["docker", "run", "--rm", "--network", "none", *mounts, image, *args],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
        check=False,
    )


def count_alerts(eve: Path, rule_id: str) -> int:
    events = [json.loads(line) for line in eve.read_text(encoding="utf-8").splitlines()]
    return sum(
        rule_id in e["alert"].get("metadata", {}).get("hyd_rule_id", [])
        for e in events
        if e["event_type"] == "alert"
    )


def replay(image: str, meta: Path) -> str | None:
    rule_id = meta.parent.name
    pcap = meta.with_name(meta.name.removesuffix(".meta.yaml") + ".pcap")
    rule_file = "-".join(rule_id.split("-")[:2]).lower() + ".rules"
    expected = yaml.safe_load(meta.read_text(encoding="utf-8"))["alerts"]
    with tempfile.TemporaryDirectory() as out:
        volumes = (f"{pcap.parent.resolve()}:/pcap:ro", f"{out}:/out")
        # 单线程回放：多线程会打乱不同连接的先后，阈值时间窗随之变化
        args = ("--runmode", "single", "-k", "none", "-l", "/out", "-r", f"/pcap/{pcap.name}")
        run = suricata(image, *args, "-S", f"{RULES}/{rule_file}", volumes=volumes)
        if run.returncode:
            return f"{pcap}: suricata 退出码 {run.returncode}\n{run.stderr}"
        actual = count_alerts(Path(out) / "eve.json", rule_id)
    if actual != expected:
        return f"{pcap}: {rule_id} 告警 {actual} 次，预期 {expected} 次"
    return None


def main(image: str, rules: Path) -> int:
    errors = []
    check = suricata(image, "-T", "--include", CONFIG)
    if check.returncode:
        errors.append(f"规则加载失败\n{check.stdout}{check.stderr}")
    metas = sorted((rules / "tests").glob("*/*.meta.yaml"))
    errors += [e for meta in metas if (e := replay(image, meta))]
    for error in errors:
        print(error, file=sys.stderr)
    print(f"样本 {len(metas)} 个；失败 {len(errors)} 项")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
