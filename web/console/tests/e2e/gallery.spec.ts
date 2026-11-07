import { expect, test } from "@playwright/test";

// 组件全部状态的截图基线（V-G3、V-P2）；新增组件时在 gallery/main.tsx 登记并在此列出状态
const COMPONENTS = {
  KpiTile: ["normal", "empty", "loading", "stale"],
  Scene2D: ["empty"],
  LiveVideo: ["normal", "empty", "loading", "error", "disconnected"],
  // 监控墙瓦片（V-W2、V-W3）：断线态为设备离线、保留最后画面；空态为宫格空位，由监控墙用例覆盖
  VideoTile: ["normal", "loading", "error", "physical", "cyber", "contained", "selected", "disconnected", "unmapped"],
  // 空态即未选中时面板收起；错误态由 LiveVideo 覆盖
  DetailPanel: ["device", "disconnected"],
  // 数据只来自推送，无加载与错误态：连接中与连不上由顶栏连接状态表示，断线后保留内容并标注
  AlertList: ["normal", "empty", "disconnected"],
  // 正常态为已判定、含未溯源实体与确认按钮；不可用态另含确认被拒；空态为尚未开始调查，错误态为读取失败
  AiInvestigation: ["normal", "running", "unavailable", "empty", "loading", "error", "disconnected"],
  // 报告不随推送变化，无断线态；空态为尚无报告，加载为读取历史，错误态含读取失败与生成失败
  ReportBar: ["empty", "loading", "normal", "generating", "error"],
  // 报告页嵌入导出网页（D-097），内容由导出网页呈现；只经 REST 读取，无断线态
  ReportPage: ["draft", "reviewed", "error"],
  // 只经 REST 轮询、不随推送变化，无断线态与空态（没有可用供应商即模板模式）
  LlmStatusBadge: ["normal", "failover", "template", "loading", "error"],
  // 只经 REST 读取、不随推送变化，无断线态；failing 为含失败项，blocked 为全局禁止公网
  ProviderList: ["normal", "failing", "blocked", "empty", "loading", "error"],
  // 新建态含误填 127.0.0.1 的提示；partial 为测试部分失败，含候选模型；只经 REST 提交，无断线态
  ProviderEditor: ["new", "edit", "saving", "error", "testing", "partial"],
};

/** 以模态对话框呈现的组件 */
const DIALOGS = new Set(["ProviderEditor"]);

for (const [component, states] of Object.entries(COMPONENTS)) {
  for (const state of states) {
    test(`${component}：${state}`, async ({ page }) => {
      // 报告页嵌入的导出网页（由后端渲染）以固定内容代替
      await page.route("/api/reports/*/export?format=html", (route) =>
        route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><h1>溯源报告</h1><p>事实区 · AI 分析区</p>' }),
      );
      await page.goto(`/tests/e2e/gallery/?component=${component}&state=${state}`);
      // 视频须已有首帧，否则截到空白
      await page.waitForFunction(() => [...document.querySelectorAll("video")].every((v) => v.readyState >= 2));

      // 编辑对话框经 Radix 渲染到 body（04 §3.6）：截对话框本身
      const shot = DIALOGS.has(component) ? page.getByRole("dialog") : page.locator(`[data-state="${state}"]`);
      await expect(shot).toHaveScreenshot(`${component}-${state}.png`);
    });
  }
}
