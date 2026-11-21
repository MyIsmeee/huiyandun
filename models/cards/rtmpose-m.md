# 模型卡：rtmpose-m（C-CV-07）

| 项 | 内容 |
|---|---|
| 版本 | `rtmpose-m@e48f03d0_20230504+hyd.1`（未修改上游权重） |
| 用途 | 两阶段姿态估计的第二阶段：按 rfdetr-s / rtmo-s 给出的人员框，从原画面裁剪（外扩 1.25 倍）、仿射到 192×256 后估计 COCO 17 关键点，取代 rtmo-s 的整帧骨骼（`detector.TopDownPose`）。不检测人员、不区分身份 |
| 上游 | MMPose `projects/rtmpose`，配置 `rtmpose-m_simcc-body7_pt-body7_420e-256x192`；ONNX 由 MMDeploy 导出 |
| 许可证 | Apache-2.0（MMPose 代码与权重） |
| 训练数据 | body7：AI Challenger、COCO、CrowdPose、Halpe、MPII、PoseTrack18、sub-JHMDB（上游公开数据集，各自的使用条款见其官网） |
| 导出精度 | FP32；输入 `N×3×256×192`，输出 SimCC（x 384 维、y 512 维，细分倍数 2） |
| 目标平台 | ONNX Runtime：CUDA EP 与 CPU EP |

## 评测指标

| 指标 | 值 | 来源 |
|---|---|---|
| COCO val2017 AP | 0.749 | 上游报告（body7 训练、256×192 输入） |
| 与 rtmo-s 对比（cam-05 实时画面，15 帧、103 人次，同一批人员框） | 置信度 ≥ 0.3 的可见比例：鼻 39% → 82%，肩约 73% → 84%，髋约 70% → 82%，膝 45%～61% → 66%～70%，踝 26%～51% → 63% | 本地实测，2026-11-17 |
| 单人耗时（CPU） | 约 55 ms | 同上 |

## 限制

- 逐人模型会把被桌椅挡住的腿"猜"出来（置信度偏低）：膝、踝置信度低于 0.4 的视为不可见（`detector.LOWER_BODY_MIN`）
- 横躺者（框宽大于高）保留 rtmo-s 正向与旋转推理中骨骼更清楚的一方，不一律换成本模型的结果
- 不含人脸、身份或属性信息；关键点中的鼻、眼、耳只用于骨骼几何，不做人脸分析（G-04）
