import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, page, tab, popup, definePages, isPage } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";
const component = { render: () => null };
const pages = definePages({
  home: tab(component),
  a: page(component),
  b: page(component),
  popup: popup(component),
});
const make = async (options = {}) => {
  const s = createPageStack({
    pages,
    initial: [{ name: "home" }],
    onError: () => {},
    ...options,
  });
  await s.ready;
  return s;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("ready 明确区分空会话、初始拒绝、失败和重定向，失败后仍可导航", async () => {
  const empty = createPageStack({ pages, onError: () => {} });
  assert.equal((await empty.ready).reason, "empty");
  assert.equal(isPage(empty, undefined, "home"), false);
  empty.dispose();
  let allow = false;
  const rejected = createPageStack({
    pages,
    initial: [{ name: "home" }],
    beforeEach: () => allow,
    onError: () => {},
  });
  assert.equal((await rejected.ready).status, "cancelled");
  assert.equal(rejected.getSnapshot().history.length, 0);
  allow = true;
  assert.equal((await rejected.reset([{ name: "home" }])).status, "completed");
  assert.equal(isPage(rejected, rejected.getSnapshot().current, "home"), true);
  assert.equal(isPage(rejected, rejected.getSnapshot().current, "a"), false);
  rejected.dispose();
  const failed = createPageStack({ pages, initial: [{ name: "missing" }], onError: () => {} });
  assert.equal((await failed.ready).error.code, "UNKNOWN_PAGE");
  assert.equal(failed.getSnapshot().history.length, 0);
  assert.equal((await failed.reset([{ name: "home" }])).status, "completed");
  failed.dispose();
  const redirected = createPageStack({
    pages,
    initial: [{ name: "a" }],
    beforeEach: ({ to }) => (to.name === "a" ? { name: "home" } : undefined),
    onError: () => {},
  });
  assert.equal((await redirected.ready).redirected, true);
  assert.equal(redirected.getSnapshot().current.name, "home");
  redirected.dispose();
});

test("嵌套同步导航给出明确错误，异步守卫也不会等待自身队列", async () => {
  const stack = await make({ guardTimeoutMs: 100 });
  let nested;
  let remove = stack.beforeEach(() => {
    nested = stack.push({ name: "b" });
    return false;
  });
  assert.equal((await stack.push({ name: "a" })).status, "cancelled");
  assert.equal((await nested).error.code, "REENTRANT_NAVIGATION");
  remove();
  remove = stack.beforeEach(async () => {
    await Promise.resolve();
    nested = await stack.push({ name: "b" });
    return false;
  });
  const result = await stack.push({ name: "a" });
  assert.equal(result.status, "cancelled");
  assert.equal(nested.reason, "busy");
  remove();
  assert.equal(stack.getSnapshot().current.name, "home");
});
test("在守卫检查期间外部新点击返回 busy，中止后可以继续", async () => {
  const stack = await make();
  const remove = stack.beforeEach(() => new Promise(() => {}));
  const pending = stack.push({ name: "a" });
  await tick();
  assert.equal((await stack.push({ name: "b" })).reason, "busy");
  stack.cancel();
  assert.equal((await pending).reason, "aborted");
  remove();
  assert.equal((await stack.push({ name: "b" })).status, "completed");
});
test("同时发起的导航串行执行，排队期间可独立中止", async () => {
  const stack = await make();
  let release;
  const detach = controllerFor(stack).attachRenderer(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = stack.push({ name: "a" });
  await tick();
  const abort = new AbortController();
  const second = stack.push({ name: "b" }, { signal: abort.signal });
  abort.abort();
  assert.equal((await second).reason, "aborted");
  release(true);
  assert.equal((await first).status, "completed");
  detach();
  assert.equal(stack.getSnapshot().current.name, "a");
});
test("队列容量有界且不会污染已接受的导航", async () => {
  const stack = await make({ maxQueue: 1 });
  let release;
  const detach = controllerFor(stack).attachRenderer(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = stack.push({ name: "a" });
  await tick();
  const second = stack.push({ name: "b" });
  const excess = await stack.push({ name: "a" });
  assert.equal(excess.error.code, "QUEUE_FULL");
  release(true);
  await first;
  detach();
  await second;
  assert.equal(stack.getSnapshot().current.name, "b");
});
test("参数校验错误、只读数组和无效 JS 输入保持统一结果", async () => {
  const stack = await make({
    pages: {
      ...pages,
      checked: page(component, {
        validate: (p) => typeof p?.id === "number" || "id is required",
      }),
    },
  });
  assert.equal((await stack.push({ name: "checked", params: {} })).error.code, "INVALID_ROUTE");
  assert.equal((await stack.reset({ name: "a" })).status, "failed");
  assert.equal((await stack.push({ name: "a" }, { signal: {} })).status, "failed");
  for (const options of [
    null,
    4,
    { signal: null },
    {
      get signal() {
        throw new Error("getter");
      },
    },
  ]) {
    assert.equal((await stack.push({ name: "a" }, options)).status, "failed");
  }
  assert.equal(
    (await stack.reset(Object.freeze([Object.freeze({ name: "a" })]))).status,
    "completed",
  );
});
test("back 的非法 delta 在根页和弹窗上都一致拒绝", async () => {
  const stack = await make();
  for (const popupShown of [false, true]) {
    if (popupShown) await stack.openPopup({ name: "popup" });
    for (const delta of [0, -1, NaN, Infinity, 0.5])
      assert.equal((await stack.back(delta)).error.code, "INVALID_ROUTE");
  }
});
test("配置错误在创建阶段明确拒绝", () => {
  for (const options of [
    { maxHistory: 0 },
    { renderDepth: 0 },
    { maxCachedPages: -1 },
    { keepTabRoot: "false" },
  ]) {
    assert.throws(
      () => createPageStack({ pages, ...options }),
      (e) => e.code === "INVALID_CONFIG",
    );
  }
  assert.throws(
    () => createPageStack({ pages: {} }),
    (e) => e.code === "INVALID_CONFIG",
  );
});
test("注销守卫和订阅会立即生效，其他实例不受影响", async () => {
  const a = await make();
  const b = await make();
  let updates = 0;
  const unsubscribe = a.subscribe(() => updates++);
  unsubscribe();
  const remove = a.beforeEach(() => false);
  remove();
  await a.push({ name: "a" });
  assert.equal(updates, 0);
  assert.equal(b.getSnapshot().current.name, "home");
});
test("reset clearCache 重新创建根页面，清除旧账户缓存", async () => {
  const stack = await make();
  const previous = stack.getSnapshot().current;
  await stack.push({ name: "a" });
  const result = await stack.reset([{ name: "home" }], { clearCache: true });
  assert.equal(result.status, "completed");
  assert.notEqual(stack.getSnapshot().current.id, previous.id);
  assert.equal(stack.getSnapshot().rendered.length, 1);
});
test("销毁重复调用幂等，所有取消结果携带已销毁快照", async () => {
  const stack = await make();
  stack.dispose();
  stack.dispose();
  const result = await stack.back();
  assert.equal(result.reason, "disposed");
  assert.equal(result.state.disposed, true);
  assert.equal(result.state.pending, undefined);
});
test("idle 观察者在结果交付前销毁实例时，不交付 completed 的已销毁快照", async () => {
  const stack = await make();
  stack.subscribe((state) => {
    if (state.phase === "idle" && state.current?.name === "a") stack.dispose();
  });
  const result = await stack.push({ name: "a" });
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "disposed");
  assert.equal(result.state.disposed, true);
});
test("构造和回调注册拒绝未知选项及无效回调", async () => {
  for (const options of [
    { maxHistory: null },
    { onError: false },
    { beforeEach: 4 },
    { closePopOnNavigate: false },
  ]) {
    assert.throws(
      () => createPageStack({ pages, ...options }),
      (e) => e.code === "INVALID_CONFIG",
    );
  }
  const stack = await make();
  for (const register of [stack.beforeEach, stack.subscribe, stack.onError])
    assert.throws(
      () => register(null),
      (e) => e.code === "INVALID_CONFIG",
    );
});
test("超出平台范围的 deadline 明确拒绝，异步 validator 不会被误当作放行", async () => {
  assert.throws(
    () => createPageStack({ pages, guardTimeoutMs: 2 ** 31 }),
    (e) => e.code === "INVALID_CONFIG",
  );
  const stack = await make({
    pages: { ...pages, invalid: page(component, { validate: async () => false }) },
  });
  const result = await stack.push({ name: "invalid" });
  assert.equal(result.error.code, "INVALID_ROUTE");
  assert.equal(stack.getSnapshot().current.name, "home");
});
test("只设置较长动画时长时，默认 deadline 不会在 2 秒提前终止", async () => {
  const stack = await make({ transitionDurationMs: 2_200 });
  const detach = controllerFor(stack).attachRenderer(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2_150));
    return true;
  });
  const result = await stack.push({ name: "a" });
  detach();
  assert.equal(result.status, "completed");
  assert.equal(result.transition, "completed");
});
