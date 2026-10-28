#!/bin/sh
# 把抓包源的流量单向镜像进探针网络的网桥（C-SEC-08）：探针只接入探针网络，被攻破也到不了被监测的网络与宿主。
# 用法：capture-tap.sh <抓包源> <探针网络的网桥>
# 抓包源为网桥（演示的 demo-net）：挂一个镜像端口并让网桥向所有端口泛洪（ageing_time 0），从镜像端口取流量。
# 抓包源为网卡（真实部署接交换机镜像端口、不配置 IP）：开混杂模式并镜像其入向流量。重复执行结果相同。
set -eu
src=$1
tap=$2

# 宿主在网桥上不留地址：Docker 的 isolated 只管 IPv4，内核仍会生成 IPv6 链路本地地址
no_host_address() {
    ip link set dev "$1" addrgenmode none
    ip -6 addr flush dev "$1"
}

no_host_address "$tap"
if ip -j -d link show dev "$src" | grep -q '"info_kind":"bridge"'; then
    no_host_address "$src"
    ip link del hyd-span 2>/dev/null || true
    ip link add hyd-span type veth peer name hyd-span-in
    ip link set hyd-span addrgenmode none
    ip link set hyd-span-in addrgenmode none
    ip link set hyd-span master "$src" up
    ip link set hyd-span-in up
    ip link set "$src" type bridge ageing_time 0
    src=hyd-span-in
else
    # 镜像来的帧目标 MAC 都不是本网卡，不开混杂模式会被网卡丢弃；
    # 关闭 GRO/LRO，探针看到原始报文而不是合并后的大包（参照 Security Onion）
    ip link set dev "$src" promisc on
    ethtool -K "$src" gro off lro off \
        || echo "capture-tap: $src 无法关闭 GRO/LRO，探针可能看到合并后的大包" >&2
fi

tc qdisc replace dev "$src" clsact
tc filter replace dev "$src" ingress pref 1 handle 1 matchall action mirred egress mirror dev "$tap"
echo "capture-tap: $src -> $tap"
