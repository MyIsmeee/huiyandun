# vision-engine

视觉引擎（HYD-ARCH-001 §8）：经 go2rtc 拉流，检测人体与骨骼并跟踪，输出 `contracts/events/hyd.vision.*` 结构化事件；不输出人员裁剪图（C-CV-02）。

## 职责

- 坐标映射（`geometry.py`）：由 `site.yaml` 的标定点 `[u, v, x, y]` 拟合地平面单应矩阵，脚点像素 → 平面坐标（米）
  - 标定点少于 4 组，或像素点中找不到 4 个任意三点不共线的点时，摄像头为未标定，不输出坐标（FR-902、C-CV-05）
  - `uncertainty_m` = 标定点重投影误差的均方根 + 脚点上下偏移人体框高度 5% 在地面上的较大偏移（C-CV-06）。恰好 4 组标定点时前者为 0
  - 脚点或偏移点位于地平线以上时不输出坐标
- 推理会话（`runtime.py`）：从本地模型文件创建 ONNX Runtime 会话（C-RU-06）
  - `HYD_DEVICE` 无默认值，须显式声明。`cuda` 时设置显存上限 `HYD_GPU_MEM_LIMIT_MB`（C-HW-12），并断言 `CUDAExecutionProvider` 实际生效，回退 CPU 即报错退出（C-CV-11）；`cpu` 为 D0-min 的 CPU 模式（DP-06）

## 命令

```sh
hyd-gpu-check   # 按 HYD_DEVICE 加载模型并断言推理设备；cuda 未生效时以 1 退出
```

`make doctor` 以 `compose.gpu.yaml`（`HYD_DEVICE=cuda`）运行 `hyd-gpu-check`。`make demo-up` 默认加载 `compose.gpu.yaml`，无 GPU 时须显式 `GPU=0`。

## 镜像

基础镜像为 CUDA 13 cuDNN runtime（C-HW-07），其 CUDA 主版本须与 `onnxruntime-gpu` 一致（C-HW-08）。Windows 侧驱动须支持 CUDA 13（580 及以上）。模型权重不打进镜像，由 `make fetch-models` 下载到 `models/weights/` 后只读挂载。

onnxruntime 默认在 import 时向 `mobile.events.data.microsoft.com` 发送遥测（抓包确认）。镜像设置 `ORT_DISABLE_TELEMETRY=1` 关闭，测试由 `tests/conftest.py` 关闭（G-05）。本地直接运行 `hyd-gpu-check` 时须自行设置该变量。
