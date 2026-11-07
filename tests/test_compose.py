"""Compose 定义的静态约束：健康检查、digest 锁定、内部网络、复用组件登记。"""

import ipaddress
import os
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = yaml.safe_load((ROOT / "deploy/compose/compose.yaml").read_text(encoding="utf-8"))
SERVICES = COMPOSE["services"]
REGISTERED = {
    c["image"]
    for c in yaml.safe_load((ROOT / "deploy/third-party.yaml").read_text(encoding="utf-8"))[
        "components"
    ]
}


ONESHOT = [n for n, s in SERVICES.items() if s.get("labels", {}).get("hyd.oneshot") == "true"]


def base_images(name: str) -> list[str]:
    """服务实际使用的镜像：自研服务取其 Dockerfile 的全部基础镜像，不含引用前面构建阶段的 FROM。"""
    build = SERVICES[name].get("build")
    if build is None:
        return [SERVICES[name]["image"]]
    dockerfile = ROOT / "deploy/compose" / build["context"] / build["dockerfile"]
    froms = re.findall(r"^FROM (\S+)(?: AS (\S+))?", dockerfile.read_text(encoding="utf-8"), re.M)
    stages = {stage for _, stage in froms if stage}
    return [image for image, _ in froms if image not in stages]


@pytest.mark.parametrize("name", [n for n in SERVICES if n not in ONESHOT])
def test_service_has_healthcheck(name: str) -> None:
    """make demo-health 以 healthy 判定就绪，没有健康检查的服务永远不会就绪。"""
    assert SERVICES[name].get("healthcheck", {}).get("test")


@pytest.mark.parametrize("name", ["vision-engine", "correlator"])
def test_service_restarts_after_exit(name: str) -> None:
    """#79、TK-041：检测与关联进程退出后自动拉起，演示中不因一次崩溃停止。"""
    assert SERVICES[name]["restart"] == "unless-stopped"


@pytest.mark.parametrize("name", SERVICES)
def test_image_pinned_by_digest(name: str) -> None:
    """C-OPS-01、G-15。"""
    images = base_images(name)
    assert images and all("@sha256:" in image for image in images)


@pytest.mark.parametrize("name", SERVICES)
def test_image_registered(name: str) -> None:
    """C-RU-01：镜像引用与 deploy/third-party.yaml 逐字一致。"""
    assert set(base_images(name)) <= REGISTERED


@pytest.mark.parametrize("name", [n for n in SERVICES if n != "postgres" and n not in ONESHOT])
def test_long_running_service_lacks_owner_password(name: str) -> None:
    """G-13：常驻服务只持有应用账号口令，无法停用审计表触发器；属主口令只给一次性迁移。"""
    assert "postgres_password" not in SERVICES[name].get("secrets", [])


def test_doctor_image_registered() -> None:
    script = (ROOT / "tools/dev/doctor.sh").read_text(encoding="utf-8")
    image = re.search(r"^CUDA_IMAGE=(\S+)$", script, re.MULTILINE)
    assert image and image[1] in REGISTERED


EDGE = "edge-net"
EGRESS = "llm-egress"
CAMERA_NET = "camera-net"  # go2rtc 拉取局域网摄像头（D-103）
EXPOSED = {"web-console", "go2rtc", "ingest"}
INTERNAL_NETWORKS = [n for n in COMPOSE["networks"] if n not in (EDGE, EGRESS, CAMERA_NET)]


@pytest.mark.parametrize("name", INTERNAL_NETWORKS)
def test_network_internal(name: str) -> None:
    """DP-05：例外为开放端口的 edge-net、llm-gateway 出站的 llm-egress、go2rtc 拉流的 camera-net。"""
    assert COMPOSE["networks"][name].get("internal") is True


def test_only_llm_gateway_reaches_outside() -> None:
    """DP-05、C-LLM-01：只有 llm-gateway 接入出站网络。"""
    assert {n for n, s in SERVICES.items() if EGRESS in s.get("networks", [])} == {"llm-gateway"}


def test_only_go2rtc_and_ingest_pull_cameras_outside() -> None:
    """D-103、D-117：只有 go2rtc 与兼容模式的中继 ingest 接入可出站的 camera-net，取流地址只由 api-server 按登记表下发。"""
    pullers = {n for n, s in SERVICES.items() if CAMERA_NET in s.get("networks", [])}
    assert pullers == {"go2rtc", "ingest"}


def test_ingest_control_api_only_for_api_server() -> None:
    """D-117：ingest 的控制接口只监听 video-net 固定地址，api 权限只给 api-server 的固定地址与自身健康检查。"""
    conf = yaml.safe_load((ROOT / "deploy/compose/ingest.yml").read_text(encoding="utf-8"))
    ingest_ip = SERVICES["ingest"]["networks"]["video-net"]["ipv4_address"]
    api_ip = SERVICES["api-server"]["networks"]["video-net"]["ipv4_address"]
    assert conf["apiAddress"] == f"{ingest_ip}:9997"
    api_users = [u for u in conf["authInternalUsers"] if {"action": "api"} in u["permissions"]]
    assert [sorted(u["ips"]) for u in api_users] == [sorted([api_ip, ingest_ip])]


def test_ingest_publishes_push_port_only_and_feeds_only_go2rtc() -> None:
    """D-103：ingest 只开放推流端口；ingest-net 上只有 go2rtc 与 ingest，推流口令只给 ingest 与 api-server。"""
    assert SERVICES["ingest"]["ports"] == ["8554:8554/tcp"]
    peers = {n for n, s in SERVICES.items() if "ingest-net" in s.get("networks", [])}
    assert peers == {"go2rtc", "ingest"}
    holders = {n for n, s in SERVICES.items() if "push_password" in s.get("secrets", [])}
    assert holders == {"ingest", "api-server"}


def test_llm_gateway_reachable_only_by_api_server() -> None:
    """DP-05：网关的内部接口不鉴权、按请求访问地址；只有 api-server 够得到它，其他服务无法借它出网。"""
    gateway_nets = set(SERVICES["llm-gateway"]["networks"]) - {EGRESS}
    assert gateway_nets == {"llm-net"}
    peers = {n for n, s in SERVICES.items() if gateway_nets & set(s.get("networks", []))}
    assert peers == {"api-server", "llm-gateway"}


def test_edge_network_blocks_egress() -> None:
    """DP-05、G-05：开放端口需要非 internal 网络；关闭 IP 伪装后容器仍无法出站。"""
    options = COMPOSE["networks"][EDGE]["driver_opts"]
    assert options["com.docker.network.bridge.enable_ip_masquerade"] == "false"


def test_only_exposed_services_publish_ports() -> None:
    """C-OPS-05：只有 DP-05 列出的服务开放端口，且只有它们接入 edge-net。"""
    assert {n for n, s in SERVICES.items() if s.get("ports")} == EXPOSED
    assert {n for n, s in SERVICES.items() if EDGE in s.get("networks", [])} == EXPOSED


def test_go2rtc_publishes_media_port_only() -> None:
    """C-OPS-05：go2rtc 只开放 WebRTC 媒体端口，API 不对外。"""
    assert {p.split(":")[-1] for p in SERVICES["go2rtc"]["ports"]} == {"8555/tcp", "8555/udp"}


def test_go2rtc_api_reachable_only_by_its_clients() -> None:
    """go2rtc 的 API 无鉴权且可新建 exec 源：内部网络上只有信令转发、取流与录像的服务能访问。"""
    internal = set(SERVICES["go2rtc"]["networks"]) - {EDGE, CAMERA_NET}
    peers = {n for n, s in SERVICES.items() if internal & set(s.get("networks", []))} - {"go2rtc"}
    assert peers == {"api-server", "vision-engine", "mediamtx", "recorder", "ingest"}
    assert "core-net" not in internal


@pytest.mark.parametrize(("module", "network"), [("api", "video-net"), ("rtsp", "demo-net")])
def test_go2rtc_listens_only_on_internal_network(module: str, network: str) -> None:
    """#97：edge-net、camera-net 有宿主网关，宿主进程经它们可访问 go2rtc。API（信令、取帧、增删流）
    只监听 video-net、RTSP（视觉引擎与录像取流）只监听 demo-net 的固定地址，宿主在这两个网络里没有地址。"""
    config = yaml.safe_load((ROOT / "deploy/compose/go2rtc.yaml").read_text(encoding="utf-8"))
    host = config[module]["listen"].rsplit(":", 1)[0]
    assert host == SERVICES["go2rtc"]["networks"][network]["ipv4_address"]
    options = COMPOSE["networks"][network]["driver_opts"]
    assert options["com.docker.network.bridge.gateway_mode_ipv4"] == "isolated"


def test_fixed_addresses_outside_auto_range() -> None:
    """同一网络里固定地址与自动分配混用时，自动分配须限定在 ip_range 内且不含固定地址：
    否则先连上网络的容器可能拿到固定地址，固定地址的服务启动报 Address already in use。"""
    for name, network in COMPOSE["networks"].items():
        joined = [s["networks"] for s in SERVICES.values() if name in s.get("networks", [])]
        members = [n[name] or {} if isinstance(n, dict) else {} for n in joined]
        fixed = [ipaddress.ip_address(m["ipv4_address"]) for m in members if "ipv4_address" in m]
        if not fixed or len(fixed) == len(members):
            continue
        (config,) = network["ipam"]["config"]
        auto = ipaddress.ip_network(config["ip_range"])
        assert auto.subnet_of(ipaddress.ip_network(config["subnet"])), name
        assert not any(address in auto for address in fixed), name


SENSORS = {"suricata", "zeek"}
TAP = "capture-tap"
TAP_NET = "tap-net"
# 抓包所需；suricata 启动阶段另需切换用户、写日志目录，切换后只保留 NET_RAW、NET_ADMIN、SYS_NICE
SENSOR_CAPS = {
    "NET_RAW",
    "NET_ADMIN",
    "SYS_NICE",
    "SETUID",
    "SETGID",
    "SETPCAP",
    "CHOWN",
    "DAC_OVERRIDE",
}


def test_only_capture_tap_and_helper_use_host_network() -> None:
    """宿主网络绕过全部网络隔离（DP-05 例外）：只给配置镜像的 capture-tap（执行一次即退出、不处理
    流量）与操作防火墙的 privileged-helper（D-074）；两者都只有 NET_ADMIN、根文件系统只读。"""
    helper = "privileged-helper"
    assert {n for n, s in SERVICES.items() if s.get("network_mode") == "host"} == {TAP, helper}
    assert TAP in ONESHOT
    for name in (TAP, helper):
        assert SERVICES[name]["read_only"] is True
        assert SERVICES[name]["cap_drop"] == ["ALL"] and SERVICES[name]["cap_add"] == ["NET_ADMIN"]
    # helper 只经套接字卷接受签名指令，不开放端口
    assert SERVICES[helper]["volumes"] == ["helper-run:/run/hyd-helper"]
    assert "ports" not in SERVICES[helper]


def test_helper_socket_shared_only_with_executor() -> None:
    """D-074：能向 helper 发指令的只有 playbook-executor（还须持有签名私钥）。"""
    mounts = {
        n
        for n, s in SERVICES.items()
        if any(v.startswith("helper-run:") for v in s.get("volumes", []))
    }
    assert mounts == {"privileged-helper", "playbook-executor"}
    assert {n for n, s in SERVICES.items() if "executor_signing_key" in s.get("secrets", [])} == {
        "playbook-executor"
    }


@pytest.mark.parametrize("name", sorted(SENSORS))
def test_sensor_least_privilege(name: str) -> None:
    """探针解析不可信流量，被攻破时不能成为跳板：只接入 tap-net、只读根文件系统、只保留抓包能力、
    不持有口令、只挂载自己的日志与缓存卷。"""
    sensor = SERVICES[name]
    assert sensor["networks"] == [TAP_NET]
    assert sensor["read_only"] is True
    assert sensor["cap_drop"] == ["ALL"]
    assert set(sensor["cap_add"]) <= SENSOR_CAPS
    assert "secrets" not in sensor and "ports" not in sensor
    assert all(v.split(":")[0] in COMPOSE["volumes"] for v in sensor["volumes"])


def test_tap_network_holds_only_sensors() -> None:
    """C-SEC-08：tap-net 里只有探针，且探针之间不互通。"""
    members = {n for n, s in SERVICES.items() if TAP_NET in s.get("networks", [])}
    assert members == SENSORS
    assert (
        COMPOSE["networks"][TAP_NET]["driver_opts"]["com.docker.network.bridge.enable_icc"]
        == "false"
    )


@pytest.mark.parametrize("name", INTERNAL_NETWORKS)
def test_network_unreachable_from_host(name: str) -> None:
    """内部网络不给宿主分配地址：宿主上的进程访问不到其中的服务。"""
    options = COMPOSE["networks"][name]["driver_opts"]
    assert options["com.docker.network.bridge.gateway_mode_ipv4"] == "isolated"


def test_capture_tap_mirrors_attack_bridge_into_tap_net() -> None:
    """演示抓包源是攻击网络的网桥（attack-sim→rtsp-target 的 RTSP 爆破在此发生），镜像目标是
    tap-net 的网桥；真实部署以 HYD_CAPTURE_IFACE 指定接镜像端口、未配置 IP 的网卡。"""
    bridge = {
        n: COMPOSE["networks"][n]["driver_opts"]["com.docker.network.bridge.name"]
        for n in (ATTACK_NET, TAP_NET)
    }
    assert SERVICES[TAP]["command"] == [
        f"${{HYD_CAPTURE_IFACE:-{bridge[ATTACK_NET]}}}",
        bridge[TAP_NET],
    ]


ATTACK_NET = "attack-net"
ATTACK_SIM = "attack-sim"
RTSP_TARGET = "rtsp-target"
NVR_SIM = "nvr-sim"


def test_attack_sim_only_runs_on_demand() -> None:
    """D-105：攻击只由队员手动触发（make attack），启动演示环境时不运行 attack-sim。"""
    assert SERVICES[ATTACK_SIM]["scale"] == 0


def test_attack_sim_reaches_no_service_but_rtsp_target() -> None:
    """DP-09、C-SEC-11、D-095：attack-sim 只接入 attack-net，攻击方能访问的服务只有 rtsp-target——网络里另有
    不监听任何端口的合法录像机 nvr-sim（TK-115）；该网络内部隔离、宿主不可达，attack-sim 在网络层碰不到
    go2rtc 等其他服务。"""
    members = {n for n, s in SERVICES.items() if ATTACK_NET in set(s.get("networks", []))}
    assert members == {ATTACK_SIM, RTSP_TARGET, NVR_SIM}
    assert set(SERVICES[NVR_SIM]["networks"]) == {ATTACK_NET}
    assert "ports" not in SERVICES[NVR_SIM] and "expose" not in SERVICES[NVR_SIM]
    assert set(SERVICES[ATTACK_SIM]["networks"]) == {ATTACK_NET}
    net = COMPOSE["networks"][ATTACK_NET]
    assert net["internal"] is True
    assert net["driver_opts"]["com.docker.network.bridge.gateway_mode_ipv4"] == "isolated"


def test_attack_sim_carries_no_offensive_tools() -> None:
    """DP-09：镜像内不含通用扫描或利用工具，只有自研的受控脚本、不安装任何依赖。"""
    dockerfile = (ROOT / "agents/sim/attack-sim/Dockerfile").read_text(encoding="utf-8")
    assert "apt-get install" not in dockerfile and "apt install" not in dockerfile
    assert "pip install" not in dockerfile


def test_rtsp_target_impersonates_attacked_camera() -> None:
    """rtsp-target 取用 site.yaml 中被攻击摄像头 cam-02 的 IP，使网络告警可映射到该设备（FR-203）；
    attack-sim 的源地址在白名单网段之外，后续处置才能真正封禁它。"""
    site = yaml.safe_load((ROOT / "demo/scenarios/site.yaml").read_text(encoding="utf-8"))
    cam = next(c for c in site["cameras"] if c["id"] == "cam-02")
    assert SERVICES[RTSP_TARGET]["networks"][ATTACK_NET]["ipv4_address"] == cam["ip"]
    attacker = ipaddress.ip_address(SERVICES[ATTACK_SIM]["networks"][ATTACK_NET]["ipv4_address"])
    assert not any(attacker in ipaddress.ip_network(w) for w in site["whitelist"])


def test_attack_sim_behavior_registered_in_scenarios() -> None:
    """DP-09：attack-sim 的行为参数登记于 demo/scenarios/，不散落在镜像里。"""
    params = yaml.safe_load((ROOT / "demo/scenarios/attack-sim.yaml").read_text(encoding="utf-8"))
    assert params["target"] == RTSP_TARGET
    assert params["attempts"] >= 5  # 60 s 内 ≥5 次 RTSP 认证失败才触发 HYD-NET-0001
    # 低速模式（FR-205）：任意 60 s 内不足 5 次；尝试跨越 60 s 以上，连续两个 30 s 窗口都有尝试
    slow = params["slow"]
    assert 60 // slow["interval_s"] + 1 < 5
    assert (slow["attempts"] - 1) * slow["interval_s"] >= 60
    assert slow["interval_s"] < 30


def test_nvr_sim_is_whitelisted_and_allowed_by_address() -> None:
    """合法录像机在白名单网段内、不会被封禁；rtsp-target 按它的地址放行，配置里没有口令（G-14）。"""
    site = yaml.safe_load((ROOT / "demo/scenarios/site.yaml").read_text(encoding="utf-8"))
    nvr = SERVICES[NVR_SIM]["networks"][ATTACK_NET]["ipv4_address"]
    assert any(ipaddress.ip_address(nvr) in ipaddress.ip_network(w) for w in site["whitelist"])
    target = yaml.safe_load((ROOT / "deploy/compose/rtsp-target.yml").read_text(encoding="utf-8"))
    remote = [u for u in target["authInternalUsers"] if nvr in u["ips"]]
    assert remote == [
        {"user": "any", "ips": [nvr], "permissions": [{"action": "read", "path": "cam"}]}
    ]
    assert all("pass" not in u for u in target["authInternalUsers"])


def test_only_audit_service_holds_audit_password() -> None:
    """G-13：只有 audit-service 可写审计封存记录；postgres 仅在初始化时用它创建账号。"""
    holders = {n for n, s in SERVICES.items() if "db_audit_password" in s.get("secrets", [])}
    assert holders == {"audit-service", "postgres"}


def test_only_api_server_holds_llm_key() -> None:
    """C-ST-03：API Key 由 api-server 加解密，llm-gateway 只收到转交的明文、不持有密钥。"""
    holders = {n for n, s in SERVICES.items() if "llm_key_secret" in s.get("secrets", [])}
    assert holders == {"api-server"}


def test_only_evidence_service_writes_evidence() -> None:
    """D-04、G-14：存证卷与签名私钥只给 evidence-service。"""
    holders = {n for n, s in SERVICES.items() if "evidence_signing_key" in s.get("secrets", [])}
    assert holders == {"evidence-service"}
    mounts = {
        n
        for n, s in SERVICES.items()
        for v in s.get("volumes", [])
        if v.startswith("evidence-data:")
    }
    assert mounts == {"evidence-service"}


def test_recorder_playback_reachable_only_by_evidence_service() -> None:
    """080 §2：回放接口不鉴权，只有 evidence-service 与 recorder 同在 evidence-net。"""
    peers = {n for n, s in SERVICES.items() if "evidence-net" in s.get("networks", [])}
    assert peers == {"evidence-service", "recorder"}


@pytest.mark.parametrize("script", sorted((ROOT / "deploy/compose/postgres-init").glob("*.sh")))
def test_init_script_executable(script: Path) -> None:
    """不可执行的 .sh 会被 postgres 镜像 source 进自身启动流程，脚本的 set -eu 随之生效。"""
    assert os.access(script, os.X_OK)
