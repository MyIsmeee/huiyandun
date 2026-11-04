import { expect, test } from "@playwright/test";

// 组件全部状态的截图基线（V-G3、V-P2）；新增组件时在 gallery/main.tsx 登记并在此列出状态
const COMPONENTS = {
  KpiTile: ["normal", "empty", "loading", "stale"],
  Scene2D: ["empty"],
  LiveVideo: ["normal", "empty", "loading", "error", "disconnected"],
  // 空态即未选中时面板收起；错误态由 LiveVideo 覆盖
  DetailPanel: ["device", "disconnected"],
  // 数据只来自推送，无加载与错误态：连接中与连不上由顶栏连接状态表示，断线后保留内容并标注
  AlertList: ["normal", "empty", "disconnected"],
  // 正常态为已判定、含未溯源实体与确认按钮；不可用态另含确认被拒；空态为尚未开始调查，错误态为读取失败
  AiInvestigation: ["normal", "running", "unavailable", "empty", "loading", "error", "disconnected"],
  // 报告不随推送变化，无断线态；空态为尚未生成
  ReportBar: ["empty", "loading", "normal", "reviewed", "error"],
  // 只经 REST 轮询、不随推送变化，无断线态与空态（没有可用供应商即模板模式）
  LlmStatusBadge: ["normal", "failover", "template", "loading", "error"],
  // 只经 REST 读取、不随推送变化，无断线态；failing 为含失败项，blocked 为全局禁止公网
  ProviderList: ["normal", "failing", "blocked", "empty", "loading", "error"],
  // 新建态含误填 127.0.0.1 的提示；partial 为测试部分失败，含候选模型；只经 REST 提交，无断线态
  ProviderEditor: ["new", "edit", "saving", "error", "testing", "partial"],
};

for (const [component, states] of Object.entries(COMPONENTS)) {
  for (const state of states) {
    test(`${component}：${state}`, async ({ page }) => {
      await page.goto(`/tests/e2e/gallery/?component=${component}`);
      // 视频须已有首帧，否则截到空白
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.readyState >= 2));

      await expect(page.locator(`[data-state="${state}"]`)).toHaveScreenshot(`${component}-${state}.png`);
    });
  }
}
