"""实景底图（backdrop.py）：网格三维位置、深度突变处断开、画面去除人员。"""

import base64

import cv2
import numpy as np
from test_scene3d import POSE, build

from vision_engine.backdrop import (
    COLS,
    EDGE_MIN_M,
    EDGE_RATIO,
    MAX_HEIGHT_M,
    MIN_HEIGHT_M,
    backdrop,
)


def frame_of(height: int = 360, width: int = 640) -> np.ndarray:
    """灰底画面，中央一块红色"人员"。"""
    frame = np.full((height, width, 3), 128, np.uint8)
    frame[150:250, 280:360] = (0, 0, 255)
    return frame


def decoded(out: dict) -> tuple[np.ndarray, np.ndarray]:
    points = np.array(out["points"]).reshape(out["rows"], out["cols"], 3)
    bits = np.unpackbits(np.frombuffer(base64.b64decode(out["quads"]), np.uint8))
    keep = bits[: (out["rows"] - 1) * (out["cols"] - 1)].reshape(out["rows"] - 1, out["cols"] - 1)
    return points, keep.astype(bool)


def test_grid_points_in_plane_coordinates_with_discontinuities_cut() -> None:
    _, rec = build()
    out = backdrop(rec, POSE, frame_of())
    assert out is not None
    height, width = rec.valid.shape
    assert (out["cols"], out["rows"]) == (COLS, round(COLS * height / width))
    points, keep = decoded(out)
    assert keep.any() and not keep.all()  # 桌面与其后地面之间的深度突变处断开
    corners = [points[:-1, :-1], points[:-1, 1:], points[1:, 1:], points[1:, :-1]]
    longest = np.max(
        [np.linalg.norm(corners[k] - corners[(k + 1) % 4], axis=-1) for k in range(4)], axis=0
    )
    reach = np.linalg.norm(points[:-1, :-1][..., [0, 2]], axis=-1)  # 镜头在平面原点（POSE）
    assert np.all(longest[keep] <= np.maximum(EDGE_MIN_M, EDGE_RATIO * reach[keep]) + 0.05)
    heights = np.concatenate([c[..., 1][keep] for c in corners])
    assert heights.min() >= MIN_HEIGHT_M and heights.max() <= MAX_HEIGHT_M
    # 地面点离地约为 0，桌面点约为 0.75
    assert np.isclose(np.percentile(heights, 10), 0, atol=0.05)


def test_unused_points_are_zero() -> None:
    _, rec = build()
    out = backdrop(rec, POSE, frame_of())
    assert out is not None
    points, keep = decoded(out)
    used = np.zeros(points.shape[:2], bool)
    for di, dj in ((0, 0), (0, 1), (1, 0), (1, 1)):
        used[di : di + keep.shape[0], dj : dj + keep.shape[1]] |= keep
    assert np.all(points[~used] == 0)


def test_people_removed_from_image_by_boxes_and_segmentation() -> None:
    _, rec = build()
    frame = frame_of()
    boxes = np.zeros(frame.shape[:2], bool)
    boxes[150:250, 280:360] = True
    for exclude, ade in ((boxes, None), (None, np.where(boxes[::4, ::4], 12, 0).astype(np.uint8))):
        out = backdrop(rec, POSE, frame, exclude, ade)
        assert out is not None
        jpeg = cv2.imdecode(
            np.frombuffer(base64.b64decode(out["image"]), np.uint8), cv2.IMREAD_COLOR
        )
        assert jpeg.shape[:2] == frame.shape[:2]  # 不足 IMAGE_WIDTH 时不放大
        red = jpeg[160:240, 290:350].astype(int)
        assert np.abs(red - 128).max() < 40  # 红色人员已按灰色周边修补


def test_people_kept_without_mask_and_no_mesh_returns_none() -> None:
    _, rec = build()
    out = backdrop(rec, POSE, frame_of())
    assert out is not None
    jpeg = cv2.imdecode(np.frombuffer(base64.b64decode(out["image"]), np.uint8), cv2.IMREAD_COLOR)
    assert jpeg[200, 320, 2] > 200  # 没有掩码时不修补
    empty = type(rec)(rec.cloud, rec.normals, np.zeros_like(rec.valid), rec.floor)
    assert backdrop(empty, POSE, frame_of()) is None
