#!/bin/sh
# 把抓包源的流量单向镜像进探针网络的网桥（C-SEC-08）：探针只接入探针网络，被攻破也到不了被监测的网络与宿主。
# 用法：capture-tap.sh <抓包源> <探针网络的网桥>
# 抓包源为网桥（演示的 demo-net）：挂一个镜像端口并让网桥向所有端口泛洪（ageing_time 0），从镜像端口取流量。
# 抓包源为网卡（真实部署接交换机镜像端口、不配置 IP）：直接镜像其入向流量。重复执行结果相同。
set -eu
src=$1
tap=$2

if [ -d "/sys/class/net/$src/bridge" ]; then
    ip link del hyd-span 2>/dev/null || true
    ip link add hyd-span type veth peer name hyd-span-in
    # 镜像端口不生成 IPv6 链路本地地址，宿主不会经它向被监测网络发包
    ip link set hyd-span addrgenmode none
    ip link set hyd-span-in addrgenmode none
    ip link set hyd-span master "$src" up
    ip link set hyd-span-in up
    ip link set "$src" type bridge ageing_time 0
    src=hyd-span-in
fi

tc qdisc replace dev "$src" clsact
tc filter replace dev "$src" ingress pref 1 handle 1 matchall action mirred egress mirror dev "$tap"
echo "capture-tap: $src -> $tap"
