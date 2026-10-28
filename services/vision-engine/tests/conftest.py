"""onnxruntime 默认在 import 时向微软发送遥测；测试模块导入它之前关闭（G-05，镜像内由 Dockerfile 设置）。"""

import os

os.environ["ORT_DISABLE_TELEMETRY"] = "1"
