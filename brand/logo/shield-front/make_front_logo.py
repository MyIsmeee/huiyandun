"""慧眼盾 logo：把斜视角的盾牌原图摆成正视，并导出「有线 / 无线」两版。

不重绘、不换素材——所有像素都来自 source.png，只做几何矫正和去线：
  1. 量取外轮廓（左侧取"正面/侧壁"的棱线，把侧壁裁掉）与金边/玻璃分界线；
  2. 四点单应矫正透视，再用薄板样条把残余形变拉成左右对称的轮廓，
     同时把玻璃中脊钉在中轴、激光线钉成水平；
  3. 无线版：先在源图上去掉激光亮芯与红晕（玻璃按通道修复、金边沿走向插值），
     再走同一套矫正，保证两版轮廓逐像素一致。

用法:
    python3 make_front_logo.py [source.png] [输出目录]
    # 或 uv run --with numpy --with scipy --with pillow python make_front_logo.py

关键点坐标是按 source.png（1376x1754）量的，换图需要重新量。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
from scipy.interpolate import CubicSpline, RBFInterpolator
from scipy.signal import savgol_filter

# ======================= 1. 源图关键点 =======================
APEX_A, CORNER_AL, CORNER_AR, TIP_A = (800, 4), (68, 222), (1346, 322), (800, 1745)
APEX_B, CORNER_BL, CORNER_BR, TIP_B = (814, 103), (150, 299), (1298, 383), (801, 1646)
LASER_Y = 820
LASER_SKIP = (735, 905)

# 左侧"正面/侧壁"棱线（手工量取）
RIDGE_SIDE = [
    (65, 250),
    (60, 330),
    (52, 400),
    (45, 500),
    (42, 600),
    (47, 680),
    (56, 740),
    (73, 820),
    (86, 900),
    (97, 950),
    (121, 1000),
    (160, 1100),
    (215, 1200),
    (282, 1300),
    (355, 1400),
    (450, 1510),
    (600, 1628),
    (700, 1690),
]


def spline_through(pts, n=200):
    p = np.asarray(pts, float)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    cs = CubicSpline(d, p, bc_type="natural")
    return cs(np.linspace(0, d[-1], n))


def smooth(p, win=13):
    p = np.asarray(p, float)
    if len(p) < win + 2:
        return p
    q = p.copy()
    q[:, 0] = savgol_filter(p[:, 0], win, 2, mode="interp")
    q[:, 1] = savgol_filter(p[:, 1], win, 2, mode="interp")
    return q


def extract(rgba):
    a = rgba.astype(int)
    R, G, B, AL = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    M = AL > 128
    glass = (B > R + 12) & (B > G + 5) & (B > 45) & M

    def first_run(v, k=6, need=5):
        c = np.convolve(v.astype(int), np.ones(k, int), "valid")
        idx = np.nonzero(c >= need)[0]
        return int(idx[0]) if len(idx) else None

    def sil_top(x):
        return int(np.argmax(M[:, x]))

    def sil_left(y):
        return int(np.argmax(M[y]))

    def sil_right(y):
        return int(M.shape[1] - 1 - np.argmax(M[y, ::-1]))

    # ---- A：外轮廓 ----
    a_tl = [APEX_A] + [(x, sil_top(x) + 9) for x in range(780, 95, -15)] + [CORNER_AL]
    a_sl = spline_through([CORNER_AL] + RIDGE_SIDE + [TIP_A])
    a_tr = [APEX_A] + [(x, sil_top(x) + 3) for x in range(820, 1335, 15)] + [CORNER_AR]
    a_sr = [CORNER_AR] + [(sil_right(y) - 3, y) for y in range(345, 1735, 15)] + [TIP_A]

    # ---- B：金边/玻璃分界 ----
    b_tl = [APEX_B]
    for x in range(790, 175, -15):
        y0 = sil_top(x)
        i = first_run(glass[y0 : y0 + 260, x])
        if i is not None:
            b_tl.append((x, y0 + i))
    b_tl.append(CORNER_BL)
    b_tr = [APEX_B]
    for x in range(835, 1275, 15):
        y0 = sil_top(x)
        i = first_run(glass[y0 : y0 + 260, x])
        if i is not None:
            b_tr.append((x, y0 + i))
    b_tr.append(CORNER_BR)
    b_sl, b_sr = [CORNER_BL], [CORNER_BR]
    for y in range(325, 1650, 15):
        if LASER_SKIP[0] <= y <= LASER_SKIP[1]:
            continue
        x0 = sil_left(y)
        i = first_run(glass[y, x0 : x0 + 320])
        if i is not None:
            b_sl.append((x0 + i, y))
    for y in range(405, 1590, 15):
        if LASER_SKIP[0] <= y <= LASER_SKIP[1]:
            continue
        x1 = sil_right(y)
        i = first_run(glass[y, x1 - 320 : x1 + 1][::-1])
        if i is not None:
            b_sr.append((x1 - i, y))
    b_sl.append(TIP_B)
    b_sr.append(TIP_B)

    def fix(seg):
        seg = np.asarray(seg, float)
        s = smooth(seg[1:-1])
        return np.vstack([seg[:1], s, seg[-1:]])

    return {
        "A": {"tl": fix(a_tl), "sl": np.asarray(a_sl), "tr": fix(a_tr), "sr": fix(a_sr)},
        "B": {"tl": fix(b_tl), "sl": fix(b_sl), "tr": fix(b_tr), "sr": fix(b_sr)},
        "mask": M,
        "glass_px": glass,
    }


# ======================= 2. 去激光线（源图坐标） =======================

BAND = (630, 1030)  # 红晕影响的行范围
FEATHER = 30


def glass_mask(L, shape):
    B = L["B"]
    poly = np.vstack([B["tl"], B["sl"][1:], B["sr"][::-1][1:], B["tr"][::-1][1:-1]])
    m = Image.new("L", shape[1::-1], 0)
    ImageDraw.Draw(m).polygon([tuple(p) for p in poly], fill=255)
    return np.asarray(m) > 0


def fit_red_model(R, G, B, sel):
    """用未受红晕影响的玻璃像素拟合 R ≈ f(G, B)。"""
    g, b, r = G[sel] / 255.0, B[sel] / 255.0, R[sel] / 255.0
    X = np.stack([np.ones_like(g), g, b, g * g, g * b, b * b], axis=1)
    coef, *_ = np.linalg.lstsq(X, r, rcond=None)

    def pred(G_, B_):
        g, b = G_ / 255.0, B_ / 255.0
        return np.clip(
            (
                coef[0]
                + coef[1] * g
                + coef[2] * b
                + coef[3] * g * g
                + coef[4] * g * b
                + coef[5] * b * b
            )
            * 255.0,
            0,
            255,
        )

    return pred


def remove_laser(rgba, L, yline):
    a = rgba.astype(float)
    H, W = a.shape[:2]
    R, G, B = a[..., 0].copy(), a[..., 1].copy(), a[..., 2].copy()
    M = L["mask"]
    glass = glass_mask(L, a.shape)
    yy, xx = np.mgrid[0:H, 0:W]
    yl = yline(np.arange(W))  # 每列的激光线中心
    dy = yy - yl[None, :]

    # ---------- 玻璃 ----------
    clean = glass & ((yy < BAND[0] - 20) | (yy > BAND[1] + 20)) & (yy > 330) & (yy < 1450)
    pred = fit_red_model(R, G, B, clean)

    # 1) 亮芯：逐列找出发白的行范围，用上下两侧做竖向插值（B、G）
    core = (np.abs(dy) < 45) & (R > 150) & ((G > 28) | (B > 150))
    half = np.zeros(W)
    for x in range(W):
        rows = np.nonzero(core[:, x])[0]
        if len(rows):
            half[x] = np.abs(rows - yl[x]).max()
    half = ndi.maximum_filter1d(half, 15) + 5
    half = np.clip(ndi.gaussian_filter1d(half, 6), 12, 44)
    Gf, Bf = G.copy(), B.copy()
    for x in range(W):
        y0 = int(round(yl[x] - half[x]))
        y1 = int(round(yl[x] + half[x]))
        n = y1 - y0 + 1
        t = (np.arange(n) + 0.5) / n
        t = t * t * (3 - 2 * t)
        for C in (Gf, Bf):
            top = C[y0 - 4 : y0, x].mean()
            bot = C[y1 + 1 : y1 + 5, x].mean()
            C[y0 : y1 + 1, x] = top + (bot - top) * t
    # 插值带里补一点原有的竖向纹理感：横向保持逐列差异即可（上面已按列处理）

    # 2) 绿通道在线附近被压低：按 G/B 比例从带外线性补回
    def ratio_rows(C, rows):
        num = np.where(glass[rows], C[rows], 0).sum(0)
        den = np.where(glass[rows], Bf[rows], 0).sum(0) + 1e-6
        return ndi.gaussian_filter1d(num / den, 10)

    g_top = ratio_rows(Gf, slice(BAND[0] - 20, BAND[0]))
    g_bot = ratio_rows(Gf, slice(BAND[1], BAND[1] + 20))
    ty = np.clip((yy - BAND[0]) / float(BAND[1] - BAND[0]), 0, 1)
    g_floor = Bf * (g_top[None, :] * (1 - ty) + g_bot[None, :] * ty)
    wy = np.clip((yy - BAND[0]) / FEATHER, 0, 1) * np.clip((BAND[1] - yy) / FEATHER, 0, 1)
    wy = wy * wy * (3 - 2 * wy)
    Gn = np.where(glass, Gf + wy * np.clip(g_floor * 0.9 - Gf, 0, None), G)
    Bn = np.where(glass, Bf, B)

    # 3) 红通道：压回到由 G、B 推出的"无红晕"水平
    Rp = pred(Gn, Bn)
    Rn = np.where(glass, R - wy * np.clip(R - Rp, 0, None), R)
    out = a.copy()
    out[..., 0], out[..., 1], out[..., 2] = Rn, Gn, Bn

    # ---------- 金边 ----------
    frame = M & ~glass
    sl = L["B"]["sl"]
    sr = L["B"]["sr"]
    xb_l = np.interp(np.arange(H), sl[:, 1], sl[:, 0])
    xb_r = np.interp(np.arange(H), sr[:, 1], sr[:, 0])
    xs_l = np.array([np.argmax(M[y]) if M[y].any() else 0 for y in range(H)], float)
    xs_r = np.array([W - 1 - np.argmax(M[y, ::-1]) if M[y].any() else 0 for y in range(H)], float)
    xs_l = ndi.gaussian_filter1d(xs_l, 8)
    xs_r = ndi.gaussian_filter1d(xs_r, 8)
    xb_l = ndi.gaussian_filter1d(xb_l, 8)
    xb_r = ndi.gaussian_filter1d(xb_r, 8)
    y_a, y_b = 772, 890  # 线两侧的干净行
    src = out.copy()
    for side in ("l", "r"):
        if side == "l":
            e0, e1 = xs_l, xb_l + 8
        else:
            e0, e1 = xb_r - 8, xs_r
        for y in range(y_a + 1, y_b):
            x0, x1 = int(np.floor(e0[y])), int(np.ceil(e1[y]))
            xs = np.arange(x0, x1 + 1)
            u = (xs - e0[y]) / max(e1[y] - e0[y], 1e-6)
            t = (y - y_a) / float(y_b - y_a)
            w = np.clip(min(y - y_a, y_b - y) / 14.0, 0, 1)
            for c in range(3):
                va = np.interp(e0[y_a] + u * (e1[y_a] - e0[y_a]), np.arange(W), src[y_a, :, c])
                vb = np.interp(e0[y_b] + u * (e1[y_b] - e0[y_b]), np.arange(W), src[y_b, :, c])
                new = va * (1 - t) + vb * t
                keep = frame[y, x0 : x1 + 1]
                cur = out[y, x0 : x1 + 1, c]
                out[y, x0 : x1 + 1, c] = np.where(keep, cur * (1 - w) + new * w, cur)

    # 残余的红/粉色反光 → 改回金色（保持亮度）
    R2, G2, B2 = out[..., 0], out[..., 1], out[..., 2]
    lum = 0.30 * R2 + 0.59 * G2 + 0.11 * B2
    w_hue = np.maximum(
        np.clip((0.42 - G2 / (R2 + 1)) / 0.12, 0, 1) * np.clip((R2 - 95) / 50.0, 0, 1),
        np.clip((B2 - G2) / (0.15 * R2 + 8), 0, 1) * np.clip((R2 - B2) / 20.0, 0, 1),
    )
    w_rows = np.clip((yy - 600) / 40.0, 0, 1) * np.clip((1060 - yy) / 40.0, 0, 1)
    near = ndi.binary_dilation(frame, iterations=3) & M & ~ndi.binary_erosion(glass, iterations=6)
    w = np.where(near, w_hue * w_rows, 0)
    w = ndi.gaussian_filter(w, 1.2)
    gold = (
        np.stack([np.ones_like(lum), 0.66 * np.ones_like(lum), 0.28 * np.ones_like(lum)], -1)
        * (lum / 0.72 * 1.25)[..., None]
    )
    out[..., :3] = out[..., :3] * (1 - w[..., None]) + np.clip(gold, 0, 255) * w[..., None]
    out[..., 3] = a[..., 3]
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


# ======================= 3. 正视矫正 =======================

HT, WT, YC = 1740.0, 700.0, 278.0  # 目标：顶尖→底尖高度、半宽、肩角相对顶尖的下沉
PAD = 24
SMOOTH = 1.0
BEAD_APEX = (826, 79)  # 内圈金边的顶尖（源图）
CW, CH = int(2 * WT + 2 * PAD), int(HT + 2 * PAD)
OX, OY = CW / 2.0, float(PAD)


def homography(src, dst):
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst, strict=True):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    h = np.linalg.solve(np.array(A, float), np.array(b, float))
    return np.append(h, 1).reshape(3, 3)


def apply_h(Hm, p):
    p = np.asarray(p, float)
    q = np.c_[p, np.ones(len(p))] @ Hm.T
    return q[:, :2] / q[:, 2:3]


def resample(p, n):
    p = np.asarray(p, float)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    t = np.linspace(0, d[-1], n)
    return np.c_[np.interp(t, d, p[:, 0]), np.interp(t, d, p[:, 1])]


def fit_smooth(p, deg=5, n=240):
    """端点固定的低阶多项式拟合，去掉轮廓检测噪声。"""
    p = np.asarray(p, float)
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(p, axis=0).T))]
    s = d / d[-1]
    base = p[0] + np.outer(s, p[-1] - p[0])
    V = np.stack([s * (1 - s) * s**k for k in range(deg)], axis=1)
    coef, *_ = np.linalg.lstsq(V, p - base, rcond=None)
    t = np.linspace(0, 1, n)
    Vt = np.stack([t * (1 - t) * t**k for k in range(deg)], axis=1)
    return p[0] + np.outer(t, p[-1] - p[0]) + Vt @ coef


def split_at_line(seg, k, b):
    """在矫正平面里把侧边折线在激光线 y = kx + b 处切开。"""
    seg = np.asarray(seg, float)
    f = seg[:, 1] - (k * seg[:, 0] + b)
    i = int(np.nonzero((f[:-1] < 0) & (f[1:] >= 0))[0][0])
    t = -f[i] / (f[i + 1] - f[i])
    j = seg[i] + t * (seg[i + 1] - seg[i])
    return np.vstack([seg[: i + 1], j]), np.vstack([j, seg[i + 1 :]])


def laser_line(rgba):
    a = rgba.astype(float)
    xs = np.arange(300, 1200, 20)
    ys = []
    for x in xs:
        col = a[800:842, x, 1]
        w = np.clip(col - 100, 0, None)
        ys.append(800 + (w * np.arange(len(col))).sum() / max(w.sum(), 1e-6))
    k, b = np.polyfit(xs, ys, 1)
    return lambda x: k * np.asarray(x, float) + b


def build_warp(rgba):
    L = extract(rgba)
    yline = laser_line(rgba)
    Hm = homography([APEX_A, TIP_A, CORNER_AL, CORNER_AR], [(0, 0), (0, HT), (-WT, YC), (WT, YC)])
    N = {"t": 14, "u": 10, "d": 16}
    la = apply_h(Hm, np.c_[[200.0, 1200.0], yline([200.0, 1200.0])])
    lk = (la[1, 1] - la[0, 1]) / (la[1, 0] - la[0, 0])
    lb = la[0, 1] - lk * la[0, 0]
    src_pts, tgt_pts = [], []
    contours_t = {}
    junction_y = []
    parts = {}
    for key in ("A", "B"):
        segs = {
            n: fit_smooth(apply_h(Hm, v), deg=(4 if n[0] == "t" else 6)) for n, v in L[key].items()
        }
        lu, ld = split_at_line(segs["sl"], lk, lb)
        ru, rd = split_at_line(segs["sr"], lk, lb)
        parts[key] = {}
        for name, ls, rs in (("t", segs["tl"], segs["tr"]), ("u", lu, ru), ("d", ld, rd)):
            lr = resample(ls, N[name])
            rr = resample(rs, N[name])
            half = (np.c_[-lr[:, 0], lr[:, 1]] + rr) / 2.0  # 右半目标 = 左右平均（对称化）
            half[:, 0] = np.maximum(half[:, 0], 0)
            parts[key][name] = (lr, rr, half)
        junction_y.append(parts[key]["u"][2][-1, 1])
    y_line_t = float(np.mean(junction_y))
    for key in ("A", "B"):
        p = parts[key]
        # 让激光线两端落在同一水平线上：把接合点的偏差沿上下两段线性摊开
        dy = y_line_t - p["u"][2][-1, 1]
        p["u"][2][:, 1] += dy * np.linspace(0, 1, N["u"])
        p["d"][2][:, 1] += dy * np.linspace(1, 0, N["d"])
        p["t"][2][0, 0] = 0
        p["d"][2][-1, 0] = 0
        right = np.vstack([p["t"][2], p["u"][2][1:], p["d"][2][1:]])
        contours_t[key] = right
        for name in ("t", "u", "d"):
            lr, rr, half = p[name]
            sl = slice(0, None) if name == "t" else slice(1, None)
            src_pts += [lr[sl], rr[sl]]
            tgt_pts += [np.c_[-half[sl, 0], half[sl, 1]], half[sl]]

    # 中轴：玻璃中脊 → x = 0
    apexB_t, tipB_t = contours_t["B"][0], contours_t["B"][-1]
    ax_src = np.linspace(APEX_B, TIP_B, 14)[1:-1]
    ax_r = apply_h(Hm, ax_src)
    # 激光线与中轴交点（源图）
    line_pts = np.linspace(APEX_B, TIP_B, 2000)
    ci = int(np.argmin(np.abs(line_pts[:, 1] - yline(line_pts[:, 0]))))
    cross_r = apply_h(Hm, line_pts[ci : ci + 1])[0]
    apexB_r, tipB_r = apply_h(Hm, [APEX_B, TIP_B])
    ax_ty = np.interp(
        ax_r[:, 1], [apexB_r[1], cross_r[1], tipB_r[1]], [apexB_t[1], y_line_t, tipB_t[1]]
    )
    src_pts.append(ax_r)
    tgt_pts.append(np.c_[np.zeros(len(ax_r)), ax_ty])
    bead_r = apply_h(Hm, [BEAD_APEX])
    src_pts.append(bead_r)
    tgt_pts.append(np.c_[[0.0], [bead_r[0, 1] * 0.5 + (apexB_t[1] - 24) * 0.5]])

    # 激光线内部：保持水平
    jl = parts["B"]["u"][0][-1]
    jr = parts["B"]["u"][1][-1]
    xb_t = parts["B"]["u"][2][-1, 0]
    xs = np.linspace(260, 1240, 11)
    las_r = apply_h(Hm, np.c_[xs, yline(xs)])
    las_tx = np.interp(las_r[:, 0], [jl[0], cross_r[0], jr[0]], [-xb_t, 0, xb_t])
    src_pts.append(las_r)
    tgt_pts.append(np.c_[las_tx, np.full(len(xs), y_line_t)])

    src_pts = np.vstack(src_pts)
    tgt_pts = np.vstack(tgt_pts)
    resid = np.hypot(*(src_pts - tgt_pts).T)
    print(
        f"控制点 {len(src_pts)} 个，单应矫正后的残余形变 均值/最大 "
        f"{resid.mean():.1f} / {resid.max():.1f} px"
    )
    tps = RBFInterpolator(tgt_pts, src_pts, kernel="thin_plate_spline", smoothing=SMOOTH)

    # 反向映射：目标像素 → 矫正平面 → 源图
    step = 4
    gx = np.arange(0, CW + step, step)
    gy = np.arange(0, CH + step, step)
    GX, GY = np.meshgrid(gx, gy)
    q = tps(np.c_[GX.ravel() - OX, GY.ravel() - OY])
    s = apply_h(np.linalg.inv(Hm), q)
    yy, xx = np.mgrid[0:CH, 0:CW]
    coords = np.array([yy / step, xx / step])
    sx = ndi.map_coordinates(s[:, 0].reshape(GX.shape), coords, order=1)
    sy = ndi.map_coordinates(s[:, 1].reshape(GX.shape), coords, order=1)

    outline = np.vstack(
        [contours_t["A"], np.c_[-contours_t["A"][::-1, 0], contours_t["A"][::-1, 1]][1:-1]]
    )
    inner = np.vstack(
        [contours_t["B"], np.c_[-contours_t["B"][::-1, 0], contours_t["B"][::-1, 1]][1:-1]]
    )
    return {
        "sx": sx,
        "sy": sy,
        "outline": outline,
        "inner": inner,
        "y_line": y_line_t,
        "L": L,
        "yline_src": yline,
    }


def poly_mask(poly, ss=4):
    im = Image.new("L", (CW * ss, CH * ss), 0)
    ImageDraw.Draw(im).polygon([((x + OX) * ss, (y + OY) * ss) for x, y in poly], fill=255)
    return np.asarray(im.resize((CW, CH), Image.LANCZOS)).astype(float) / 255.0


def bleed_rgb(rgba):
    """把不透明区域的颜色向外扩散，避免边缘采到透明黑边。"""
    a = rgba[..., 3]
    idx = ndi.distance_transform_edt(a < 250, return_distances=False, return_indices=True)
    out = rgba.copy()
    out[..., :3] = rgba[idx[0], idx[1], :3]
    return out


def warp(rgba, W):
    src = bleed_rgb(rgba).astype(float)
    coords = np.array([W["sy"], W["sx"]])
    out = np.zeros((CH, CW, 4))
    for c in range(3):
        out[..., c] = ndi.map_coordinates(src[..., c], coords, order=3, mode="nearest")
    al = (
        ndi.map_coordinates(rgba[..., 3].astype(float), coords, order=1, mode="constant", cval=0)
        / 255.0
    )
    out[..., 3] = np.clip(al, 0, 1) * poly_mask(W["outline"]) * 255.0
    return np.clip(out + 0.5, 0, 255).astype(np.uint8)


# ======================= 4. 导出 =======================


def export(res, outdir, name, pad=16):
    im = Image.fromarray(res)
    box = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    box = (
        max(box[0] - pad, 0),
        max(box[1] - pad, 0),
        min(box[2] + pad, im.width),
        min(box[3] + pad, im.height),
    )
    im = im.crop(box)
    im.save(outdir / f"{name}.png", optimize=True)
    side = max(im.size)
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    for s in (1024, 512, 256):
        sq.resize((s, s), Image.LANCZOS).save(outdir / f"{name}@{s}.png", optimize=True)
    return im


def preview(src_im, line, noline, path):
    h = 900
    tiles = []
    for im, bgc in (
        (src_im, (12, 14, 22)),
        (line, (12, 14, 22)),
        (noline, (12, 14, 22)),
        (line, (244, 245, 248)),
        (noline, (244, 245, 248)),
    ):
        t = im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
        bg = Image.new("RGBA", (t.width + 80, h + 80), bgc + (255,))
        bg.alpha_composite(t, (40, 40))
        tiles.append(bg.convert("RGB"))
    out = Image.new("RGB", (sum(t.width for t in tiles), h + 80))
    x = 0
    for t in tiles:
        out.paste(t, (x, 0))
        x += t.width
    out.save(path, quality=92)


def main():
    here = Path(__file__).resolve().parent
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else here / "source.png"
    outdir = Path(sys.argv[2]) if len(sys.argv) > 2 else here
    outdir.mkdir(parents=True, exist_ok=True)
    src_im = Image.open(src).convert("RGBA")
    rgba = np.asarray(src_im)
    W = build_warp(rgba)
    noline_src = remove_laser(rgba, W["L"], W["yline_src"])
    line = export(warp(rgba, W), outdir, "huiyandun-shield-line")
    noline = export(warp(noline_src, W), outdir, "huiyandun-shield-noline")
    preview(src_im, line, noline, outdir / "preview.jpg")
    print("已输出到", outdir, "尺寸", line.size)


if __name__ == "__main__":
    main()
