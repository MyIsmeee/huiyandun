# 模型卡：efficientvit-seg-l1（C-CV-07）

| 项 | 内容 |
|---|---|
| 版本 | `efficientvit-seg-l1-ade20k@cf3ccaf9+hyd.1`（未修改上游权重，只转换格式） |
| 用途 | 场景语义分割：识别摄像头画面中的地面、路面、人行道、草地、墙、建筑、围栏、家具、树，投影到地面后供实时感知大屏重建环境（HYD-REQ-006 FR-108）。人员、车辆类别不使用，由 rtmo-s、rfdetr-s 检出 |
| 上游 | MIT Han Lab EfficientViT-Seg L1（ADE20K）；权重为 Hugging Face `han-cai/efficientvit-seg` 提交 `cf3ccaf9` 的 `efficientvit_seg_l1_ade20k.pt`，模型代码为 `mit-han-lab/efficientvit` 提交 `de7d7733` |
| 许可证 | Apache-2.0（代码与权重） |
| 训练数据 | ADE20K（上游公开数据集，使用条款见其官网） |
| 转换 | `make fetch-models` 核对上游权重哈希后，由 `tools/dev/export_efficientvit_seg.py` 在 uv 临时环境中以 PyTorch 2.8.0 CPU 导出（opset 17）；依赖锁定于同名 `.lock`，导出可复现（两次导出哈希一致），不进入运行镜像 |
| 导出精度 | FP32；输入 `1×3×512×512`（ImageNet 均值方差归一化的 RGB）；输出 150 类 `64×64` logits |
| 目标平台 | ONNX Runtime：CUDA EP（D0：sm_120；开发机：sm_86）与 CPU EP（D0-min） |
| 输入帧率 | 每台已标定摄像头每秒 1 次，取最新帧 |

## 评测指标

| 指标 | 值 | 来源 |
|---|---|---|
| ADE20K val mIoU | 49.2（512×512） | 上游报告 |
| 单帧耗时（CPU，6 核） | 约 500 ms | 本地实测 |
| 演示素材抽帧 | cam-01、cam-02 共 8 帧：街道的路面与人行道分开、两侧建筑检出；室内的地面、墙、家具检出；乡村路的路面与围栏检出；火灾暗光画面识别失败 | 本地实测 |
| 各类别 IoU / 每路每小时误识别 | 未评测 | 尚无标注评测集 |

## 限制

- 只输出环境类别，不识别人脸、身份与属性（G-04）
- 暗光、强光（如夜间、火光）画面识别不可靠，低置信区域不输出
- 只到语义类别，不估计深度：立面与物体只取其与地面接触的下边缘投影，高度按类别取默认值
