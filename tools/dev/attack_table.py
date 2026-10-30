"""ATT&CK 精简查表（D-070、REUSE-11）：从 MITRE 官方发布的 STIX 数据抽取技术编号 → 名称、战术。

用法：python tools/dev/attack_table.py <enterprise STIX> <ics STIX> <输出 JSON>
输入取自 MITRE 的 attack-stix-data 仓库对应版本（如 enterprise-attack-20.0.json、ics-attack-20.0.json），
只在生成时使用、不入库；输出随代码版本化，ATT&CK 升级时重新生成并更新 deploy/third-party.yaml 的哈希。
关联事件按 techniques 查战术（HYD-PLAN-007 §1），值班员按编号查名称；已撤销与已弃用的技术不收录。
"""

import json
import sys
from pathlib import Path
from typing import Any


def domain(bundle: dict[str, Any]) -> tuple[str, str, list[str], dict[str, dict[str, Any]]]:
    """返回 (版本, 版权声明, 按矩阵顺序的战术名称, 技术编号 → {name, tactics})。"""
    objects = bundle["objects"]
    (collection,) = (o for o in objects if o["type"] == "x-mitre-collection")
    (marking,) = (o for o in objects if o["type"] == "marking-definition")
    tactics = {o["id"]: o for o in objects if o["type"] == "x-mitre-tactic"}
    (matrix,) = (o for o in objects if o["type"] == "x-mitre-matrix")
    ordered = [tactics[ref] for ref in matrix["tactic_refs"]]
    by_short = {t["x_mitre_shortname"]: t["name"] for t in ordered}
    rank = {t["name"]: i for i, t in enumerate(ordered)}
    techniques = {}
    for o in objects:
        if o["type"] != "attack-pattern" or o.get("revoked") or o.get("x_mitre_deprecated"):
            continue
        (technique_id,) = (
            r["external_id"] for r in o["external_references"] if r["source_name"] == "mitre-attack"
        )
        names = {by_short[p["phase_name"]] for p in o.get("kill_chain_phases", [])}
        techniques[technique_id] = {"name": o["name"], "tactics": sorted(names, key=rank.get)}
    return (
        collection["x_mitre_version"],
        marking["definition"]["statement"],
        [t["name"] for t in ordered],
        techniques,
    )


def build(bundles: list[dict[str, Any]]) -> dict[str, Any]:
    versions, notices, order, techniques = set(), set(), [], {}
    for bundle in bundles:
        version, notice, tactics, found = domain(bundle)
        versions.add(version)
        notices.add(notice)
        order += [t for t in tactics if t not in order]
        techniques |= found
    (version,) = versions  # 各域须取自同一版本
    (notice,) = notices
    return {
        "attack_version": version,
        "notice": notice,  # ATT&CK 使用条款要求保留版权声明
        "tactic_order": order,
        "techniques": dict(sorted(techniques.items())),
    }


def main() -> None:
    *inputs, output = sys.argv[1:]
    table = build([json.loads(Path(p).read_text(encoding="utf-8")) for p in inputs])
    Path(output).write_text(
        json.dumps(table, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
