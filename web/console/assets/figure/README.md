# 人形零件

三维场景中人员的外形：躯干、颈、上臂、前臂（含手）、大腿、小腿、脚、头八个零件，在 Blender 中制作，导出为 `web/console/public/models/figure-parts.glb`。前端把零件逐段摆到重建出的关节上（`src/scene/parts.ts`），不带骨骼与动画，姿态完全来自关键点。

## 重建

```sh
blender --background --python tools/dev/figure_parts.py
```

脚本按 1.70 m 标准体型生成全部零件并导出。之后运行 `uv run pytest tests/test_assets.py` 与 `pnpm --dir web/console exec vitest run`，在控制台里检查外观，提交脚本与 `figure-parts.glb`。

## 手工细修

想在 Blender 里直接调外形时，先另存一份工程，改完后自己导出：

```sh
blender --background --python tools/dev/figure_parts.py -- --blend web/console/assets/figure/figure-parts.blend
```

导出用 文件 → 导出 → glTF 2.0：格式 glTF Binary，勾选 +Y Up 与"应用修改器"，不导出材质、UV、动画。此后以 `.blend` 为准，不要再运行脚本（会覆盖导出的 glb）；`.blend` 一并提交到本目录。

## 零件约定

| 约定 | 原因 |
|---|---|
| 每个零件一个物体，物体名为 `torso` `neck` `upper_arm` `forearm` `thigh` `shin` `foot` `head` | 前端按物体名取零件，缺一个即报错 |
| 按米建模，应用全部变换（Ctrl+A） | 零件原样使用，不做归中与缩放 |
| 原点在近端关节，沿 Blender +Z 伸向远端关节，两关节相距标准骨长（见下表） | 前端把原点放到关节上、+Z 对准骨段；实际骨长不同时只沿骨段拉伸 |
| 躯干原点在髋中、向上到肩中；头的原点在头部中心 | 躯干骨段为髋中—肩中；头摆在头部关键点处，沿颈部方向 |
| Blender 的 X 为人体左右；躯干与四肢左右、前后都对称 | 同一零件左右两侧共用；看不出正反面时也不会画错 |
| 脚的原点在脚踝正下方的脚底，+Z 指向脚尖，−Y 为脚背一侧 | 脚底贴地；脚尖方向由身体朝向推算 |
| 零件两端做成圆头并包住关节 | 相邻零件在弯折处靠圆头衔接，不留缝 |
| 中性人偶：没有面部、头发、服饰，所有人同一体型；不带材质与贴图 | G-04 不呈现个人特征；颜色由前端按状态给出（正常、告警、选中），推测的部位半透明 |
| 全部零件合计建议 ≤ 8 000 三角面 | 每种零件一个图层，200 人同屏 |

标准骨长（米），须与 `src/scene/parts.ts` 的 `PARTS` 一致：

| 零件 | 近端 → 远端 | 骨长 |
|---|---|---|
| `torso` | 髋中 → 肩中 | 0.50 |
| `neck` | 肩中 → 头部中心 | 0.22 |
| `upper_arm` | 肩 → 肘 | 0.30 |
| `forearm` | 肘 → 腕（手在腕之外） | 0.26 |
| `thigh` | 髋 → 膝 | 0.42 |
| `shin` | 膝 → 踝 | 0.42 |
| `foot` | 踝 → 脚尖 | 0.19 |

肩关节在肩中两侧 0.19 m、髋关节在髋中两侧 0.10 m 处；双肩、双髋的连线仍由前端画成圆棒，肩宽与标准不同时用来衔接手臂与躯干。
