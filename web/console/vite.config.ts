/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // shadcn/ui 生成的组件以 @/ 引用 src（04 §3.6）
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  // e2e 模式另外构建组件展示页，供组件各状态的截图基线使用（V-G3）；产品构建不包含
  build:
    mode === "e2e"
      ? { outDir: "dist-e2e", rolldownOptions: { input: ["index.html", "tests/e2e/gallery/index.html"] } }
      : {},
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
  },
}));
