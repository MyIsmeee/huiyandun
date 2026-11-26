import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../../src/lib/api";

/** 只实现上传用到的部分：记下请求，由用例驱动进度与结果 */
class FakeXhr {
  static last: FakeXhr;
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  timeout = 0;
  status = 0;
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("上传视频文件摄像头的视频（D-145）", () => {
  const file = new File(["x"], "门口 东.mp4", { type: "video/mp4" });
  const start = () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const done = api.uploadVideoFile(file, (f) => progress.push(f));
    return { xhr: FakeXhr.last, progress, done };
  };

  it("原始字节、文件名在查询参数中、带请求 ID 与时限；报告进度", async () => {
    const { xhr, progress, done } = start();
    expect(xhr.url).toBe(`/api/cameras/video-files?name=${encodeURIComponent("门口 东.mp4")}`);
    expect(xhr.headers["Content-Type"]).toBe("application/octet-stream");
    expect(xhr.headers["X-Request-ID"]).toBeTruthy();
    expect(xhr.body).toBe(file);
    expect(xhr.timeout).toBeGreaterThan(0);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    xhr.respond(201, { id: "a".repeat(32), name: "门口 东.mp4", size_bytes: 1 });
    expect((await done).id).toBe("a".repeat(32));
    expect(progress).toEqual([0.25]);
  });

  it("服务端拒绝时带白话原因；网络中断与非契约响应为连接失败", async () => {
    const rejected = start();
    rejected.xhr.respond(413, { code: "413", message: "视频超过 2 GB", request_id: "r" });
    await expect(rejected.done).rejects.toEqual(new ApiError(413, "视频超过 2 GB"));

    const broken = start();
    broken.xhr.onerror?.();
    await expect(broken.done).rejects.not.toBeInstanceOf(ApiError);

    const proxy = start();
    proxy.xhr.respond(502, "<html>Bad Gateway</html>");
    await expect(proxy.done).rejects.not.toBeInstanceOf(ApiError);
  });
});
