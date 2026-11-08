# evidence-verify

离线校验工具 `hyd-evidence verify`（C-EVD-03、FR-703）：在不运行慧眼盾的机器上校验 evidence-service 导出的证据包。包格式见 docs 仓库 `docs/archive/design/080-evidence.md` §4。只读包内文件，不访问网络；只依赖 `cryptography`，不 import 慧眼盾的其他代码。

## 用法

```sh
hyd-evidence verify evidence-<关联事件 ID>.zip --fingerprint sha256:<可信公钥指纹>
```

- 参数可以是 zip，也可以是解压后的目录
- `--fingerprint` 是另行取得的可信值：部署后从 evidence-service 启动日志 `evidence.started` 的 `public_key_fingerprint` 记下。包内自带公钥，篡改者可以换钥后整包重签，所以指纹不符时直接判定整包不可信
- 退出码：0 通过；1 未通过，逐条列出问题与位置（第几条记录、chain.jsonl 第几行、哪个文件）；2 用法错误或包无法读取

检出范围：改记录（摘要不符；重算摘要则签名无效、下一条不衔接）、改记录签名、改 manifest 或其签名、改载荷、删首尾或中间记录、换钥重签。

## 在另一台机器上使用

目标机器需要 Python 3.12。

```sh
uv build --package evidence-verify -o dist/evidence-verify   # 在仓库中打包
pip install dist/evidence-verify/evidence_verify-0.1.0-py3-none-any.whl   # 在目标机器上安装
```

目标机器不能联网时，另带 `cryptography` 及其依赖的 wheel（版本见 `uv.lock`）：`pip download cryptography==<版本> --only-binary=:all: --python-version 3.12 --platform <目标平台，如 win_amd64> -d wheels`，安装时加 `--no-index --find-links wheels`。

## 测试

```sh
uv run --all-packages pytest libs/evidence-verify
```
