# 网络元数据（REUSE-08）：会话级 JSON 日志，只读抓包（C-SEC-08）
# 以非 root 运行（参照 Malcolm）：抓包能力以文件能力授予 zeek 可执行文件，setcap 工具用后即删
FROM zeek/zeek:8.0.11@sha256:3882d4b46fa82993ecb50b8881389fe4e40e8e2ba77547402f72b65a5a89591b

RUN apt-get update \
    && apt-get install -y --no-install-recommends libcap2-bin \
    && setcap cap_net_raw=eip /usr/local/zeek/bin/zeek \
    && apt-get purge -y libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin zeek \
    && install -d -o zeek -g zeek /zeek/logs

USER zeek
WORKDIR /zeek/logs
ENTRYPOINT ["zeek"]
