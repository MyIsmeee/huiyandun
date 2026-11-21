# /// script
# requires-python = "==3.12.*"
# dependencies = [
#     "torch==2.8.0",
#     "numpy==2.5.4",
#     "onnx==1.23.2",
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
"""STGCN++（mmaction2，NTU60 二维骨骼）：joint 与 bone 两路 PyTorch 权重 → 一个 ONNX（构建期）。

用法：uv run --script --locked tools/dev/export_stgcnpp.py <joint 权重.pth> <输出.onnx>
由 make fetch-models 在核对 joint 权重哈希后调用；bone 权重按 BONE_URL 下载并核对 BONE_SHA256。
依赖由同名 .lock 锁定，只装进 uv 的临时环境，不进入工作区锁文件与运行镜像；上游代码固定到
UPSTREAM_COMMIT（v1.2.0），只取模型定义的三个文件，mmcv、mmengine 以最小替身代替（只用到 ReLU、BN）。

导出的模型输入关节 keypoints (N, 2, 100, 17, 3)：2 人、100 帧、COCO 17 点、(x, y, 置信度)，坐标按
mmaction2 的 PreNormalize2D 归一化到 [-1, 1]；bone 在图内由关节按 COCO 父节点求出（JointToBone）。
输出 probs (N, 60)：两路 softmax 概率 1:1 平均（mmaction2 两路融合，NTU60-XSub 92.6%）。
"""

import hashlib
import shutil
import subprocess
import sys
import types
import urllib.request
from pathlib import Path

import torch
from torch import nn

UPSTREAM = "https://github.com/open-mmlab/mmaction2"
UPSTREAM_COMMIT = "4d6c93474730cad2f25e51109adcf96824efc7a3"  # v1.2.0
CODE_DIR = Path.home() / ".cache" / "hyd-models" / f"mmaction2-{UPSTREAM_COMMIT[:12]}"
BONE_URL = (
    "https://download.openmmlab.com/mmaction/v1.0/skeleton/stgcnpp/"
    "stgcnpp_8xb16-bone-u100-80e_ntu60-xsub-keypoint-2d/"
    "stgcnpp_8xb16-bone-u100-80e_ntu60-xsub-keypoint-2d_20221228-cd11a691.pth"
)
BONE_SHA256 = "cd11a691afd2446a6285a527cc501af0dc78e5e367b206ac35961e2d6dd95a8c"
TIMEOUT_S = 600
CLIP_LEN, JOINTS, PERSONS, CLASSES = 100, 17, 2, 60
# JointToBone(dataset="coco")：各关节的父节点，头与髋连到鼻尖
PARENTS = (0, 0, 0, 1, 2, 0, 0, 5, 6, 7, 8, 0, 0, 11, 12, 13, 14)


def fetch_code() -> Path:
    """先拉到临时目录，完整检出后再改名：中途失败不留下残缺的缓存，重跑即可恢复。"""
    if not CODE_DIR.is_dir():
        partial = CODE_DIR.with_name(CODE_DIR.name + ".partial")
        shutil.rmtree(partial, ignore_errors=True)
        partial.mkdir(parents=True)
        for args in (
            ["init", "-q"],
            ["fetch", "-q", "--depth", "1", UPSTREAM, UPSTREAM_COMMIT],
            ["checkout", "-q", "FETCH_HEAD"],
        ):
            subprocess.run(["git", "-C", str(partial), *args], check=True, timeout=TIMEOUT_S)
        partial.rename(CODE_DIR)
    head = subprocess.run(
        ["git", "-C", str(CODE_DIR), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
    ).stdout.strip()
    if head != UPSTREAM_COMMIT:
        sys.exit(f"上游代码提交 {head} 与 {UPSTREAM_COMMIT} 不符")
    return CODE_DIR / "mmaction"


def _module(name: str, **attrs: object) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    return module


def stgcn_class() -> type[nn.Module]:
    """按原文件加载 STGCN 主干：包的 __init__ 会导入整个 mmaction 与 mmcv，以空包与最小替身代替。"""
    root = fetch_code()

    class BaseModule(nn.Module):
        def __init__(self, init_cfg: object = None) -> None:
            super().__init__()

    def activation(cfg: dict) -> nn.Module:
        assert cfg["type"] == "ReLU", cfg
        return nn.ReLU()

    def norm(cfg: dict, features: int) -> tuple[str, nn.Module]:
        assert cfg["type"] == "BN", cfg
        return "bn", nn.BatchNorm2d(features)

    registry = types.SimpleNamespace(register_module=lambda *a, **k: lambda cls: cls)
    sys.modules |= {
        "mmcv": _module("mmcv"),
        "mmcv.cnn": _module("mmcv.cnn", build_activation_layer=activation, build_norm_layer=norm),
        "mmengine": _module("mmengine"),
        "mmengine.model": _module(
            "mmengine.model",
            BaseModule=BaseModule,
            ModuleList=nn.ModuleList,
            Sequential=nn.Sequential,
        ),
        "mmaction.registry": _module("mmaction.registry", MODELS=registry),
    }
    for name, path in [
        ("mmaction", root),
        ("mmaction.models", root / "models"),
        ("mmaction.models.backbones", root / "models/backbones"),
        ("mmaction.models.utils", root / "models/utils"),
    ]:
        package = types.ModuleType(name)
        package.__path__ = [str(path)]
        sys.modules[name] = package
    import importlib

    utils = sys.modules["mmaction.models.utils"]
    for part in ("graph", "gcn_utils"):
        module = importlib.import_module(f"mmaction.models.utils.{part}")
        utils.__dict__.update({k: v for k, v in vars(module).items() if not k.startswith("_")})
    return importlib.import_module("mmaction.models.backbones.stgcn").STGCN


class Stream(nn.Module):
    """一路：STGCN++ 主干 + GCNHead（时空全局平均、两人平均、全连接），输出 softmax 概率。"""

    def __init__(self, stgcn: type[nn.Module], weights: Path) -> None:
        super().__init__()
        self.backbone = stgcn(
            graph_cfg={"layout": "coco", "mode": "spatial"},
            gcn_adaptive="init",
            gcn_with_res=True,
            tcn_type="mstcn",
        )
        self.fc = nn.Linear(256, CLASSES)
        state = torch.load(weights, map_location="cpu", weights_only=False)["state_dict"]
        prefix = "backbone."
        self.backbone.load_state_dict(
            {k[len(prefix) :]: v for k, v in state.items() if k.startswith(prefix)}, strict=True
        )
        self.fc.load_state_dict(
            {"weight": state["cls_head.fc.weight"], "bias": state["cls_head.fc.bias"]}
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        features = self.backbone(x).mean(dim=(3, 4)).mean(dim=1)  # (N, M, C, T, V) → (N, C)
        return torch.softmax(self.fc(features), dim=-1)


class TwoStream(nn.Module):
    def __init__(self, joint: Path, bone: Path) -> None:
        super().__init__()
        stgcn = stgcn_class()
        self.joint, self.bone = Stream(stgcn, joint), Stream(stgcn, bone)
        self.register_buffer("parents", torch.tensor(PARENTS))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        parent = x[..., self.parents, :]
        bone = torch.cat([x[..., :2] - parent[..., :2], (x[..., 2:] + parent[..., 2:]) / 2], -1)
        return (self.joint(x) + self.bone(bone)) / 2


def fetch_bone(directory: Path) -> Path:
    with urllib.request.urlopen(BONE_URL, timeout=TIMEOUT_S) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != BONE_SHA256:
        sys.exit("bone 权重哈希不符，拒绝使用")
    path = directory / "bone.pth"
    path.write_bytes(data)
    return path


def main(joint: Path, output: Path) -> None:
    model = TwoStream(joint, fetch_bone(output.parent)).eval()
    with torch.no_grad():
        torch.onnx.export(
            model,
            (torch.zeros(1, PERSONS, CLIP_LEN, JOINTS, 3),),
            str(output),
            input_names=["keypoints"],
            output_names=["probs"],
            dynamic_axes={"keypoints": {0: "n"}, "probs": {0: "n"}},
            opset_version=17,
            dynamo=False,
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
