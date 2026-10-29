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
"""EfficientViT-Seg L1 ADE20K：上游 PyTorch 权重 → ONNX（REUSE-25，构建期）。

用法：uv run --script --locked tools/dev/export_efficientvit_seg.py <权重.pt> <输出.onnx>
由 make fetch-models 在核对权重哈希后调用。依赖由同名 .lock 锁定，只装进 uv 的临时环境，不进入
工作区锁文件与运行镜像；上游代码固定到 UPSTREAM_COMMIT（git 提交号即内容校验）。
"""

import subprocess
import sys
import types
from pathlib import Path

import torch

UPSTREAM = "https://github.com/mit-han-lab/efficientvit"
UPSTREAM_COMMIT = "de7d7733cc0329f391b33f1f459271562ec27bd5"
CODE_DIR = Path.home() / ".cache" / "hyd-models" / f"efficientvit-{UPSTREAM_COMMIT[:12]}"
SIZE = 512  # 输入 1×3×512×512，输出 150 类 64×64 logits
TIMEOUT_S = 600  # 拉取上游代码的上限


def fetch_code() -> Path:
    if not (CODE_DIR / ".git").is_dir():
        CODE_DIR.mkdir(parents=True)
        for args in (
            ["init", "-q"],
            ["fetch", "-q", "--depth", "1", UPSTREAM, UPSTREAM_COMMIT],
            ["checkout", "-q", "FETCH_HEAD"],
        ):
            subprocess.run(["git", "-C", str(CODE_DIR), *args], check=True, timeout=TIMEOUT_S)
    head = subprocess.run(
        ["git", "-C", str(CODE_DIR), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
        timeout=TIMEOUT_S,
    ).stdout.strip()
    if head != UPSTREAM_COMMIT:
        sys.exit(f"上游代码提交 {head} 与 {UPSTREAM_COMMIT} 不符")
    return CODE_DIR / "efficientvit"


def load_model(weights: Path) -> torch.nn.Module:
    """只加载分割模型所需的子模块：上游包的 __init__ 会导入扩散、SAM 及训练依赖。"""
    root = fetch_code()
    for name, path in [
        ("efficientvit", root),
        ("efficientvit.models", root / "models"),
        ("efficientvit.models.efficientvit", root / "models/efficientvit"),
    ]:
        package = types.ModuleType(name)
        package.__path__ = [str(path)]
        sys.modules[name] = package
    # 以下只在训练或 GPU 归一化核中使用，推理导出不涉及：以空模块代替，只提供被导入的名字
    run_config = types.ModuleType("efficientvit.apps.trainer.run_config")
    run_config.Scheduler = type("Scheduler", (), {"PROGRESS": 0})
    triton = types.ModuleType("triton")
    triton.jit = lambda f: f
    triton.language = types.SimpleNamespace(constexpr=int)
    sys.modules |= {
        "efficientvit.apps.trainer.run_config": run_config,
        "triton": triton,
        "triton.language": triton.language,
    }

    from efficientvit.models.efficientvit.seg import efficientvit_seg_l1
    from efficientvit.models.nn.norm import set_norm_eps
    from efficientvit.models.utils import load_state_dict_from_file

    model = efficientvit_seg_l1(dataset="ade20k")
    set_norm_eps(model, 1e-7)  # 与上游评测脚本一致
    model.load_state_dict(load_state_dict_from_file(str(weights)))
    return model.eval()


def main(weights: Path, output: Path) -> None:
    model = load_model(weights)
    with torch.no_grad():
        torch.onnx.export(
            model,
            (torch.zeros(1, 3, SIZE, SIZE),),
            str(output),
            input_names=["input"],
            output_names=["logits"],
            opset_version=17,
            dynamo=False,
        )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(Path(sys.argv[1]), Path(sys.argv[2]))
