import { defineConfig, devices } from "@playwright/test";

// 截图基线（V-P2、NT-04）：接口与 WebSocket 在用例中模拟，不依赖后端
export default defineConfig({
  testDir: "tests/e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:4173",
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    // 无 GPU 的环境以 SwiftShader 软件渲染 WebGL，场景截图需要
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    // 主题默认自动档会随时间变化：截图基线统一预置暗色，主题相关用例以 presetTheme 覆盖
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://localhost:4173",
          localStorage: [{ name: "hyd-theme", value: JSON.stringify({ state: { mode: "dark", reducedMotion: false }, version: 0 }) }],
        },
      ],
    },
  },
  webServer: {
    command: "pnpm exec vite build --mode e2e && pnpm exec vite preview --mode e2e --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
  },
});
