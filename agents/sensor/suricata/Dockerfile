# 网络入侵检测（REUSE-08）：GPL 组件以独立进程运行，不修改源码（C-RU-02）
# ET Open 快照与自研规则打包进镜像，运行时不下载规则（G-05）；镜像自带的 suricata-update 不启用
FROM jasonish/suricata:8.0.7@sha256:bf4bea5b45d9c10265a3ee6628e2ec8930b9d1fb7caf9d1afb63af413b9cbb26

ADD rules/vendor/et-open/emerging-all.rules.tar.gz /etc/suricata/rules/
COPY rules/suricata/ /etc/suricata/rules/
COPY agents/sensor/suricata/hyd.yaml /etc/suricata/hyd.yaml

# 只读根文件系统下不经入口脚本 chown：配置对启动时的 root（无 DAC_OVERRIDE）可读
RUN chmod -R a+rX /etc/suricata
