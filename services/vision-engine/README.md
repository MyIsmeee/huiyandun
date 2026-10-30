# vision-engine

视觉引擎（HYD-ARCH-001 §8）：经 go2rtc 拉流，检测人体与骨骼并跟踪、识别环境，输出 `contracts/events/hyd.vision.*` 结构化事件；不输出人员裁剪图（C-CV-02）。

## 职责

- 坐标映射（`geometry.py`）：由 `site.yaml` 的标定点 `[u, v, x, y]` 拟合地平面单应矩阵，脚点像素 → 平面坐标（米）
  - 标定点少于 4 组，或像素点中找不到 4 个任意三点不共线的点时，摄像头为未标定，不输出坐标（FR-902、C-CV-05）
  - `uncertainty_m` = 标定点重投影误差的均方根 + 脚点上下偏移人体框高度 5% 在地面上的较大偏移（C-CV-06）。恰好 4 组标定点时前者为 0
  - 脚点或偏移点位于地平线以上时不输出坐标
- 推理会话（`runtime.py`）：从本地模型文件创建 ONNX Runtime 会话（C-RU-06）
  - `HYD_DEVICE` 无默认值，须显式声明。`cuda` 时设置显存上限：`HYD_GPU_MEM_LIMIT_MB` 是整个服务的上限，由加载的模型平分（RTMO、RF-DETR、EfficientViT-Seg 各三分之一），总占用不超过该值（C-HW-12），并断言 `CUDAExecutionProvider` 实际生效，回退 CPU 即报错退出（C-CV-11）；`cpu` 为 D0-min 的 CPU 模式（DP-06）
- 检测（`detector.py`）：rtmlib RTMO 单阶段输出人体框与 COCO 17 关键点（REUSE-05），结果换算回整帧坐标；置信度低于 0.3 的框丢弃
- 车辆检测（`detector.py` 的 `VehicleDetector`）：RF-DETR-S（REUSE-22）经 rtmlib 推理（`HYD_VEHICLE_MODEL_FILE` 未配置时只检测人员），只取自行车、轿车、摩托车、公交、货车，置信度低于 0.3 的框丢弃；后处理自行完成，以保留 ByteTrack 需要的置信度
- 运动估计（`kinematics.py`）：由最近 1 s 的实测平面坐标计算朝向与速度；起步不足 3 帧为 null，低于 0.3 m/s 视为静止、不输出朝向；不预测未来位置（FR-102）
- 运动门控（`motion.py`，借鉴 Frigate）：缩小灰度图与滑动平均背景做帧差，运动区域并入上一帧的轨迹框，扩展 20% 且不小于 640×640 后送推理；无运动且无轨迹时跳过推理。静止的人（如跌倒后）靠轨迹框保持推理
- 检测链路（`pipeline.py`）：每路摄像头一个读帧线程，经 go2rtc 的 RTSP 取流（C-CV-10），持续解码、只保留最新帧；检测固定 5 FPS 取用最新帧，处理慢时丢帧而不积压延迟（FR-101、C-CV-08）
  - 跟踪：Roboflow trackers 的 ByteTrack，只用框的运动，不用外观特征（G-04、REUSE-07）；新轨迹须连续 2 帧、置信度 ≥ 0.5
  - 人员与车辆分别跟踪（骑车人与车框重叠，混合跟踪会互换编号）；车辆轨迹编号加 1 000 000，类别取轨迹内多数，避免两轮车在自行车与摩托车之间闪烁
  - 已标定摄像头的每条已确认轨迹每帧发布一条 `hyd.vision.track.v1`（核心 NATS，不持久化），含类别、朝向、速度、画面归一化框与骨骼（车辆无骨骼）；脚点取框底边中点；未标定摄像头照常检测跟踪，但不发布坐标（FR-902）
  - 断流时记录 `vision.stream_lost` 并每 2 s 重连，恢复时记录 `vision.stream_restored`（`stream_lost` 事件由 TK-114 发布）
  - 各路隔离（#79）：单路检测或场景循环抛出异常时记录 `vision.loop_failed`，2 s 后只重试该路；读帧异常记录 `vision.reader_failed` 后按断流重连
  - 健康检查：按路判断，检测与场景循环每完成一个周期、读帧线程每次建连与每读到一帧登记一次；全部在 10 s 内有登记时每秒更新 `HYD_HEARTBEAT_FILE`。任一路停滞（卡住或线程意外退出）即记录 `vision.stalled` 并退出进程，由 Compose `restart: unless-stopped` 拉起
- 场景感知（`scene.py`，FR-108）：已标定摄像头每秒 1 次取最新帧，EfficientViT-Seg L1 ADE20K（REUSE-25，`HYD_SCENE_MODEL_FILE` 未配置时不输出场景）输出 64×64 格，150 类按随代码版本化的映射表归并为渲染类别（地面 road / sidewalk / floor / grass / earth，立面 wall / building / fence / railing / board（黑板），物体 table / chair / cabinet / sofa / bed / furniture / street_furniture，植被 tree / plant）；人员与车辆不在场景中
  - 不输出：最大类别概率低于 0.5 的格，灰度均值低于 40 或高于 250 的格（暗光、过曝、画面黑边）
  - 平滑：每格取近 3 次的多数类别，连续 2 次识别即翻转
  - 投影（与 track 同一套单应映射）：地面取外轮廓（人与车辆遮挡处不留孔洞）；立面取每列最低一格的底边为墙脚线，遇跳变断开，高度按类别取 2.8 / 6 / 1.2 / 1.0 m，黑板取其下方的墙脚线、高 1.2 m；物体取底边并向远离摄像头一侧补出底面，深与高按类别取常见尺寸（`scene.py` 的 `OBJECT_SIZE_M`）；树取底部中心，高 5 m（盆栽 1 m）；地平线以上与超出 `pose.range_m` 的部分丢弃；按 0.2 m 简化
  - 路面标线：路面外轮廓内亮度 ≥ 190、饱和度 ≤ 50 的细长条纹（长宽比 ≥ 3、宽 ≤ 1 m）；至少 3 条平行并排、间距 3 m 内的为斑马线，其余为车道线
  - 地面、物体与标线合计保留面积最大的 64 个多边形；每帧发布一条 `hyd.vision.scene.v1`（核心 NATS，不持久化），无任何有效识别或断流时不发布，大屏保留上一帧
- 依赖：supervision 声明的 PyAV（自带 GPL 的 x264 / x265）与 matplotlib 由根 `pyproject.toml` 的 `override-dependencies` 去掉（G-08、REUSE-07）

## 命令

```sh
hyd-vision      # 常驻检测（镜像默认命令）；启动时同样断言推理设备
hyd-gpu-check   # 按 HYD_DEVICE 加载全部模型（RTMO、RF-DETR、EfficientViT-Seg）并断言推理设备；cuda 未生效时以 1 退出
```

`make doctor` 以 `compose.gpu.yaml`（`HYD_DEVICE=cuda`）运行 `hyd-gpu-check`。`make demo-up` 默认加载 `compose.gpu.yaml`，无 GPU 时须显式 `GPU=0`。

## 镜像

基础镜像为 CUDA 13 cuDNN runtime（C-HW-07），其 CUDA 主版本须与 `onnxruntime-gpu` 一致（C-HW-08）。Windows 侧驱动须支持 CUDA 13（580 及以上）。模型权重不打进镜像，由 `make fetch-models` 下载到 `models/weights/` 后只读挂载。

onnxruntime 默认在 import 时向 `mobile.events.data.microsoft.com` 发送遥测（抓包确认）。镜像设置 `ORT_DISABLE_TELEMETRY=1` 关闭，测试由 `tests/conftest.py` 关闭（G-05）。本地直接运行 `hyd-gpu-check` 时须自行设置该变量。
