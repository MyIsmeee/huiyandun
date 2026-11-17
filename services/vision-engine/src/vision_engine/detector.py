"""检测（REUSE-05、REUSE-22）：RF-DETR 检出车辆与人员框，rtmlib RTMO 单阶段输出人体框与 COCO 17 关键点；
人员取两者的并集，同一人以 RF-DETR 的框为准、RTMO 提供骨骼（#287）。

配置了 RTMPose 时为两阶段：按每个人员框从原画面裁剪、放大到 192×256 重新估计骨骼，取代 RTMO 的整帧结果。
RTMO 把整帧缩到 640 宽，画面中 150～300 像素高的人只剩 50～100 像素；逐人裁剪后头、髋、膝、踝的可见比例明显
提高（cam-05 实测 103 人次：踝 26%～51% → 63%，髋约 70% → 82%）。逐人模型会把桌后被挡的腿"猜"出来：膝、踝
置信度低于 LOWER_BODY_MIN 的视为不可见。横躺者（框宽大于高）保留 RTMO 正向与旋转推理中骨骼更清楚的一方。"""

import contextlib
import io

import cv2
import numpy as np
import onnxruntime as ort
import supervision as sv
from rtmlib import RFDETR, RTMO, RTMPose
from rtmlib.tools.object_detection.post_processings import multiclass_nms

NMS_IOU = 0.45
MIN_SCORE = 0.3  # 低分框交给 ByteTrack 第二阶段关联，不直接建立轨迹
# 横躺在画面中的人（如倒地者）正向推理常得不到骨骼；另以左右各旋转 90° 的画面推理，使其在旋转后直立
# （TK-022）。旋转方向的检出多为把旁人或杂物框住的松散框（#286 实测 92% 没有对应的人）：只在有横躺且没配上
# 骨骼的 RF-DETR 人员时推理，结果只给这些人补骨骼，不新增人员
ROTATIONS = (cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_90_CLOCKWISE)
MATCH_IOU = 0.3  # RTMO 的框比 RF-DETR 的松：IoU 达此值即视为同一人
# RTMO 独有的框把某个 RF-DETR 人员覆盖达此比例时，是把旁人一并框住的松散框，不输出
CONTAINED = 0.8

LOWER_BODY = [13, 14, 15, 16]  # 左右膝、左右踝
LOWER_BODY_MIN = 0.4  # 逐人模型膝、踝置信度低于此值视为不可见：多是被桌椅挡住后"猜"出的位置

type Candidates = tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]


class TopDownPose:
    """RTMPose 逐人骨骼：输入画面与人员框（画面坐标 xyxy），输出关键点 (N, 17, 2) 与置信度 (N, 17)。"""

    def __init__(self, model_file: str, session: ort.InferenceSession) -> None:
        # 同 PoseDetector：rtmlib 构造时自建会话，先以 CPU 构造，再换成 runtime.create_session 的会话
        with contextlib.redirect_stdout(io.StringIO()):
            self._model = RTMPose(
                model_file, model_input_size=(192, 256), backend="onnxruntime", device="cpu"
            )
        self._model.session = session

    def __call__(self, image: np.ndarray, boxes: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if len(boxes) == 0:
            return np.zeros((0, 17, 2)), np.zeros((0, 17))
        points, scores = self._model(image, boxes.tolist())
        scores = scores.astype(float).copy()
        lower = scores[:, LOWER_BODY]
        scores[:, LOWER_BODY] = np.where(lower >= LOWER_BODY_MIN, lower, 0.0)
        return points.astype(float), scores


def refine(
    topdown: TopDownPose,
    image: np.ndarray,
    boxes: np.ndarray,
    points: np.ndarray,
    scores: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """两阶段：各人员框（image 中的坐标）的骨骼换成逐人模型的结果；横躺者（框宽大于高）保留骨骼更清楚的一方。"""
    if len(boxes) == 0:
        return points, scores
    top_points, top_scores = topdown(image, boxes)
    lying = (boxes[:, 2] - boxes[:, 0]) > (boxes[:, 3] - boxes[:, 1])
    keep = lying & (scores.mean(axis=1) > top_scores.mean(axis=1))
    return np.where(keep[:, None, None], points, top_points), np.where(
        keep[:, None], scores, top_scores
    )


def _unrotate(points: np.ndarray, rotation: int, width: int, height: int) -> np.ndarray:
    """旋转后画面中的坐标 [..., 2] 换算回旋转前的画面（宽 width、高 height）。"""
    u, v = points[..., 0], points[..., 1]
    if rotation == cv2.ROTATE_90_COUNTERCLOCKWISE:
        return np.stack([width - 1 - v, u], axis=-1)
    return np.stack([v, height - 1 - u], axis=-1)


class PoseDetector:
    topdown: TopDownPose | None = None  # 配置了 RTMPose 时为两阶段（模块说明）

    def __init__(self, model_file: str, session: ort.InferenceSession) -> None:
        # rtmlib 构造时自建会话且不支持显存上限：先以 CPU 构造，再换成 runtime.create_session
        # 的会话（C-HW-12、C-CV-11）。构造时向 stdout 打印的加载信息不进入结构化日志
        with contextlib.redirect_stdout(io.StringIO()):
            self._model = RTMO(model_file, backend="onnxruntime", device="cpu")
        self._model.session = session

    def _infer(self, image: np.ndarray) -> Candidates:
        """单次推理的候选：框 (N, 4)、置信度 (N,)、关键点 (N, 17, 2)、关键点置信度 (N, 17)。"""
        padded, ratio = self._model.preprocess(image)
        dets, poses = self._model.inference(padded)
        return dets[0, :, :4] / ratio, dets[0, :, 4], poses[0, :, :, :2] / ratio, poses[0, :, :, 2]

    def __call__(
        self,
        image: np.ndarray,
        offset: tuple[int, int] = (0, 0),
        persons: sv.Detections | None = None,
    ) -> sv.Detections:
        """检测 image（可为整帧的裁剪区域）；offset 为裁剪区域左上角，结果换算回整帧坐标。

        persons 为 RF-DETR 在同一区域检出的人员（整帧坐标），与 RTMO 的正向检出取并集：同一人用 RF-DETR 的
        框与置信度、RTMO 的骨骼；RF-DETR 独有的人关键点置信度为 0；RTMO 独有的框保留，松散框除外。
        None（未配置 RF-DETR）时只有 RTMO 的正向检出。"""
        dx, dy = offset
        boxes, scores, points, point_scores = self._infer(image)
        boxes, points = boxes + (dx, dy, dx, dy), points + (dx, dy)
        _, keep = multiclass_nms(boxes, scores[:, None], nms_thr=NMS_IOU, score_thr=MIN_SCORE)
        own = np.array([] if keep is None else keep, dtype=int)
        if persons is None or len(persons) == 0:
            return self._refined(
                image, offset, boxes[own], scores[own], points[own], point_scores[own]
            )
        found = persons.xyxy
        keypoints, keypoint_scores = np.zeros((len(found), 17, 2)), np.zeros((len(found), 17))
        # 先在 NMS 保留的候选（≥ MIN_SCORE）中配对；没配上的人再用其余候选：RF-DETR 已确认是人，
        # RTMO 对横躺者的置信度常偏低。同一人身上重合度略高的低分框不得抢走高分框的骨骼
        pairs = {i: int(own[j]) for i, j in _match(found, boxes[own]).items()}
        confident = set(pairs)
        rest = np.setdiff1d(np.arange(len(boxes)), own)
        left = [i for i in range(len(found)) if i not in pairs]
        pairs |= {left[k]: int(rest[j]) for k, j in _match(found[left], boxes[rest]).items()}
        for i, j in pairs.items():
            keypoints[i], keypoint_scores[i] = points[j], point_scores[j]
        # 只配上低分候选的横躺者同样做旋转推理：正向的低分骨骼质量差（TK-022）
        lying = [
            i
            for i, (x1, y1, x2, y2) in enumerate(found)
            if i not in confident and x2 - x1 > y2 - y1
        ]
        if lying:
            height, width = image.shape[:2]
            for rotation in ROTATIONS:
                turned, _, turned_points, turned_scores = self._infer(cv2.rotate(image, rotation))
                corners = _unrotate(turned.reshape(-1, 2, 2), rotation, width, height)
                turned = np.concatenate([corners.min(axis=1), corners.max(axis=1)], axis=1)
                turned_points = _unrotate(turned_points, rotation, width, height)
                for k, j in _match(found[lying], turned + (dx, dy, dx, dy)).items():
                    i = lying[k]
                    # 两个方向取骨骼更清楚的
                    if turned_scores[j].mean() > keypoint_scores[i].mean():
                        keypoints[i] = turned_points[j] + (dx, dy)
                        keypoint_scores[i] = turned_scores[j]
        extra = own[~np.isin(own, list(pairs.values()))]
        extra = extra[_alone(boxes[extra], found)]
        return self._refined(
            image,
            offset,
            np.concatenate([found, boxes[extra]]),
            np.concatenate([persons.confidence, scores[extra]]),
            np.concatenate([keypoints, points[extra]]),
            np.concatenate([keypoint_scores, point_scores[extra]]),
        )

    def _refined(
        self,
        image: np.ndarray,
        offset: tuple[int, int],
        boxes: np.ndarray,
        scores: np.ndarray,
        points: np.ndarray,
        point_scores: np.ndarray,
    ) -> sv.Detections:
        """配置了逐人模型时按人员框重新估计骨骼；boxes、points 为整帧坐标，image 为 offset 处的裁剪区域。"""
        if self.topdown is not None and len(boxes):
            dx, dy = offset
            local, local_points = boxes - (dx, dy, dx, dy), points - (dx, dy)
            local_points, point_scores = refine(
                self.topdown, image, local, local_points, point_scores
            )
            points = local_points + (dx, dy)
        return _people(boxes, scores, points, point_scores)


YOLO_INPUT = 640  # tools/dev/export_yolo_pose.py 导出时的输入边长
YOLO_PAD = 114  # ultralytics 训练与推理时补边的灰度
YOLO_FLOOR = 0.05  # 免 NMS 输出头固定给 300 行，绝大多数是置信度近 0 的空行：低于此值不作候选


class YoloPoseDetector(PoseDetector):
    """试用：Ultralytics YOLO26-pose 代替 RTMO 提供人体框与骨骼，与 RF-DETR 的合并、横躺者的旋转推理
    沿用 PoseDetector。输出 (1, 300, 57)：框 xyxy、置信度、类别、17 × (x, y, 置信度)，均为输入画面坐标。

    AGPL-3.0，未列入 models/registry.yaml；正式采用前须先确认许可证。"""

    def __init__(self, session: ort.InferenceSession) -> None:
        self._session = session
        self._input = session.get_inputs()[0].name

    def _infer(self, image: np.ndarray) -> Candidates:
        height, width = image.shape[:2]
        ratio = YOLO_INPUT / max(height, width)
        w, h = round(width * ratio), round(height * ratio)
        left, top = (YOLO_INPUT - w) // 2, (YOLO_INPUT - h) // 2
        canvas = np.full((YOLO_INPUT, YOLO_INPUT, 3), YOLO_PAD, np.uint8)
        canvas[top : top + h, left : left + w] = cv2.resize(image, (w, h))
        blob = canvas[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255  # BGR → RGB
        rows = self._session.run(None, {self._input: blob})[0][0]
        rows = rows[rows[:, 4] >= YOLO_FLOOR]
        points = rows[:, 6:].reshape(-1, 17, 3)
        return (
            (rows[:, :4] - (left, top, left, top)) / ratio,
            rows[:, 4],
            (points[:, :, :2] - (left, top)) / ratio,
            points[:, :, 2],
        )


def pose_detector(model_file: str, session: ort.InferenceSession) -> PoseDetector:
    """按模型的输出个数选择骨骼模型：RTMO 有框与关键点两个输出，YOLO-pose 只有一个。"""
    if len(session.get_outputs()) == 1:
        return YoloPoseDetector(session)
    return PoseDetector(model_file, session)


def _people(
    boxes: np.ndarray, scores: np.ndarray, points: np.ndarray, point_scores: np.ndarray
) -> sv.Detections:
    if len(boxes) == 0:
        return sv.Detections.empty()
    return sv.Detections(
        xyxy=boxes,
        confidence=scores,
        data={"keypoints": points, "keypoint_scores": point_scores},
    )


def _match(persons: np.ndarray, boxes: np.ndarray) -> dict[int, int]:
    """按 IoU 从高到低一对一配对（≥ MATCH_IOU）：persons 的下标 → boxes 的下标。"""
    iou = sv.box_iou_batch(persons, boxes)
    pairs: dict[int, int] = {}
    for flat in np.argsort(-iou, axis=None):
        i, j = divmod(int(flat), iou.shape[1])
        if iou[i, j] < MATCH_IOU:
            break
        if i not in pairs and j not in pairs.values():
            pairs[i] = j
    return pairs


def _alone(boxes: np.ndarray, persons: np.ndarray) -> np.ndarray:
    """boxes 中不与任何人员重合（IoU < MATCH_IOU）、也没有把某个人员框住（覆盖 < CONTAINED）的框。"""
    lo = np.maximum(boxes[:, None, :2], persons[None, :, :2])
    hi = np.minimum(boxes[:, None, 2:], persons[None, :, 2:])
    inter = np.prod(np.clip(hi - lo, 0, None), axis=2)
    areas = np.prod(persons[:, 2:] - persons[:, :2], axis=1)
    same = sv.box_iou_batch(boxes, persons).max(axis=1) >= MATCH_IOU
    return ~same & ((inter / areas).max(axis=1) < CONTAINED)


# RF-DETR（REUSE-22）的 COCO 类别号 → 契约 object_class
VEHICLES = {1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
PERSON = 0  # 人员框交给 PoseDetector 与 RTMO 合并（#287）
VEHICLE_MIN_SCORE = 0.3  # 与 MIN_SCORE 相同：低分框只用于 ByteTrack 第二阶段关联
VEHICLE_INPUT = (512, 512)  # RF-DETR-S 导出时的输入尺寸


class VehicleDetector:
    """车辆与人员框检测：rtmlib RFDETR 负责推理；后处理自行完成，以保留 ByteTrack 需要的置信度
    （rtmlib 的多类别模式不返回置信度）。DETR 每个查询只出一个框，不需要 NMS。

    前处理与 rtmlib 的算式相同（缩放到输入尺寸后 (v / 255 − mean) / std），改为查表：缩放后的画面是 8 位，
    每个通道只有 256 种取值，按同样的 float32 算式先算好，结果逐位相同；rtmlib 逐像素做三遍浮点运算，
    1080p 实测约 3 ms，查表约 0.5 ms。"""

    def __init__(self, model_file: str, session: ort.InferenceSession) -> None:
        with contextlib.redirect_stdout(io.StringIO()):
            self._model = RFDETR(model_file, model_input_size=VEHICLE_INPUT, device="cpu")
        self._model.session = session
        levels = np.arange(256, dtype=np.float32)[:, None]
        self._lut = (((levels / 255.0) - self._model.mean) / self._model.std).reshape(256, 1, 3)

    def __call__(
        self, image: np.ndarray, offset: tuple[int, int] = (0, 0)
    ) -> tuple[sv.Detections, sv.Detections]:
        """检测 image（可为整帧的裁剪区域），返回（车辆, 人员）；offset 为裁剪区域左上角，结果换算回整帧坐标。"""
        resized = cv2.LUT(cv2.resize(image, VEHICLE_INPUT[::-1]), self._lut)
        # 与 rtmlib 给出的原图尺寸同为 float32：框的换算逐位不变
        height, width = (np.float32(side) for side in image.shape[:2])
        boxes, logits = self._model.inference(resized)
        # 第 0 类为背景；每个查询取前景中概率最高的类别
        probs = 1 / (1 + np.exp(-logits[0, :, 1:]))
        class_ids, scores = probs.argmax(axis=1), probs.max(axis=1)
        cx, cy, w, h = boxes[0].T
        dx, dy = offset
        xyxy = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)
        xyxy = xyxy * (width, height, width, height) + (dx, dy, dx, dy)

        def pick(keep: np.ndarray) -> sv.Detections:
            if not keep.any():
                return sv.Detections.empty()
            return sv.Detections(xyxy=xyxy[keep], confidence=scores[keep], class_id=class_ids[keep])

        return (
            pick(np.isin(class_ids, list(VEHICLES)) & (scores >= VEHICLE_MIN_SCORE)),
            pick((class_ids == PERSON) & (scores >= MIN_SCORE)),
        )
