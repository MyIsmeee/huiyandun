# 自制场景模型

场景页模型库中团队自制的模型（如用 Blender 制作）。本目录是源文件，随代码提交，不经前端发布；前端加载的是脚本合并出的 `web/console/public/models/scene-custom.glb` 与资产目录 `catalog.json`。

只放团队自制的模型。第三方模型（含 CC0）须挑选进 `tools/dev/assets.py` 的 `SELECTION` 并登记 `deploy/third-party.yaml`（C-RU-01）。

## 添加一个模型

1. 在 Blender 中建模并导出（要求见下），文件放到本目录，如 `gate-barrier.glb`
2. 在 `models.yaml` 的 `models` 中登记一项（字段见该文件的示例）
3. 重建自制模型（只需本目录，不需要 Kenney 压缩包）：

   ```sh
   uv run python tools/dev/assets.py --custom
   ```

4. 运行 `uv run pytest tests/test_assets.py tools/dev/tests/test_scene_assets.py`，在场景页模型库中检查外观与占地，提交本目录的改动与 `public/models/` 下更新的 `scene-custom.glb`、`catalog.json`

## Blender 导出要求

| 要求 | 原因 |
|---|---|
| 文件 → 导出 → glTF 2.0，格式 glTF Binary（`.glb`），勾选 +Y Up（默认） | 前端以 three.js GLTFLoader 加载 |
| 按米建模（场景单位 Metric，单位比例 1.0），`scale` 填 1 | 占地格数按 1 m 网格换算 |
| 线状资产（墙、围栏）长边沿 Blender 的 X 轴；否则用 `yaw` 转到 X | 线状资产按长度沿 x 向铺设 |
| 放进场景页后朝向不对时，改 `yaw`（0 / 90 / 180 / 270）后重建 | 放置时的旋转在 `yaw` 之后叠加 |
| 只导出这一个模型（勾选"仅选中物体"），应用全部变换（Ctrl+A） | 每个文件一个模型，归中按包围盒计算 |
| 材质用 Principled BSDF 的基础色或一张调色板贴图，不用自发光、透明、法线贴图 | 场景只用实体材质与固定光照（D-111）；颜色由脚本按色板重新上色，只保留明暗 |
| 低面数，单个模型建议 ≤ 5 000 三角面、≤ 200 KB | 资产库随代码提交，`public/models/` 总量 ≤ 8 MB（设计 150 §8） |

原点位置、节点与网格的名称不必处理：脚本会把模型归中到底面中心，并把场景名改为资产编号、去掉节点与网格名（three.js 加载时重名会被加后缀，按编号就找不到了）。

## 颜色

脚本按 `palette` 把原色的明度映射到色板两端（设计 150 §4 场景材质色），去掉色相：建模时用深浅区分部件即可，不同颜色的鲜艳程度不会保留。

| palette | 用于 |
|---|---|
| `building` | 建筑：屋顶 → 白墙 |
| `furniture` | 家具、设备：浅灰 |
| `tree` | 树木、花坛 |
| `road` / `grass` / `plaza` | 路面、草地、广场（`grass`、`plaza` 为单色） |
