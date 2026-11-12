# vision-engine

视觉引擎（architecture.md §8）：经 go2rtc 拉流，检测人体与骨骼并跟踪、识别环境，输出 `contracts/events/hyd.vision.*` 结构化事件；不输出人员裁剪图（C-CV-02）。

## 职责

- 坐标映射（`geometry.py`）：由 `site.yaml` 的标定点 `[u, v, x, y]` 拟合地平面单应矩阵，脚点像素 → 平面坐标（米）
  - 标定点少于 4 组，或像素点中找不到 4 个任意三点不共线的点时，摄像头为未标定，不输出坐标（FR-902、C-CV-05）
  - `uncertainty_m` = 标定点重投影误差的均方根 + 脚点上下偏移人体框高度 5% 在地面上的较大偏移（C-CV-06）。恰好 4 组标定点时前者为 0
  - 脚点或偏移点位于地平线以上时不输出坐标
- 推理会话（`runtime.py`）：从本地模型文件创建 ONNX Runtime 会话（C-RU-06）
  - `HYD_DEVICE` 无默认值，须显式声明。`cuda` 时设置显存上限：`HYD_GPU_MEM_LIMIT_MB` 是整个服务的上限，由加载的模型平分（RTMO、RF-DETR、EfficientViT-Seg、DINOv2 各四分之一），总占用不超过该值（C-HW-12），并断言 `CUDAExecutionProvider` 实际生效，回退 CPU 即报错退出（C-CV-11）；`cpu` 为 D0-min 的 CPU 模式（DP-06）
- 人员检测（`detector.py` 的 `PoseDetector`）：rtmlib RTMO 单阶段输出人体框与 COCO 17 关键点（REUSE-05），与 RF-DETR 的人员框取并集（#287），结果为整帧坐标
  - 同一人（IoU ≥ 0.3）用 RF-DETR 的框与置信度、RTMO 的骨骼；RF-DETR 独有的人（多为远处的小目标）关键点置信度为 0，不参与行为判定
  - RTMO 独有的框（置信度 ≥ 0.3）保留；把某个 RF-DETR 人员覆盖 ≥ 80% 的松散框丢弃
  - 有横躺（框宽大于高）且没配上骨骼的 RF-DETR 人员时，另以左右各旋转 90° 的画面推理，只给这些人补骨骼、不新增人员
- 车辆检测（`detector.py` 的 `VehicleDetector`）：RF-DETR-S（REUSE-22）经 rtmlib 推理，每帧一次，车辆只取自行车、轿车、摩托车、公交、货车，人员框交给人员检测合并，置信度低于 0.3 的框丢弃（`HYD_VEHICLE_MODEL_FILE` 未配置时没有车辆，人员只有 RTMO 的正向检出）；后处理自行完成，以保留 ByteTrack 需要的置信度
- 运动估计（`kinematics.py`）：由最近 1 s 的实测平面坐标计算朝向与速度；起步不足 3 帧为 null，低于 0.3 m/s 视为静止、不输出朝向；不预测未来位置（FR-102）
- 运动门控（`motion.py`，借鉴 Frigate）：缩小灰度图与滑动平均背景做帧差，运动区域并入上一帧的轨迹框，扩展 20% 且不小于 640×640 后送推理；无运动且无轨迹时跳过推理。静止的人（如跌倒后）靠轨迹框保持推理
- 检测链路（`pipeline.py`）：每路摄像头一个读帧线程，经 go2rtc 的 RTSP 取流（C-CV-10），持续解码、只保留最新帧；检测固定 5 FPS 取用最新帧，处理慢时丢帧而不积压延迟（FR-101、C-CV-08）
  - 跟踪：Roboflow trackers 的 ByteTrack，只用框的运动，不用外观特征（G-04、REUSE-07）；新轨迹须连续 2 帧、置信度 ≥ 0.5
  - 人员与车辆分别跟踪（骑车人与车框重叠，混合跟踪会互换编号）；车辆轨迹编号加 1 000 000，类别取轨迹内多数，避免两轮车在自行车与摩托车之间闪烁
  - 已标定摄像头的每条已确认轨迹每帧发布一条 `hyd.vision.track.v1`（核心 NATS，不持久化），含类别、朝向、速度、画面归一化框与骨骼（车辆无骨骼）；脚点取框底边中点；未标定摄像头照常检测跟踪，但不发布坐标（FR-902）
  - 画面可信度（`integrity.py`，C-CV-09）：判定先于运动门控（定格画面没有运动，门控会跳过推理），结果发布为 `hyd.vision.integrity.v1`（JetStream）
    - 冻结（`source=rule`）：相邻帧逐像素相同满 5 s 报一次，出现不同帧即重新计时（FR-301）
    - 重放（`source=model`）：DINOv2-small（REUSE-23，`HYD_INTEGRITY_MODEL_FILE` 未配置时不判定）每个检测帧取一次整帧嵌入，只在内存中保留 190 s。每秒以最近 10 s 与距今 30～180 s 的各段比较：两段各自去掉均值与线性趋势后求相关系数，连续 3 次匹配同一历史时刻且 ≥ 0.35 即报一次，`detail` 写匹配到的时刻；连续 10 次不匹配后再匹配重新上报。当前 10 s 内有画面切换（相邻嵌入相似度 < 0.5）时不判定。静止画面只剩噪声，不判重放（FR-302）
    - 挪位与遮挡（`source=model`）：每路启动后前 10 s 的嵌入均值为参考画面，只在内存中，断流重连不重记（D-090）。与参考画面的相似度 < 0.9 持续 5 s 即报一次：画面边缘像素占比 < 0.5%（纹理消失）为 `occlusion`，否则为 `shift`；恢复相似或类别改变即重新计时（FR-308）。调试素材剪接处画面整体改变，按挪位上报，每路每轮循环 1～2 次（D-091）
  - 断流时记录 `vision.stream_lost` 并每 2 s 重连，恢复时记录 `vision.stream_restored`；检测循环 5 s 取不到新帧即发布 `stream_lost`（启动后首帧宽限至 10 s）（不依赖读帧线程何时发现连接断开；推流源切换、重启时的瞬断不算）（`source=rule`，`duration_s` 为已断流时长），持续断流每 30 s 重报，api-server 据此保持设备离线（FR-105、D-092）
  - 各路隔离（#79）：单路检测循环抛出异常时记录 `vision.loop_failed`，2 s 后只重试该路；读帧异常记录 `vision.reader_failed` 后按断流重连
  - 健康检查：按路判断，检测循环每完成一个周期、读帧线程每次建连与每读到一帧登记一次；全部在 10 s 内有登记时每秒更新 `HYD_HEARTBEAT_FILE`。任一路停滞（卡住或线程意外退出）即记录 `vision.stalled` 并退出进程，由 Compose `restart: unless-stopped` 拉起
- 场景感知（`scene.py`，FR-909、D-133）：平时不推理；收到 `hyd.vision.scene_request.v1`（核心 NATS 请求/应答，api-server 在场景页生成初稿时发出）时，对请求中各摄像头的当前画面逐台识别一次，以 `hyd.vision.scene_reply.v1` 应答。EfficientViT-Seg L1 ADE20K（REUSE-25）输出 64×64 格，150 类按随代码版本化的映射表归并为渲染类别（地面 road / sidewalk / floor / grass / earth，立面 wall / building / fence / railing / board（黑板），物体 table / chair / cabinet / sofa / bed / furniture / street_furniture，植被 tree / plant）；人员与车辆不在场景中
  - 不输出：最大类别概率低于 0.5 的格，灰度均值低于 40 或高于 250 的格（暗光、过曝、画面黑边）
  - 投影（与 track 同一套单应映射）：地面取外轮廓（人与车辆遮挡处不留孔洞）；立面取每列最低一格的底边为墙脚线，遇跳变断开，高度按类别取 2.8 / 6 / 1.2 / 1.0 m，黑板取其下方的墙脚线、高 1.2 m；物体取底边并向远离摄像头一侧补出底面，深与高按类别取常见尺寸（`scene.py` 的 `OBJECT_SIZE_M`）；树取底部中心，高 5 m（盆栽 1 m）；地平线以上与超出 `pose.range_m` 的部分丢弃；按 0.2 m 简化
  - 路面标线：路面外轮廓内亮度 ≥ 190、饱和度 ≤ 50 的细长条纹（长宽比 ≥ 3、宽 ≤ 1 m）；至少 3 条平行并排、间距 3 m 内的为斑马线，其余为车道线
  - 地面、物体与标线合计保留面积最大的 64 个多边形；每台摄像头在应答中或有一帧 `hyd.vision.scene.v1`，或给出原因：`model_missing`（未配置 `HYD_SCENE_MODEL_FILE`）、`no_frame`（最新一帧已超过 5 s 或尚未取到帧，与断流判定同一标准）、`unmapped`（建立不了地面映射）、`empty`（无任何有效识别）
- 地面标定（`geometry.py`，FR-910、D-132）：收到 `hyd.vision.calibration_request.v1`（核心 NATS 请求/应答，api-server 在标定对话框检查与保存时发出）时按标定点拟合单应矩阵，以 `hyd.vision.calibration_reply.v1` 应答均方根误差与各组偏差；拟合不了时给出原因 `pixels_collinear` / `ground_collinear`（画面点或地面点找不到 4 个任意三点不共线的点）或 `inconsistent`（单应矩阵退化，或标定点分处地平线两侧）。纯计算，与该路是否运行无关
- 依赖：supervision 声明的 PyAV（自带 GPL 的 x264 / x265）与 matplotlib 由根 `pyproject.toml` 的 `override-dependencies` 去掉（G-08、REUSE-07）

## 命令

```sh
hyd-vision      # 常驻检测（镜像默认命令）；启动时同样断言推理设备
hyd-gpu-check   # 按 HYD_DEVICE 加载全部模型（RTMO、RF-DETR、EfficientViT-Seg、DINOv2）并断言推理设备；cuda 未生效时以 1 退出
```

`make doctor` 以 `compose.gpu.yaml`（`HYD_DEVICE=cuda`）运行 `hyd-gpu-check`。`make demo-up` 默认加载 `compose.gpu.yaml`，无 GPU 时须显式 `GPU=0`。

## 镜像

基础镜像为 CUDA 13 cuDNN runtime（C-HW-07），其 CUDA 主版本须与 `onnxruntime-gpu` 一致（C-HW-08）。Windows 侧驱动须支持 CUDA 13（580 及以上）。模型权重不打进镜像，由 `make fetch-models` 下载到 `models/weights/` 后只读挂载。

onnxruntime 默认在 import 时向 `mobile.events.data.microsoft.com` 发送遥测（抓包确认）。镜像设置 `ORT_DISABLE_TELEMETRY=1` 关闭，测试由 `tests/conftest.py` 关闭（G-05）。本地直接运行 `hyd-gpu-check` 时须自行设置该变量。
