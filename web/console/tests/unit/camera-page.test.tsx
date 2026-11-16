import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";
import { type Camera, CameraEditor, body } from "../../src/panels/CameraEditor/CameraEditor";
import { CameraListView, address } from "../../src/panels/CameraList/CameraList";

// Radix RadioGroup 依赖 jsdom 未实现的 ResizeObserver
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const POSE = { x: 2, y: 2, height_m: 3, yaw_deg: 45, pitch_deg: -30, hfov_deg: 90, range_m: 15 };
const CAM: Camera = {
  id: "cam-03",
  name: "大门口",
  ip: "192.168.8.31",
  ingest: "pull",
  source: { protocol: "rtsp", host: "192.168.8.31", port: 554, path: "/Streaming/Channels/101", relay: false },
  username: "admin",
  password_set: true,
  area_id: null,
  pose: POSE,
  calibration: [],
  calibration_error_m: null,
  climb_lines: [],
  rules: [],
  created_at: "2026-11-05T00:00:00Z",
  updated_at: "2026-11-05T00:00:00Z",
};
const flush = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("摄像头列表（ui.md §7.2）", () => {
  const view = (cameras: Camera[], deleting: Camera | null = null) => {
    const handlers = { onEdit: vi.fn(), onDelete: vi.fn(), onConfirmDelete: vi.fn() };
    render(
      <CameraListView
        load={{ status: "ready", cameras }}
        notice={null}
        deleting={deleting}
        onClose={() => {}}
        onRetry={() => {}}
        onAdd={() => {}}
        onCancelDelete={() => {}}
        {...handlers}
      />,
    );
    return handlers;
  };

  it("显示不含凭据的地址、口令是否设置、地面映射方式（V-CAM1、V-CAM2）", () => {
    view([CAM, { ...CAM, id: "cam-01", name: "演示", password_set: false, calibration: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 1, 2, 3], [4, 5, 6, 7]], calibration_error_m: 0.21 }]);
    const items = within(screen.getByRole("table", { name: "摄像头列表" })).getAllByRole("row").slice(1);
    expect(items[0]?.textContent).toContain("rtsp://192.168.8.31:554/Streaming/Channels/101 · 口令 已设置");
    expect(items[0]?.textContent).toContain("按安装参数估算");
    expect(items[0]?.textContent).not.toContain("admin");
    expect(items[1]?.textContent).toContain("口令 未设置");
    expect(items[1]?.textContent).toContain("已标定 · 误差 ±0.21 m");
  });

  it("推流摄像头不列拉流口令；没有设备状态时显示未知而不是在线", () => {
    vi.spyOn(api, "getSite").mockReturnValue(new Promise(() => {}));
    view([{ ...CAM, ingest: "push", source: null, password_set: false }]);
    const row = within(screen.getByRole("table", { name: "摄像头列表" })).getAllByRole("row")[1];
    expect(row?.textContent).not.toContain("口令");
    expect(row?.textContent).not.toContain("在线");
    expect(row?.textContent).toContain("—");
  });

  it("删除须二次确认并说明后果（V-CAM5）", () => {
    const { onConfirmDelete } = view([CAM], CAM);
    expect(screen.getByRole("alertdialog").textContent).toContain("告警历史保留，实时识别与录像停止");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除" }));
    expect(onConfirmDelete).toHaveBeenCalledWith(CAM);
  });

  it("地址：ONVIF 不带路径，IPv6 加方括号", () => {
    expect(address({ ...CAM, source: { protocol: "onvif", host: "fe80::1", port: 80, path: "", relay: false } })).toBe("onvif://[fe80::1]:80");
  });
});

describe("添加与编辑（ui.md §7.2）", () => {
  it("请求体：主机留空取设备 IP；口令为空不发送（只写不读）", () => {
    const form = { name: " 后门 ", ip: "10.0.0.5", ingest: "pull" as const, protocol: "http" as const, host: "", port: 80, path: "video.mjpg", relay: true, username: "", password: "", pose: POSE, climb_lines: [] };
    expect(body(form)).toEqual({
      name: "后门",
      ip: "10.0.0.5",
      ingest: "pull",
      // 兼容模式只对 RTSP / RTMP 有效（D-117）：HTTP 即使勾选也不发送
      source: { protocol: "http", host: "10.0.0.5", port: 80, path: "video.mjpg", relay: false },
      username: null,
      pose: POSE,
      climb_lines: [],
    });
  });

  it("推流：不带拉流地址与凭据；列表显示推流地址与用户名（FR-907）", () => {
    const form = { name: "手机", ip: "10.0.0.6", ingest: "push" as const, protocol: "rtsp" as const, host: "x", port: 554, path: "p", relay: false, username: "u", password: "pw", pose: POSE, climb_lines: [] };
    expect(body(form)).toEqual({ name: "手机", ip: "10.0.0.6", ingest: "push", source: null, username: null, pose: POSE, climb_lines: [] });
    expect(address({ ...CAM, ingest: "push", source: null })).toBe(`推流地址 rtsp://${location.hostname}:8554/cam-03 · 用户 hyd`);
  });

  it("编辑时取一帧预览；在预览上点两点画警戒线，按画面原始尺寸换算（V-CAM4、V-CAM7）", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockResolvedValue(new Blob(["jpeg"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
    const update = vi.spyOn(api, "updateCamera").mockResolvedValue(CAM);
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    const img = screen.getByAltText("摄像头画面预览") as HTMLImageElement;
    Object.defineProperties(img, { naturalWidth: { value: 1280 }, naturalHeight: { value: 720 } });
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect;
    fireEvent.click(img, { clientX: 100, clientY: 300 });
    fireEvent.click(img, { clientX: 300, clientY: 100 });
    expect(screen.getByText(/共 1 条/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ climb_lines: [[200, 600, 600, 200]] });
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("password");
  });

  it("取不到画面时显示服务端给出的原因", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "取画面超时：摄像头无响应或网络不通"));
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();
    expect(screen.getByText(/取不到画面：取画面超时/)).toBeTruthy();
  });

  it("数字框可清空、可先输入负号，不被改写成 0；非法值不提交并标出", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    const update = vi.spyOn(api, "updateCamera").mockResolvedValue(CAM);
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    const yaw = screen.getByLabelText("朝向") as HTMLInputElement;
    fireEvent.change(yaw, { target: { value: "" } });
    expect(yaw.value).toBe("");
    fireEvent.change(yaw, { target: { value: "-" } });
    expect(yaw.value).toBe("-");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/朝向：请填写数字/)).toBeTruthy();

    fireEvent.change(yaw, { target: { value: "-90" } });
    fireEvent.change(screen.getByLabelText("俯角"), { target: { value: "0" } });
    expect(screen.getByText(/俯角须在 -90°～0° 之间/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("俯角"), { target: { value: "-45" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ pose: { yaw_deg: -90, pitch_deg: -45 } });
  });

  it("主机与设备 IP 相同时回显为空：之后只改设备 IP，拉流地址随之改", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    const update = vi.spyOn(api, "updateCamera").mockResolvedValue(CAM);
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    expect((screen.getByLabelText("主机") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("设备 IP"), { target: { value: "192.168.8.40" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ source: { host: "192.168.8.40" } });
  });

  it("已放入区域时位置须在区域内", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    const area = { id: "area-01", name: "厂区", width_m: 10, depth_m: 8, items: [], updated_at: "2026-11-05T00:00:00Z" };
    vi.spyOn(api, "getSite").mockResolvedValue({ id: "s", name: "s", width_m: 10, height_m: 8, areas: [area], devices: [] });
    const update = vi.spyOn(api, "updateCamera").mockResolvedValue(CAM);
    render(<CameraEditor camera={{ ...CAM, area_id: "area-01" }} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    fireEvent.change(screen.getByLabelText("位置 x"), { target: { value: "12" } });
    expect(screen.getByText(/须在所在区域内（0～10 m）/)).toBeTruthy();
    expect(screen.getByLabelText("位置 x").getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(update).not.toHaveBeenCalled();
  });

  it("保存后的取帧先返回、打开时的取帧迟到：不被旧结果覆盖，迟到的画面立即释放", async () => {
    let first: (b: Blob) => void = () => {};
    vi.spyOn(api, "getCameraSnapshot")
      .mockImplementationOnce(() => new Promise((r) => (first = r)))
      .mockResolvedValue(new Blob(["new"]));
    let n = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++n}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(api, "updateCamera").mockResolvedValue(CAM);
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect((screen.getByAltText("摄像头画面预览") as HTMLImageElement).src).toBe("blob:1");
    await act(async () => first(new Blob(["old"])));
    expect((screen.getByAltText("摄像头画面预览") as HTMLImageElement).src).toBe("blob:1");
    expect(revoke).toHaveBeenCalledWith("blob:2");
  });

  it("接入方式选推流：隐藏拉流地址，显示推流地址（FR-907）", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();
    expect(screen.getByRole("combobox", { name: "协议" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "推流（设备推到本机）" }));
    expect(screen.queryByRole("combobox", { name: "协议" })).toBeNull();
    expect(screen.getByText("推流地址")).toBeTruthy();
  });
});

describe("地面映射（V-CAM9、FR-910）", () => {
  const section = () => within(screen.getByRole("region", { name: "地面映射" }));

  it("未放入区域时标定按钮不可点并注明原因（A16）", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    expect(section().getByText("按安装参数估算")).toBeTruthy();
    expect((section().getByRole("button", { name: "标定" }) as HTMLButtonElement).disabled).toBe(true);
    expect(section().getByText("先在场景页把摄像头放入区域")).toBeTruthy();
    expect(screen.queryByText(/已标定：位置按标定换算/)).toBeNull();
  });

  it("已标定时显示误差，安装参数说明注明只用于画视场（A16）", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    const calibrated = { ...CAM, area_id: "area-01", calibration: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 1, 2, 3], [4, 5, 6, 7]], calibration_error_m: 0.21 };
    render(<CameraEditor camera={calibrated} onClose={() => {}} onSaved={() => {}} />);
    await flush();

    expect(section().getByText("已标定 · 误差 ±0.21 m")).toBeTruthy();
    expect((section().getByRole("button", { name: "标定" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/已标定：位置按标定换算，安装参数只用于画视场；摄像头转动过请重新标定。/)).toBeTruthy();
  });

  it("新增摄像头保存前不显示地面映射", () => {
    render(<CameraEditor camera={null} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole("region", { name: "地面映射" })).toBeNull();
  });
});

describe("兼容模式（D-117、V-CAM8）", () => {
  it("RTSP 显示开关并随请求体发送；HTTP 不显示开关、提示改用 RTSP", async () => {
    vi.spyOn(api, "getCameraSnapshot").mockResolvedValue(new Blob(["jpeg"]));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
    const update = vi.spyOn(api, "updateCamera").mockResolvedValue(CAM);
    render(<CameraEditor camera={CAM} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "兼容模式" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0]?.[1]).toMatchObject({ source: { protocol: "rtsp", relay: true } });
    cleanup();

    const http = { ...CAM, source: { protocol: "http" as const, host: "192.168.8.31", port: 8080, path: "mjpeg", relay: false } };
    render(<CameraEditor camera={http} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole("switch", { name: "兼容模式" })).toBeNull();
    expect(screen.getByText(/请尽量改用 RTSP/)).toBeTruthy();
  });
});

describe("安装参数自检（D-102 估算映射）", () => {
  const SUSPECT: NonNullable<Camera["pose_check"]> = {
    camera_id: "cam-03",
    status: "suspect",
    samples: 24,
    person_height_m: 4.9,
    speed_p95_mps: 12.5,
    suggested_height_m: 1,
    suggested_pitch_deg: -8,
    reasons: ["按当前参数推算行人身高约 4.9 m", "安装高度可能应为约 1.0 m（当前 3 m）"],
  };
  const open = async (camera: Camera) => {
    vi.spyOn(api, "getCameraSnapshot").mockRejectedValue(new ApiError(502, "无画面"));
    render(<CameraEditor camera={camera} onClose={() => {}} onSaved={() => {}} />);
    await flush();
  };

  it("可疑时列出依据；填入建议值只改表单，保存时才提交", async () => {
    const update = vi.spyOn(api, "updateCamera").mockResolvedValue({ ...CAM, pose_check: null });
    await open({ ...CAM, pose_check: SUSPECT });

    const note = within(screen.getByRole("status", { name: "安装参数自检" }));
    expect(note.getByText(/推算行人身高约 4.9 m/)).toBeTruthy();
    fireEvent.click(note.getByRole("button", { name: /填入建议值（高度 1 m、俯角 -8°）/ }));
    expect((screen.getByLabelText("安装高度") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("俯角") as HTMLInputElement).value).toBe("-8");
    expect(update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ pose: { ...POSE, height_m: 1, pitch_deg: -8 } });
    expect(screen.queryByRole("status", { name: "安装参数自检" })).toBeNull(); // 保存后旧建议不再显示
    expect(screen.getByText(/安装参数已修改：自检将按新参数重新推算/)).toBeTruthy();
  });

  it("保存时没改安装参数：服务端保留的自检照旧显示（保存的响应不含自检）", async () => {
    vi.spyOn(api, "updateCamera").mockResolvedValue({ ...CAM, name: "新名称" });
    await open({ ...CAM, pose_check: SUSPECT });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(screen.getByRole("status", { name: "安装参数自检" })).toBeTruthy();
  });

  it("建议俯角超出可填范围时不提供填入并说明", async () => {
    await open({ ...CAM, pose_check: { ...SUSPECT, suggested_pitch_deg: 4 } });
    const note = within(screen.getByRole("status", { name: "安装参数自检" }));
    expect(note.getByRole("button", { name: "填入建议值（高度 1 m）" })).toBeTruthy();
    expect(note.getByText(/推算的俯角约 4°，超出可填范围/)).toBeTruthy();
  });

  it("样本不足时说明还缺什么；已标定时不显示", async () => {
    const insufficient = { ...SUSPECT, status: "insufficient" as const, suggested_height_m: null, suggested_pitch_deg: null, reasons: ["站立行人样本 3 个，至少需要 15 个"] };
    await open({ ...CAM, pose_check: insufficient });
    expect(screen.getByText(/安装参数自检暂不能判断：站立行人样本 3 个/)).toBeTruthy();
    cleanup();

    await open({ ...CAM, calibration: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 1, 2, 3], [4, 5, 6, 7]], calibration_error_m: 0.2, pose_check: SUSPECT });
    expect(screen.queryByRole("status", { name: "安装参数自检" })).toBeNull();
  });
});
