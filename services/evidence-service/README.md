# evidence-service

存证唯一写入方（D-04、G-07）。设计见 docs 仓库 `docs/design/080-evidence.md`。

## 职责

- 关联事件产生时，把命中路径中的告警、行为、画面完整性事件，关联事件本身，以及相关摄像头在每条命中事件前后各 30 s 的录像写入存证（FR-701）；录像取自 recorder（MediaMTX 回放接口），原始码流不转码（C-EVD-02）
- 存证目录 `chain.jsonl` + `objects/`：只追加的哈希链，每条记录 Ed25519 签名（D-098）；载荷按内容寻址、写入后只读；没有修改或删除接口（C-EVD-01）
- 启动时逐条重算哈希链并用公钥验签，不一致、签名无效或残行即拒绝启动，异常写明第几条
- 启动日志 `evidence.started` 输出公钥指纹 `public_key_fingerprint`：证据包自带公钥，校验时须与这个另行记下的指纹比对
- 按关联事件导出证据包：`manifest.json` + `manifest.sig` + `public_key.pem` + 该事件的连续记录 + 载荷（C-EVD-04）

## 接口

内部 HTTP（core-net，只供 api-server 调用；鉴权与审计在 api-server 的 `POST /api/incidents/{id}/evidence/export`）：

- `GET /internal/incidents/{id}/package`：证据包 zip；没有记录时 404
- `GET /healthz`

## 配置项

见 `src/evidence_service/service.py` 的 `EvidenceConfig`。签名私钥 `evidence_signing_key` 由 `make demo-up` 首次生成，只挂给本服务（G-14）。

## 本地运行

```sh
uv run --all-packages pytest services/evidence-service
```
