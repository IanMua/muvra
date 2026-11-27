import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const scene = (page: Page, name: string) => page.locator(`[data-page-name="${name}"]`);
async function load(page: Page, params = "") {
  await page.route("**/fixtures/interactive-back*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="fixture" style="width: 380px; height: 500px; position: relative"></div><script type="module" src="/demo/interactive-back-fixture.js"></script>',
    }),
  );
  await page.goto(`/fixtures/interactive-back${params}`);
  await expect
    .poll(() => page.evaluate(() => (window as any).backLab?.stack.getSnapshot().back.mode))
    .toBe("interactive");
}
async function drag(page: Page, progress = 0.6) {
  expect(
    await page.evaluate((value) => {
      const lab = (window as any).backLab;
      const started = lab.begin();
      lab.update(value);
      return started;
    }, progress),
  ).toBe(true);
  await expect(scene(page, "detail")).toHaveAttribute("style", new RegExp(`${progress * 100}%`));
}

test("拖动退回和取消恢复真实图层，预览页保持不可交互", async ({ page }) => {
  await load(page);
  await drag(page);
  await expect(scene(page, "list")).toBeVisible();
  await expect(scene(page, "list")).toHaveAttribute("inert", "");
  await page.evaluate(() => (window as any).backLab.update(0.25));
  await expect(scene(page, "detail")).toHaveAttribute("style", /25%/);
  const began = await page.evaluate(() => {
    const { stack, shown, guardCalls } = (window as any).backLab;
    return {
      top: stack.getSnapshot().top.name,
      visible: stack.getSnapshot().rendered.find((entry: any) => entry.route.name === "list")
        .visible,
      shown,
      guarded: guardCalls(),
    };
  });
  expect(began).toEqual({ top: "detail", visible: false, shown: ["detail"], guarded: 0 });
  await page.evaluate(() => (window as any).backLab.cancel());
  await expect(scene(page, "list")).toBeHidden();
  await expect(scene(page, "detail")).not.toHaveAttribute("style", /translateX/);
  expect(await page.evaluate(() => (window as any).backLab.runs[0].frames.at(-1))).toBe(0);
  expect(await page.evaluate(() => (window as any).backLab.commit())).toBeUndefined();
});

test("异步守卫等待时归位，拒绝后保留当前页", async ({ page }) => {
  await load(page);
  await drag(page);
  await page.evaluate(() => {
    const lab = (window as any).backLab;
    lab.setGuard("wait");
    lab.outcome = lab.commit();
  });
  await expect.poll(() => page.evaluate(() => (window as any).backLab.guardCalls())).toBe(1);
  await expect(scene(page, "list")).toBeHidden();
  await expect(scene(page, "detail")).not.toHaveAttribute("style", /translateX/);
  const result = await page.evaluate(() => {
    const lab = (window as any).backLab;
    lab.decide(false);
    return lab.outcome;
  });
  expect(result.status).toBe("cancelled");
  expect(result.state.top.name).toBe("detail");
  expect(result.state.history.map((route: any) => route.name)).toEqual(["list", "detail"]);
});

test("守卫重定向时只提交并展示真实目标", async ({ page }) => {
  await load(page);
  await drag(page);
  const result = await page.evaluate(() => {
    const lab = (window as any).backLab;
    lab.setGuard("redirect");
    return lab.commit();
  });
  expect(result.redirected).toBe(true);
  expect(result.state.top.name).toBe("login");
  await expect(scene(page, "list")).toBeHidden();
  await expect(scene(page, "login")).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).backLab.runs.map((run: any) => [run.to, run.cleaned]),
    ),
  ).toEqual([
    ["list", true],
    ["login", true],
  ]);
});

test("并发的正式导航清理预览，旧会话无法返回新页", async ({ page }) => {
  await load(page);
  await drag(page);
  const result = await page.evaluate(async () => {
    const lab = (window as any).backLab;
    const old = lab.stack.getSnapshot().back.token;
    await lab.stack.push({ name: "external" });
    lab.update(1);
    return {
      old: lab.stack.beginBack(old),
      committed: await lab.commit(),
      top: lab.stack.getSnapshot().top.name,
    };
  });
  expect(result).toEqual({ old: undefined, committed: undefined, top: "external" });
  await expect(scene(page, "list")).toBeHidden();
  await expect(scene(page, "external")).toBeVisible();
  await expect(scene(page, "detail")).not.toHaveAttribute("style", /translateX/);
});

test("确认沿着同一次进度转场到终点，业务页面只显示一次", async ({ page }) => {
  await load(page);
  await drag(page);
  const result = await page.evaluate(() => (window as any).backLab.commit());
  expect(result.transition).toBe("completed");
  expect(result.state.top.name).toBe("list");
  const { runs, shown } = await page.evaluate(() => {
    const { runs, shown } = (window as any).backLab;
    return { runs, shown };
  });
  expect(runs).toHaveLength(1);
  expect(runs[0].targetWidth).toBeGreaterThan(0);
  expect(runs[0].frames).toContain(0.6);
  expect(runs[0].frames.at(-1)).toBe(1);
  expect(runs[0].cleaned).toBe(true);
  expect(shown).toEqual(["detail", "list"]);
});

test("可用只读内容预览未挂载页，正式提交时交接真实 DOM", async ({ page }) => {
  await load(page, "?stand-in");
  await expect(scene(page, "list")).toHaveCount(0);
  await drag(page);
  const preview = page.locator("[data-page-stack-back-preview]");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("inert", "");
  await expect(scene(page, "list")).toHaveCount(0);
  const result = await page.evaluate(() => (window as any).backLab.commit());
  expect(result.transition).toBe("completed");
  await expect(preview).toHaveCount(0);
  await expect(scene(page, "list")).toBeVisible();
  expect(await scene(page, "list").evaluate((element) => element.style.visibility)).toBe("");
});

test("应用撤销预览资格时归位，同一会话仍可确认普通返回", async ({ page }) => {
  await load(page);
  await drag(page);
  await page.evaluate(() => (window as any).backLab.setPreview(false));
  await expect
    .poll(() => page.evaluate(() => (window as any).backLab.stack.getSnapshot().back.mode))
    .toBe("commit-only");
  await expect(scene(page, "list")).toBeHidden();
  await expect(scene(page, "detail")).not.toHaveAttribute("style", /translateX/);
  const result = await page.evaluate(() => (window as any).backLab.commit());
  expect(result.state.top.name).toBe("list");
  expect(await page.evaluate(() => (window as any).backLab.runs.length)).toBe(2);
});
