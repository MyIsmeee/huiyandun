# 模型卡：rtmo-s（C-CV-07）

| 项 | 内容 |
|---|---|
| 版本 | `rtmo-s@dac2bf74_20231211+hyd.1`（未修改上游权重） |
| 用途 | 单阶段多人姿态估计：每人输出人体框与 COCO 17 关键点；耗时与画面人数无关（HYD-ARCH-001 §8.1） |
| 上游 | MMPose `projects/rtmo`，配置 `rtmo-s_8xb32-600e_body7-640x640`；ONNX 由 MMDeploy 1.3.0 导出 |
| 许可证 | Apache-2.0（MMPose 代码与权重） |
| 训练数据 | body7：AI Challenger、COCO、CrowdPose、Halpe、MPII、PoseTrack18、sub-JHMDB（上游公开数据集，各自的使用条款见其官网） |
| 导出精度 | FP32；输入 `1×3×640×640`，ONNX opset 11；模型内含 NMS（IoU 0.5，最多 50 人） |
| 目标平台 | ONNX Runtime：CUDA EP（D0：sm_120；开发机：sm_86）与 CPU EP（D0-min） |
| 输入帧率 | 固定 5 FPS（C-CV-08、FR-101）；行为判定（TK-022）的时序门限按此帧率设定 |

## 评测指标

| 指标 | 值 | 来源 |
|---|---|---|
| COCO val2017 AP / AR | 0.686 / 0.723 | 上游报告 |
| 单帧耗时（CPU，6 核，1280×720 输入） | 约 80 ms | 本地实测，演示素材 14 帧 |
| 召回 / 精确率 / 每路每小时误报 | 未评测 | 尚无标注评测集；M0 按 HYD-PROC-002 §3.6"CV 效果"的简化评测补齐 |

## 限制

- 不含人脸、身份或属性信息；关键点中的鼻、眼、耳只用于骨骼几何，不做人脸分析（G-04）
