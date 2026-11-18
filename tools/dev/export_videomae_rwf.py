# /// script
# requires-python = "==3.12.*"
# dependencies = [
#     "torch==2.8.0",
#     "numpy==2.5.4",
#     "onnx==1.23.2",
#     "transformers==4.46.3",
#     "safetensors==0.7.0",
# ]
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""VideoMAE-base（RWF-2000 打斗数据集微调，DanJoshua/videomae_v1_rwf-2000）→ ONNX（构建期）。

用法：uv run --script --locked tools/dev/export_videomae_rwf.py <model.safetensors> <输出.onnx>
由 make fetch-models 在核对权重哈希后调用；config.json 按 CONFIG_URL 下载并核对 CONFIG_SHA256。

上游的分类头配置有误：类别数写成了训练视频的文件数（1743），实际只训练了前两类（0 打架、1 非打架），其余输出
恒为负。导出时只取前两类做 softmax：输入 frames (N, 16, 3, 224, 224)（ImageNet 均值方差归一化的 RGB，float32），
输出 probs (N, 2)（float32）。网络内部为半精度（fp16）：显存约为单精度的一半（512 MiB 上限可用、单次约 38 ms），
本地素材上打架概率与单精度相差不到 0.002。
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

import torch
from transformers import VideoMAEConfig, VideoMAEForVideoClassification

COMMIT = "a6109ed1103c8e8983186881a0a04f7373f3d84c"
CONFIG_URL = f"https://huggingface.co/DanJoshua/videomae_v1_rwf-2000/resolve/{COMMIT}/config.json"
CONFIG_SHA256 = "dfa91c84099aa8733d30ba7ab2645f7bd169c3b87ed6543e3c88fc3aa899edc8"
TIMEOUT_S = 120


class TwoClass(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, frames: torch.Tensor) -> torch.Tensor:
        logits = self.model(pixel_values=frames.half()).logits[:, :2].float()
        return torch.softmax(logits, dim=-1)


def main(weights: Path, output: Path) -> None:
    with urllib.request.urlopen(CONFIG_URL, timeout=TIMEOUT_S) as response:
        raw = response.read()
    if hashlib.sha256(raw).hexdigest() != CONFIG_SHA256:
        sys.exit("config.json 哈希不符，拒绝使用")
    directory = output.parent / "videomae"
    directory.mkdir(exist_ok=True)
    (directory / "config.json").write_bytes(raw)
    (directory / "model.safetensors").symlink_to(weights.resolve())
    config = VideoMAEConfig.from_pretrained(directory)
    model = VideoMAEForVideoClassification.from_pretrained(directory, config=config).eval().half()
    with torch.no_grad():
        torch.onnx.export(
            TwoClass(model),
            (torch.zeros(1, 16, 3, 224, 224),),
            str(output),
            input_names=["frames"],
            output_names=["probs"],
            dynamic_axes={"frames": {0: "n"}, "probs": {0: "n"}},
            opset_version=17,
            dynamo=False,
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
