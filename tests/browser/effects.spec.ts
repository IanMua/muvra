import { test, expect } from "@playwright/test";

// 真实 SFC + 浏览器 WAAPI/SVG；编译和纯作用域验证不能替代可见效果及 DOM 资源回收。
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) errors.push(message.text());
  });
  (page as any).effectErrors = errors;
  await page.goto("/demo/effects.html");
  await expect(page.getByRole("heading", { name: "转场实验室" })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect((page as any).effectErrors).toEqual([]);
});
const state = (page: any) => page.evaluate(() => (window as any).effectsLab.stack.getSnapshot());
const idle = (page: any) => expect.poll(async () => (await state(page)).phase).toBe("idle");
async function clean(page: any) {
  await expect(page.locator("[data-page-stack-effect-layer]")).toHaveCount(0);
  expect(
    await page
      .locator("[data-page-id]")
      .evaluateAll((nodes: HTMLElement[]) =>
        nodes.every(
          (node) => !node.style.filter && !node.style.visibility && !node.getAnimations().length,
        ),
      ),
  ).toBe(true);
  expect(await page.evaluate(() => (window as any).effectsLab.telemetry.activeTimers)).toBe(0);
}
const result = (page: any, outcome: string) =>
  expect(page.getByTestId("effect-result")).toHaveText(`completed / ${outcome}`);

test("噪声溶解逐帧改变阈值，返回使用离场效果并保留页面输入", async ({ page }, info) => {
  await page.getByLabel("Home draft").fill("preserved home draft");
  await page.getByRole("button", { name: "溶解进入", exact: true }).click();
  const threshold = page.locator("feFuncA");
  await expect(threshold).toHaveCount(1);
  const first = Number(await threshold.getAttribute("intercept"));
  await expect
    .poll(async () => Number(await threshold.getAttribute("intercept")))
    .toBeGreaterThan(first);
  await expect
    .poll(async () => Number(await threshold.getAttribute("intercept")), { intervals: [25, 50] })
    .toBeGreaterThan(-6);
  await page.screenshot({ path: info.outputPath("dissolve-forward-mid.png") });
  await idle(page);
  await result(page, "completed");
  await clean(page);
  await expect(page.getByTestId("effect-order-no")).toHaveText("order-animation-42");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await expect(threshold).toHaveCount(1);
  expect(
    await page.locator('[data-page-name="dissolve"]').evaluate((element) => element.style.filter),
  ).toContain("page-stack-dissolve");
  await page.screenshot({ path: info.outputPath("dissolve-back-mid.png") });
  await idle(page);
  await clean(page);
  await expect(page.getByLabel("Home draft")).toHaveValue("preserved home draft");
});

test("并行光效包含真实 Vue 图层、宿主注入和及时卸载", async ({ page }, info) => {
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await expect(page.locator('[data-transition-effect="glow"]')).toHaveCount(1);
  await expect(page.getByTestId("overlay-context")).toHaveText("host-cyan-theme");
  await expect
    .poll(() => page.evaluate(() => (window as any).effectsLab.telemetry.activeTimers))
    .toBe(1);
  await expect(page.locator("[data-page-stack-effect-layer]").first()).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.screenshot({ path: info.outputPath("glow-overlay-mid.png") });
  await idle(page);
  await result(page, "completed");
  await clean(page);
  expect(await page.evaluate(() => ({ ...(window as any).effectsLab.telemetry }))).toEqual({
    mounted: 1,
    unmounted: 1,
    activeTimers: 0,
  });
  await page.getByLabel("Glow draft").fill("interactive after effects");
});

test("顺序和并行嵌套按声明顺序完成", async ({ page }) => {
  await page.getByRole("button", { name: "顺序编排", exact: true }).click();
  await idle(page);
  await clean(page);
  expect(await page.evaluate(() => (window as any).effectsLab.steps.value)).toEqual([
    "prepare:start",
    "prepare:end",
    "reveal:start",
    "reveal:end",
    "settle:start",
    "settle:end",
  ]);
});

for (const cancel of ["取消转场", "Abort signal"]) {
  test(`${cancel} 中途回收溶解滤镜，提交后的页面仍可继续导航`, async ({ page }) => {
    await page.getByRole("button", { name: "溶解进入", exact: true }).click();
    await expect(page.locator("feFuncA")).toHaveCount(1);
    await page.getByRole("button", { name: cancel, exact: true }).click();
    await idle(page);
    await result(page, "interrupted");
    await clean(page);
    expect((await state(page)).current.name).toBe("dissolve");
    await page.getByLabel("Dissolve draft").fill("still interactive");
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await idle(page);
    await clean(page);
    expect((await state(page)).current.name).toBe("home");
  });
}

test("取消光效或卸载视图时 Vue 图层的定时器被释放，重新挂载仍可返回", async ({ page }) => {
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await expect(page.getByTestId("overlay-context")).toBeAttached();
  await page.getByRole("button", { name: "取消转场", exact: true }).click();
  await idle(page);
  await clean(page);
  await result(page, "interrupted");
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await expect(page.getByTestId("overlay-context")).toBeAttached();
  await page.getByRole("button", { name: "卸载视图", exact: true }).click();
  await idle(page);
  await clean(page);
  await result(page, "interrupted");
  await page.getByRole("button", { name: "挂载视图", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await idle(page);
  await clean(page);
  expect((await state(page)).current.name).toBe("glow");
});

test("多层弹窗独立播放，关闭时使用顶部弹窗的效果并恢复背景", async ({ page }) => {
  await page.getByRole("button", { name: "打开弹窗", exact: true }).click();
  await idle(page);
  await page.getByRole("button", { name: "叠加弹窗", exact: true }).click();
  await idle(page);
  expect((await state(page)).popups).toHaveLength(2);
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(page.locator('[data-transition-effect="overlay"]')).toHaveCount(1);
  await idle(page);
  await clean(page);
  expect((await state(page)).popups).toHaveLength(1);
  await page.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await expect(page.locator("feFuncA")).toHaveCount(1);
  await idle(page);
  await clean(page);
  expect((await state(page)).popups).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "转场实验室" })).toBeVisible();
});

for (const failure of ["部分启动失败", "组件异常"]) {
  test(`${failure} 自动清理并降级完成，后续导航继续`, async ({ page }) => {
    await page.getByText("异常路径", { exact: true }).click();
    await page.getByRole("button", { name: failure, exact: true }).click();
    await idle(page);
    await result(page, "failed");
    await clean(page);
    expect(
      await page.evaluate(() =>
        (window as any).effectsLab.diagnostics.value.some(
          (d: any) => d.error.code === "TRANSITION_ERROR",
        ),
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "返回", exact: true }).click();
    await idle(page);
    await clean(page);
    expect((await state(page)).current.name).toBe("home");
  });
}

test("超时中止图层并结束 Vue 生命周期", async ({ page }) => {
  await page.goto("/demo/effects.html?timeout=450");
  await page.getByText("异常路径", { exact: true }).click();
  await page.getByRole("button", { name: "超时演示", exact: true }).click();
  await expect(page.getByTestId("overlay-context")).toBeAttached();
  await idle(page);
  await result(page, "timed-out");
  await clean(page);
  expect((await state(page)).current.name).toBe("hanging");
});

test("销毁实例中止动画且不遗留组件、滤镜或临时 DOM", async ({ page }) => {
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await expect(page.getByTestId("overlay-context")).toBeAttached();
  await page.getByRole("button", { name: "销毁实例", exact: true }).click();
  await expect(page.getByTestId("effect-phase")).toHaveText("disposed");
  await clean(page);
  expect((await state(page)).rendered).toHaveLength(0);
});

test("减少动态效果和总开关为零时不创建特效资源", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await idle(page);
  await result(page, "skipped");
  await clean(page);
  expect(await page.evaluate(() => (window as any).effectsLab.telemetry.mounted)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/demo/effects.html?disabled");
  await page.getByRole("button", { name: "溶解进入", exact: true }).click();
  await idle(page);
  await result(page, "skipped");
  await clean(page);
});

test("长编排使用自身时长计算默认截止时间", async ({ page }) => {
  await page.goto("/demo/effects.html?duration=2150");
  await page.getByRole("button", { name: "溶解进入", exact: true }).click();
  await idle(page);
  await result(page, "completed");
  await clean(page);
});

test("连续排队并取消前一转场，下一转场只保留自己的资源", async ({ page }) => {
  await page.getByRole("button", { name: "溶解进入", exact: true }).click();
  await expect(page.locator("feFuncA")).toHaveCount(1);
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await expect.poll(async () => (await state(page)).queued).toBe(1);
  await page.getByRole("button", { name: "取消转场", exact: true }).click();
  await expect(page.getByTestId("overlay-context")).toBeAttached();
  await expect(page.locator("feFuncA")).toHaveCount(0);
  await idle(page);
  await clean(page);
  expect((await state(page)).current.name).toBe("glow");
});

test("多个 Vue 宿主同时播放时滤镜 ID 和取消范围互相隔离", async ({ page }) => {
  await page.evaluate(async () => {
    // 通过演示模块公开的装配入口创建第二个真实 Vue 应用，导航实例各自持有状态。
    const module = await import("/demo/effects.js");
    const target = document.createElement("div");
    target.id = "second-app";
    document.body.append(target);
    const other = await module.mountAnimationLab(target, { duration: 1600 });
    Object.assign(window, { secondEffectsLab: other });
    void (window as any).effectsLab.open("dissolve");
    void other.open("dissolve");
  });
  await expect(page.locator("feFuncA")).toHaveCount(2);
  const ids = await page.locator("filter").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(2);
  await page.evaluate(() => (window as any).effectsLab.stack.cancel());
  await expect(page.locator("#app feFuncA")).toHaveCount(0);
  await expect(page.locator("#second-app feFuncA")).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).secondEffectsLab.stack.getSnapshot().phase))
    .toBe("idle");
  await clean(page);
  await page.evaluate(() => (window as any).secondEffectsLab.unmount());
});

test("取消仅处理转场动画，页面内部的独立动画继续播放", async ({ page }) => {
  await page.getByRole("button", { name: "溶解进入", exact: true }).click();
  await expect(page.locator("feFuncA")).toHaveCount(1);
  await page.locator('[data-page-name="dissolve"] h1').evaluate((element) => {
    const animation = element.animate([{ opacity: 0.7 }, { opacity: 1 }], {
      duration: 5000,
      iterations: Infinity,
    });
    Object.assign(window, { independentAnimation: animation });
  });
  await page.getByRole("button", { name: "取消转场", exact: true }).click();
  await idle(page);
  await clean(page);
  expect(await page.evaluate(() => (window as any).independentAnimation.playState)).toBe("running");
  await page.evaluate(() => (window as any).independentAnimation.cancel());
});

test("缺少 WAAPI 或 SVG 滤镜能力时降级且没有资源泄漏", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: undefined });
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: string[]) =>
      args[0] === "filter" ? false : (supports as any)(...args)) as typeof CSS.supports;
  });
  await page.goto("/demo/effects.html");
  await page.getByRole("button", { name: "溶解进入", exact: true }).click();
  await idle(page);
  await result(page, "completed");
  await clean(page);
  await page.getByRole("button", { name: "光效叠加", exact: true }).click();
  await idle(page);
  await result(page, "completed");
  await clean(page);
});

test("顺序编排准备期间取消，恢复可见性并阻止后续步骤启动", async ({ page }) => {
  await page.getByRole("button", { name: "顺序编排", exact: true }).click();
  await page.waitForFunction(() => {
    const target = document.querySelector<HTMLElement>('[data-page-name="staged"]');
    if (target?.style.visibility !== "hidden") return false;
    (window as any).effectsLab.stack.cancel();
    return true;
  });
  await idle(page);
  await result(page, "interrupted");
  await clean(page);
  expect(await page.evaluate(() => (window as any).effectsLab.steps.value)).toEqual([
    "prepare:start",
  ]);
  await expect(page.locator('[data-page-name="staged"]')).toBeVisible();
});
