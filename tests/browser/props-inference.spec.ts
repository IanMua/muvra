import { test, expect } from "@playwright/test";

// 操作真实 SFC 宿主；编译期约束由 vue-tsc 单独检查，浏览器只断言实际传值和交互。
test.beforeEach(async ({ page, browser, browserName }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  (page as any).inferenceErrors = errors;
  await page.goto("/demo/props.html");
  await expect(page.getByRole("heading", { name: "Inference home", exact: true })).toBeVisible();
  await info.attach("runtime", {
    body: JSON.stringify({
      engine: browserName,
      version: browser.version(),
      node: process.version,
      viewport: page.viewportSize(),
    }),
    contentType: "application/json",
  });
});
test.afterEach(async ({ page }) => {
  expect((page as any).inferenceErrors).toEqual([]);
});
const focused = (page: any) => page.locator('.inference-frame [data-page-focused="true"]');
const idle = (page: any) =>
  expect
    .poll(() => page.evaluate(() => (window as any).propsLab.stack.getSnapshot().phase))
    .toBe("idle");

test("订单详情只有 orderNo，注册不附带字段选择也能实际进入", async ({ page }, info) => {
  await page.getByRole("button", { name: "Open inferred order", exact: true }).click();
  await idle(page);
  await expect(
    focused(page).getByRole("heading", { name: "Inferred order", exact: true }),
  ).toBeVisible();
  await expect(focused(page).getByTestId("order-no")).toHaveText("order-42");
  expect(
    await page.evaluate(() => (window as any).propsLab.stack.getSnapshot().current.params),
  ).toEqual({ orderNo: "order-42" });
  await page.screenshot({ path: info.outputPath("order-no-only.png"), fullPage: true });
});

test("全部 props 保留必填可空、默认值、可选供值、回调与事件", async ({ page }, info) => {
  await page.getByRole("button", { name: "Open input contract", exact: true }).click();
  await idle(page);
  await expect(focused(page).getByTestId("note")).toHaveText("null");
  await expect(focused(page).getByTestId("raw-note")).toHaveText("present");
  await expect(focused(page).getByTestId("section")).toHaveText("detail");
  await expect(focused(page).getByTestId("compact")).toHaveText("false");
  await expect(focused(page).getByTestId("caption")).toHaveText("host-a");
  await expect(focused(page).getByTestId("raw-caption")).toHaveText("absent");
  await expect(focused(page).getByTestId("raw-section")).toHaveText("absent");
  await focused(page).getByRole("button", { name: "Confirm order callback" }).click();
  await focused(page).getByRole("button", { name: "Emit order close" }).click();
  await expect(page.getByTestId("confirmed")).toHaveText("contract-42");
  await expect(page.getByTestId("closed")).toHaveText("contract-42");
  await page.getByRole("button", { name: "Update optional host caption" }).click();
  await expect(focused(page).getByTestId("caption")).toHaveText("host-b");
  await page.screenshot({ path: info.outputPath("all-props-contract.png"), fullPage: true });
});

test("懒加载真实模块完整保留 props 及其可空和默认值语义", async ({ page }, info) => {
  const loaded = page.waitForResponse(
    (response) => response.url().includes("/demo/chunks/LazyOrder-") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Open lazy inferred order", exact: true }).click();
  await loaded;
  await expect(focused(page).getByRole("heading", { name: "Lazy inferred order" })).toBeVisible();
  await idle(page);
  await expect(focused(page).getByTestId("order-no")).toHaveText("lazy-42");
  await expect(focused(page).getByTestId("note")).toHaveText("null");
  await expect(focused(page).getByTestId("section")).toHaveText("refund");
  await expect(focused(page).getByTestId("compact")).toHaveText("false");
  await expect(focused(page).getByTestId("caption")).toHaveText("host-a");
  await focused(page).getByRole("button", { name: "Confirm order callback" }).click();
  await expect(page.getByTestId("confirmed")).toHaveText("lazy-42");
  await page.getByRole("button", { name: "Update optional host caption" }).click();
  await expect(focused(page).getByTestId("caption")).toHaveText("host-b");
  await page.screenshot({ path: info.outputPath("lazy-inferred-page.png"), fullPage: true });
});

test("Tab 与弹窗直接从页面 props 推导全部输入", async ({ page }) => {
  await page.getByRole("button", { name: "Switch inferred Tab", exact: true }).click();
  await idle(page);
  await expect(focused(page).getByTestId("customer-id")).toHaveText("customer-7");
  await expect(focused(page).getByTestId("caption")).toHaveText("host-a");
  await page.getByRole("button", { name: "Open inferred popup", exact: true }).click();
  await idle(page);
  await expect(page.getByRole("dialog").getByTestId("popup-message")).toHaveText("Typed callback");
  await page.getByRole("button", { name: "Accept inferred popup" }).click();
  await expect(page.getByTestId("accepted")).toHaveText("true");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(focused(page).getByRole("heading", { name: "Inferred Tab" })).toBeVisible();
});
