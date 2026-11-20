import test from "node:test";
import assert from "node:assert/strict";
import { BehaviorSubject, EMPTY, Subject, of, throwError } from "rxjs";
import { createPageStack, definePages, page, tab, popup } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";

const component = { render: () => null };
const names = (items) => items.map((r) => r.name);
const history = (stack) => names(stack.getSnapshot().history);
const visible = (stack) =>
  stack
    .getSnapshot()
    .rendered.filter((p) => p.visible)
    .map((p) => p.route.name)
    .sort();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function fixture(options = {}) {
  const errors = [];
  const pages = definePages({
    home: tab(component),
    orders: tab(component, { meta: { auth: true } }),
    a: page(component),
    b: page(component),
    login: page(component),
    cached: page(component, { cache: true }),
    dialog: popup(component),
    confirm: popup(component),
  });
  const stack = createPageStack({
    pages,
    initial: [{ name: "home" }],
    onError: (d) => errors.push(d),
    ...options,
  });
  return { stack, errors };
}
async function initialized(options) {
  const f = fixture(options);
  assert.equal((await f.stack.ready).status, "completed");
  return f;
}
function hook(stack, name, kind, callback) {
  const route = stack.getSnapshot().rendered.find((p) => p.route.name === name).route;
  const binding = controllerFor(stack).hook(route.id, kind, callback);
  binding.activate();
  return binding.remove;
}
function guard(stack, kind, callback) {
  const id = stack.getSnapshot().top.id;
  return controllerFor(stack).guard(id, kind, callback);
}

test("基础导航结果和逻辑历史", async () => {
  const { stack } = await initialized();
  assert.equal((await stack.back()).status, "noop");
  assert.equal((await stack.back()).reason, "root");
  assert.equal((await stack.push({ name: "a" })).status, "completed");
  assert.deepEqual(history(stack), ["home", "a"]);
  await stack.replace({ name: "b" });
  assert.deepEqual(history(stack), ["home", "b"]);
  await stack.back();
  assert.deepEqual(history(stack), ["home"]);
  await stack.reset(Object.freeze([{ name: "a" }, { name: "b" }]));
  assert.deepEqual(history(stack), ["a", "b"]);
  await stack.switchTab({ name: "orders" });
  assert.deepEqual(history(stack), ["orders"]);
});
test("同名普通页默认拥有独立实例，返回保留正确参数", async () => {
  const { stack } = await initialized({ renderDepth: "all" });
  await stack.push({ name: "a", params: { value: 1 } });
  await stack.push({ name: "a", params: { value: 2 } });
  const entries = stack.getSnapshot().history.slice(1);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.notEqual(entries[0].key, entries[1].key);
  await stack.back();
  assert.equal(stack.getSnapshot().current.params.value, 1);
});
test("重复显式 key 失败且无状态破坏", async () => {
  const { stack } = await initialized();
  await stack.push({ name: "a", key: "one" });
  const state = stack.getSnapshot();
  const result = await stack.push({ name: "a", key: "one" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "DUPLICATE_KEY");
  assert.deepEqual(stack.getSnapshot().history, state.history);
});
test("所有 reset 目标都经过守卫且输入数组保持不变", async () => {
  const { stack } = await initialized();
  const called = [];
  stack.beforeEach(({ to }) => {
    called.push(to.name);
    return to.name !== "a";
  });
  const input = Object.freeze([Object.freeze({ name: "a" }), Object.freeze({ name: "b" })]);
  const result = await stack.reset(input);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(called, ["a"]);
  assert.deepEqual(history(stack), ["home"]);
  assert.equal(input[1].name, "b");
});
test("非法 API 种类、未知路由和空 reset 都返回可分辨的失败", async () => {
  const { stack } = await initialized();
  for (const [action, code] of [
    [() => stack.push({ name: "dialog" }), "INVALID_KIND"],
    [() => stack.switchTab({ name: "a" }), "INVALID_KIND"],
    [() => stack.openPopup({ name: "home" }), "INVALID_KIND"],
    [() => stack.push({ name: "missing" }), "UNKNOWN_PAGE"],
    [() => stack.reset([]), "INVALID_ROUTE"],
  ]) {
    const result = await action();
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, code);
  }
  assert.deepEqual(history(stack), ["home"]);
});
test("多层弹窗正确排序、显示背景且 back 优先关闭顶部", async () => {
  const { stack } = await initialized();
  await stack.openPopup({ name: "dialog" });
  await stack.openPopup({ name: "confirm" });
  assert.deepEqual(names(stack.getSnapshot().layers), ["home", "dialog", "confirm"]);
  assert.deepEqual(visible(stack), ["confirm", "dialog", "home"]);
  assert.equal(stack.getSnapshot().rendered.filter((p) => p.focused).length, 1);
  await stack.back(8);
  assert.deepEqual(names(stack.getSnapshot().popups), ["dialog"]);
  assert.deepEqual(visible(stack), ["dialog", "home"]);
  await stack.closePopup();
  assert.equal(stack.getSnapshot().canGoBack, false);
});
test("拒绝或异常的导航保留弹窗和实例", async () => {
  const { stack } = await initialized();
  await stack.openPopup({ name: "dialog" });
  const state = stack.getSnapshot();
  const remove = stack.beforeEach(() => false);
  assert.equal((await stack.push({ name: "a" })).status, "cancelled");
  remove();
  const removeThrow = stack.beforeEach(() => {
    throw new Error("boom");
  });
  assert.equal((await stack.push({ name: "a" })).status, "failed");
  removeThrow();
  assert.deepEqual(stack.getSnapshot().history, state.history);
  assert.deepEqual(stack.getSnapshot().popups, state.popups);
  assert.deepEqual(visible(stack), ["dialog", "home"]);
});
test("关闭自动关弹窗后，经典导航仍保留弹窗可见性与焦点", async () => {
  const { stack } = await initialized({ closePopupsOnNavigate: false });
  await stack.openPopup({ name: "dialog" });
  await stack.push({ name: "a" });
  assert.deepEqual(visible(stack), ["a", "dialog"]);
  assert.equal(stack.getSnapshot().top.name, "dialog");
});
test("Tab 根和渲染深度均生效，超出深度实例回收但历史保留", async () => {
  for (const keepTabRoot of [true, false]) {
    const { stack } = await initialized({ renderDepth: 1, keepTabRoot });
    await stack.push({ name: "a" });
    let unloads = 0;
    hook(stack, "a", "unload", () => unloads++);
    await stack.push({ name: "b" });
    assert.deepEqual(names(stack.getSnapshot().layers), keepTabRoot ? ["home", "b"] : ["b"]);
    assert.equal(unloads, 1);
    assert.deepEqual(history(stack), ["home", "a", "b"]);
    await stack.back();
    assert.equal(stack.getSnapshot().current.name, "a");
  }
});
test("缓存上限和显式清理不会删除逻辑历史", async () => {
  const { stack } = await initialized({
    renderDepth: 1,
    maxCachedPages: 1,
    keepTabRoot: false,
  });
  await stack.push({ name: "cached", key: "first" });
  await stack.push({ name: "cached", key: "second" });
  await stack.push({ name: "b" });
  assert.equal(stack.getSnapshot().rendered.length, 2);
  const before = stack.getSnapshot().history;
  assert.equal(await stack.clearCache(), 1);
  assert.deepEqual(stack.getSnapshot().history, before);
});
test("普通历史深度有界并保留 Tab 逻辑根", async () => {
  const { stack } = await initialized({ maxHistory: 2 });
  await stack.push({ name: "a" });
  await stack.push({ name: "a" });
  await stack.push({ name: "b" });
  assert.deepEqual(history(stack), ["home", "a", "b"]);
});
test("实例隔离与不可写快照", async () => {
  const { stack: left } = await initialized();
  const { stack: right } = await initialized();
  left.beforeEach(() => false);
  assert.equal((await left.push({ name: "a" })).status, "cancelled");
  await right.push({ name: "b" });
  assert.deepEqual(history(left), ["home"]);
  assert.deepEqual(history(right), ["home", "b"]);
  assert.throws(() => right.getSnapshot().history.push({}), TypeError);
  assert.throws(() => {
    right.getSnapshot().current.name = "bad";
  }, TypeError);
  assert.equal("records" in right, false);
  assert.equal("state" in right, false);
});
test("重定向重新检查全部守卫且循环有界", async () => {
  const { stack } = await initialized({ maxRedirects: 3 });
  const called = [];
  const first = stack.beforeEach(({ to }) => {
    called.push(`1:${to.name}`);
    if (to.name === "a") return { name: "b" };
  });
  const second = stack.beforeEach(({ to }) => {
    called.push(`2:${to.name}`);
    if (to.name === "b") return false;
  });
  assert.equal((await stack.push({ name: "a" })).status, "cancelled");
  assert.deepEqual(called, ["1:a", "1:b", "2:b"]);
  first();
  second();
  stack.beforeEach(({ to }) => ({ name: to.name === "a" ? "b" : "a" }));
  const result = await stack.push({ name: "a" });
  assert.equal(result.error.code, "REDIRECT_LIMIT");
});
for (const operation of ["push", "replace", "switchTab", "reset", "openPopup"]) {
  test(`拦截恢复完整 ${operation} 意图且移除承接页`, async () => {
    const { stack } = await initialized();
    await stack.push({ name: "b" });
    let loggedIn = false;
    stack.beforeEach(({ to }) => {
      if (!loggedIn && ["orders", "a", "dialog"].includes(to.name)) return { name: "login" };
    });
    const target = {
      name: operation === "switchTab" ? "orders" : operation === "openPopup" ? "dialog" : "a",
      params: { id: 7 },
    };
    const result = await (operation === "reset"
      ? stack.reset([{ name: "home" }, target])
      : stack[operation](target));
    assert.equal(result.status, "completed");
    assert.equal(stack.getSnapshot().top.name, "login");
    const resumed = await stack.resume();
    assert.equal(resumed.state.top.name, "login");
    loggedIn = true;
    assert.equal((await stack.resume()).status, "completed");
    assert.equal(history(stack).includes("login"), false);
    assert.equal(stack.getSnapshot().top.name, target.name);
    assert.equal(stack.getSnapshot().top.params.id, 7);
    assert.deepEqual(
      history(stack),
      operation === "switchTab"
        ? ["orders"]
        : operation === "replace"
          ? ["home", "a"]
          : operation === "reset"
            ? ["home", "a"]
            : operation === "openPopup"
              ? ["home", "b"]
              : ["home", "b", "a"],
    );
  });
}
for (const [label, make, allowed] of [
  ["of true", () => of(true), true],
  ["of false", () => of(false), false],
  ["EMPTY", () => EMPTY, true],
  ["undefined 首值", () => of(undefined), true],
  ["error", () => throwError(() => new Error("source")), false],
  ["同步长期订阅", () => new BehaviorSubject(false), false],
]) {
  test(`Observable 返回守卫：${label}`, async () => {
    const { stack } = await initialized();
    await stack.push({ name: "a" });
    const source = make();
    guard(stack, "back", () => source);
    const result = await stack.back();
    assert.equal(stack.getSnapshot().current.name, allowed ? "home" : "a");
    if (source instanceof BehaviorSubject) assert.equal(source.observers.length, 0);
    assert.ok(["completed", "cancelled", "failed"].includes(result.status));
  });
}
test("异步 Observable 首值后退订，重复通知不改变结果", async () => {
  const { stack } = await initialized();
  await stack.push({ name: "a" });
  const subject = new Subject();
  guard(stack, "back", () => subject);
  const pending = stack.back();
  await tick();
  assert.equal(subject.observers.length, 1);
  subject.next(false);
  subject.next(true);
  await pending;
  assert.equal(subject.observers.length, 0);
  assert.equal(stack.getSnapshot().current.name, "a");
});
test("守卫超时退订并且后续导航可以继续", async () => {
  const { stack } = await initialized({ guardTimeoutMs: 10 });
  const source = new Subject();
  const remove = stack.beforeEach(() => source);
  const result = await stack.push({ name: "a" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "GUARD_TIMEOUT");
  assert.equal(source.observers.length, 0);
  remove();
  assert.equal((await stack.push({ name: "b" })).status, "completed");
});
test("中止排队或运行中的守卫不修改原栈", async () => {
  const { stack } = await initialized();
  const source = new Subject();
  const remove = stack.beforeEach(() => source);
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = stack.push({ name: "a" }, { signal: firstAbort.signal });
  const second = stack.push({ name: "b" }, { signal: secondAbort.signal });
  await tick();
  secondAbort.abort();
  firstAbort.abort();
  assert.equal((await first).reason, "aborted");
  assert.equal((await second).reason, "aborted");
  assert.deepEqual(history(stack), ["home"]);
  assert.equal(source.observers.length, 0);
  remove();
});
test("动画异常降级完成，旧实例清理且队列继续", async () => {
  const { stack, errors } = await initialized();
  const detach = controllerFor(stack).attachRenderer(async () => {
    throw new Error("driver");
  });
  const result = await stack.replace({ name: "a" });
  assert.equal(result.status, "completed");
  assert.equal(result.transition, "failed");
  assert.deepEqual(history(stack), ["a"]);
  assert.deepEqual(visible(stack), ["a"]);
  assert.equal(errors.at(-1).error.code, "TRANSITION_ERROR");
  detach();
  assert.equal((await stack.push({ name: "b" })).status, "completed");
});
test("动画永不结束时超时降级并中止驱动", async () => {
  const { stack } = await initialized({ transitionTimeoutMs: 10 });
  let aborted = false;
  controllerFor(stack).attachRenderer(async ({ signal }) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise(() => {});
  });
  const result = await stack.push({ name: "a" });
  assert.equal(result.transition, "timed-out");
  assert.equal(aborted, true);
  assert.deepEqual(visible(stack), ["a"]);
  assert.equal(stack.getSnapshot().phase, "idle");
});
test("渲染器卸载会中止动画并完成最终同步", async () => {
  const { stack } = await initialized();
  const detach = controllerFor(stack).attachRenderer(async () => new Promise(() => {}));
  const pending = stack.push({ name: "a" });
  await tick();
  detach();
  const result = await pending;
  assert.equal(result.transition, "interrupted");
  assert.deepEqual(visible(stack), ["a"]);
});
test("深度为 1 的 push 动画期间 source 和 target 同时可见", async () => {
  const { stack } = await initialized({ renderDepth: 1, keepTabRoot: false });
  let done;
  const detach = controllerFor(stack).attachRenderer(
    async () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const pending = stack.push({ name: "a" });
  await tick();
  assert.deepEqual(visible(stack), ["a", "home"]);
  done(true);
  await pending;
  detach();
  assert.deepEqual(visible(stack), ["a"]);
});
test("销毁取消当前和排队任务并卸载所有实例", async () => {
  const { stack } = await initialized();
  let unloaded = 0;
  hook(stack, "home", "unload", () => unloaded++);
  stack.beforeEach(() => new Promise(() => {}));
  const first = stack.push({ name: "a" });
  const second = stack.push({ name: "b" });
  await tick();
  stack.dispose();
  assert.equal((await first).reason, "disposed");
  const queued = await second;
  assert.equal(queued.reason, "disposed");
  assert.equal(queued.state.disposed, true);
  assert.equal(unloaded, 1);
  assert.equal(stack.getSnapshot().rendered.length, 0);
  assert.equal((await stack.push({ name: "a" })).reason, "disposed");
});
test("生命周期及订阅者异常不会破坏卸载或后续通知", async () => {
  const { stack, errors } = await initialized();
  let called = 0;
  hook(stack, "home", "unload", () => {
    throw new Error("hook");
  });
  hook(stack, "home", "unload", () => {
    called++;
  });
  stack.subscribe(() => {
    throw new Error("subscriber");
  });
  stack.subscribe(() => {
    called++;
  });
  stack.dispose();
  assert.ok(called >= 2);
  assert.ok(errors.some((d) => d.error.code === "HOOK_ERROR"));
  assert.ok(errors.some((d) => d.error.code === "SUBSCRIBER_ERROR"));
});
