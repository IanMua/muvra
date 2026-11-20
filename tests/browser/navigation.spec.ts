import { test, expect } from "@playwright/test";

// 所有页面动作经过公开 API 或真实按钮；错误事件单独收集，动画降级警告不算页面崩溃。
test.beforeEach(async ({ page, browser, browserName }, info) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  (page as any).runtimeFailures = failures;
  await page.goto("/");
  await info.attach("runtime", {
    body: JSON.stringify(
      {
        engine: browserName,
        version: browser.version(),
        node: process.version,
        viewport: page.viewportSize(),
        userAgent: await page.evaluate(() => navigator.userAgent),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  await expect(
    page.locator("[data-main-frame]").getByRole("heading", { name: "Home", exact: true }),
  ).toBeVisible();
});
test.afterEach(async ({ page }) => {
  expect((page as any).runtimeFailures).toEqual([]);
});
const main = (page: any) => page.locator("[data-main-frame]");
const idle = async (page: any) =>
  expect
    .poll(() => page.evaluate(() => (window as any).lab.stack.getSnapshot().phase))
    .toBe("idle");

test("输入状态、多层弹窗、焦点与背景交互", async ({ page }) => {
  await main(page).getByLabel("Home draft").fill("retained home");
  await main(page).getByRole("button", { name: "Open dialog" }).focus();
  await main(page).getByRole("button", { name: "Open dialog" }).press("Enter");
  await idle(page);
  const dialog = main(page).getByRole("dialog");
  await dialog.getByLabel("Popup draft").fill("retained popup");
  await dialog.getByRole("button", { name: "Nested dialog", exact: true }).focus();
  await dialog.getByRole("button", { name: "Nested dialog", exact: true }).press("Enter");
  await idle(page);
  await expect(main(page).getByRole("dialog")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).lab.stack.getSnapshot().popups.length)).toBe(2);
  await expect(main(page).locator('[data-page-name="home"]')).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await idle(page);
  await expect(main(page).getByRole("dialog").getByLabel("Popup draft")).toHaveValue(
    "retained popup",
  );
  await expect(
    main(page).getByRole("dialog").getByRole("button", { name: "Nested dialog", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await idle(page);
  await expect(main(page).getByLabel("Home draft")).toHaveValue("retained home");
  await expect(main(page).getByRole("button", { name: "Open dialog" })).toBeFocused();
});
test("同名页面具有独立输入状态，返回恢复前一实例", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await idle(page);
  await main(page).getByRole("textbox", { name: "Detail draft" }).fill("first detail");
  await main(page).getByRole("button", { name: "Open another detail" }).click();
  await idle(page);
  await expect(main(page).getByRole("textbox", { name: "Detail draft" })).toHaveValue("");
  await main(page).getByRole("button", { name: "Back", exact: true }).click();
  await idle(page);
  await expect(main(page).getByRole("textbox", { name: "Detail draft" })).toHaveValue(
    "first detail",
  );
});
test("登录恢复订单 Tab，移除承接登录页并保留 Home 缓存", async ({ page }) => {
  await main(page).getByLabel("Home draft").fill("cached home");
  await main(page).getByRole("button", { name: "Orders Tab" }).click();
  await idle(page);
  await expect(main(page).getByRole("heading", { name: "Login" })).toBeVisible();
  await main(page).getByRole("button", { name: "Sign in and resume" }).click();
  await idle(page);
  expect(
    await page.evaluate(() =>
      (window as any).lab.stack.getSnapshot().history.map((r: any) => r.name),
    ),
  ).toEqual(["orders"]);
  await main(page).getByRole("button", { name: "Home Tab" }).click();
  await idle(page);
  await expect(main(page).getByLabel("Home draft")).toHaveValue("cached home");
});
test("同步 Observable 拒绝返回不报错也不累积订阅", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await idle(page);
  await main(page).getByLabel("Block back").check();
  for (let index = 0; index < 3; index++) {
    await main(page).getByRole("button", { name: "Back", exact: true }).click();
    await idle(page);
  }
  expect(await page.evaluate(() => (window as any).lab.guardObservers())).toBe(0);
  await expect(main(page).getByRole("heading", { name: "Detail 1" })).toBeVisible();
  await main(page).getByLabel("Block back").uncheck();
  await main(page).getByRole("button", { name: "Back", exact: true }).click();
  await idle(page);
  await expect(main(page).getByRole("heading", { name: "Home", exact: true })).toBeVisible();
});
for (const mode of ["throw", "partial", "hang"]) {
  test(`动画 ${mode} 后路由、显示、效果和后续导航一致`, async ({ page }) => {
    await page.evaluate((value) => (window as any).lab.setMode(value), mode);
    await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
    await idle(page);
    await expect(main(page).getByRole("heading", { name: "Detail 1" })).toBeVisible();
    const state = await page.evaluate(() => ({
      current: (window as any).lab.stack.getSnapshot().current.name,
      transition: (window as any).lab.result().transition,
      animations: [...document.querySelectorAll("[data-main-frame] [data-page-id]")].reduce(
        (sum, element) => sum + element.getAnimations().length,
        0,
      ),
    }));
    expect(state.current).toBe("detail");
    expect(state.transition).toBe(mode === "hang" ? "timed-out" : "failed");
    expect(state.animations).toBe(0);
    await page.evaluate(() => (window as any).lab.setMode("normal"));
    await main(page).getByRole("button", { name: "Back", exact: true }).click();
    await idle(page);
    await expect(main(page).getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  });
}
test("减少动态效果偏好跳过驱动执行", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => (window as any).lab.setMode("hang"));
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await idle(page);
  expect(await page.evaluate(() => (window as any).lab.result().transition)).toBe("skipped");
  expect(await page.evaluate(() => (window as any).lab.driverStats().calls)).toBe(0);
});
test("Tab 键限制在顶部弹窗，Escape 关闭后恢复焦点", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open dialog" }).click();
  await idle(page);
  const dialog = main(page).getByRole("dialog");
  await expect(dialog.getByLabel("Popup draft")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Popup draft")).toBeFocused();
});
test("错误边界可重试并继续导航", async ({ page }) => {
  await page.getByRole("button", { name: "Break page" }).click();
  await idle(page);
  await expect(main(page).getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Recover component" }).click();
  await main(page).getByRole("button", { name: "Retry" }).click();
  await expect(main(page).getByRole("heading", { name: "Recovered page" })).toBeVisible();
  await main(page).getByRole("button", { name: "Back", exact: true }).click();
  await idle(page);
});
test("视图卸载中止动画，重新挂载继续使用同一实例", async ({ page }) => {
  await page.evaluate(() => (window as any).lab.setMode("hang"));
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await page.getByRole("button", { name: "Toggle view" }).click();
  await idle(page);
  expect(await page.evaluate(() => (window as any).lab.result().transition)).toBe("interrupted");
  await page.evaluate(() => (window as any).lab.setMode("normal"));
  await page.getByRole("button", { name: "Toggle view" }).click();
  await expect(main(page).getByRole("heading", { name: "Detail 1" })).toBeVisible();
  await main(page).getByRole("button", { name: "Back", exact: true }).click();
  await idle(page);
});
test("两个实例隔离，切换视图绑定不会串用旧页面", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await idle(page);
  await expect(page.locator("[data-secondary-frame]").getByText("Instance B")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).lab.secondary.getSnapshot().history.length),
  ).toBe(1);
  await page.getByRole("button", { name: "Swap instance" }).click();
  await expect(main(page).getByText("Swapped instance")).toBeVisible();
});

test("焦点顺序包含正 tabindex 并跳过禁用 fieldset", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open dialog" }).click();
  await idle(page);
  await page.evaluate(() => {
    const card = document.querySelector('[data-main-frame] [data-page-focused="true"] .card')!;
    const priority = document.createElement("button");
    priority.textContent = "Priority focus";
    priority.tabIndex = 1;
    card.append(priority);
    const fieldset = document.createElement("fieldset");
    fieldset.disabled = true;
    const disabled = document.createElement("input");
    disabled.setAttribute("aria-label", "Disabled field");
    fieldset.append(disabled);
    card.append(fieldset);
  });
  const dialog = main(page).getByRole("dialog");
  await dialog.getByRole("button", { name: "Priority focus" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Priority focus" })).toBeFocused();
});
test("开放 Shadow DOM 内的焦点也限制在顶部弹窗", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open dialog" }).click();
  await idle(page);
  await page.evaluate(() => {
    const card = document.querySelector('[data-main-frame] [data-page-focused="true"] .card')!;
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.textContent = "Shadow control";
    shadow.append(button);
    card.append(host);
  });
  const dialog = main(page).getByRole("dialog");
  await dialog.getByRole("button", { name: "Shadow control" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Popup draft")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Shadow control" })).toBeFocused();
});
test("缺少原生 inert 时也会将背景焦点送回弹窗", async ({ page }) => {
  await main(page).getByRole("button", { name: "Open dialog" }).click();
  await idle(page);
  await page.evaluate(() => {
    const background = document.querySelector<HTMLElement>(
      '[data-main-frame] [data-page-name="home"]',
    )!;
    background.removeAttribute("inert");
    background.querySelector<HTMLInputElement>("input")!.focus();
  });
  await expect(main(page).getByRole("dialog").getByLabel("Popup draft")).toBeFocused();
});

test("原生返回即时接管，拒绝守卫不会变成允许退出", async ({ page }) => {
  await page.getByRole("button", { name: "Native Back", exact: true }).click();
  await expect(page.locator("[data-status]")).toContainText('"nativeDecision": "exit"');
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await idle(page);
  await main(page).getByLabel("Block back").check();
  await page.getByRole("button", { name: "Native Back", exact: true }).click();
  await idle(page);
  await expect(page.locator("[data-status]")).toContainText('"nativeDecision": "handled"');
  await expect(main(page).getByRole("heading", { name: "Detail 1" })).toBeVisible();
  await main(page).getByLabel("Block back").uncheck();
  await page.getByRole("button", { name: "Native Back", exact: true }).click();
  await idle(page);
  await expect(main(page).getByRole("heading", { name: "Home", exact: true })).toBeVisible();
});

test("动态弹窗和按需加载仅通过公开 API 完成往返", async ({ page }) => {
  await page.getByRole("button", { name: "Dynamic dialog", exact: true }).click();
  await idle(page);
  await expect(
    main(page).getByRole("dialog").getByRole("heading", { name: "Dynamic dialog" }),
  ).toBeVisible();
  await main(page).getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await idle(page);
  await expect(main(page).getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Lazy page", exact: true }).click();
  await expect(main(page).getByRole("heading", { name: "Lazy page ready" })).toBeVisible();
  await idle(page);
  await main(page).getByRole("button", { name: "Back", exact: true }).click();
  await idle(page);
  await expect(main(page).getByRole("heading", { name: "Home", exact: true })).toBeVisible();
});

test("省略转场配置不隐式创建动画，导航正常完成", async ({ page }) => {
  await page.evaluate(() => (window as any).lab.setViewOptions({ omitTransition: true }));
  await main(page).getByRole("button", { name: "Open detail", exact: true }).click();
  await idle(page);
  expect(await page.evaluate(() => (window as any).lab.result().transition)).toBe("skipped");
  expect(await page.evaluate(() => (window as any).lab.driverStats().calls)).toBe(0);
  const count = await main(page)
    .locator("[data-page-id]")
    .evaluateAll((elements) =>
      elements.reduce((sum, element) => sum + element.getAnimations().length, 0),
    );
  expect(count).toBe(0);
});

test("宿主关闭键盘和焦点管理后，弹窗不自动抢焦点或消费 Escape", async ({ page }) => {
  await page.evaluate(() =>
    (window as any).lab.setViewOptions({ keyboard: false, restoreFocus: false }),
  );
  await main(page).getByRole("button", { name: "Open dialog", exact: true }).click();
  await idle(page);
  const dialog = main(page).getByRole("dialog");
  await expect(dialog.getByLabel("Popup draft")).not.toBeFocused();
  await dialog.getByLabel("Popup draft").focus();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).lab.stack.getSnapshot().popups.length)).toBe(1);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await idle(page);
  await expect(dialog).toHaveCount(0);
});

test("导航 info 经统一预处理和登录恢复后仍可在全局事件中准确关联", async ({ page }) => {
  await page.evaluate(async () => {
    const stack = (window as any).lab.stack;
    const telemetry = { prepared: [] as number[], events: [] as any[], guards: [] as string[] };
    (window as any).infoTelemetry = telemetry;
    stack.onNavigation((event: any) => telemetry.events.push(event));
    stack.beforeNavigate((navigation: any) => {
      telemetry.prepared.push(navigation.id);
      return { info: navigation.info };
    });
    stack.beforeEach((guard: any) => {
      if (guard.info?.business === "browser") telemetry.guards.push(guard.to.name);
    });
    await stack.switchTab({ name: "orders" }, { info: { business: "browser" } });
  });
  await expect(main(page).getByRole("heading", { name: "Login", exact: true })).toBeVisible();
  await main(page).getByRole("button", { name: "Sign in and resume", exact: true }).click();
  await idle(page);
  await expect(main(page).getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
  const telemetry = await page.evaluate(() => {
    const { prepared, events, guards } = (window as any).infoTelemetry;
    return {
      prepared,
      pairs: events.map((event: any) => [event.type, event.id]),
      results: events
        .filter((event: any) => event.type === "settled")
        .map((event: any) => ({
          id: event.id,
          resumedFromId: event.resumedFromId,
          info: event.info,
          target: event.result.state.top.name,
        })),
      guards,
    };
  });
  expect(telemetry.prepared).toHaveLength(2);
  expect(telemetry.pairs).toEqual([
    ["requested", telemetry.prepared[0]],
    ["settled", telemetry.prepared[0]],
    ["requested", telemetry.prepared[1]],
    ["settled", telemetry.prepared[1]],
  ]);
  expect(telemetry.results[1].resumedFromId).toBe(telemetry.results[0].id);
  expect(telemetry.results.map((result: any) => result.info)).toEqual([
    { business: "browser" },
    { business: "browser" },
  ]);
  expect(telemetry.results.map((result: any) => result.target)).toEqual(["login", "orders"]);
  expect(telemetry.guards).toEqual(["login", "orders"]);
});
