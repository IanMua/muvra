import test from "node:test";
import assert from "node:assert/strict";
import { Subject, EMPTY, of } from "rxjs";
import { createPageStack, definePages, page, popup, tab } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";

const component = { render: () => null };
const tick = () => new Promise((done) => setTimeout(done, 0));

// 从公开调用、守卫和事件交叉检查数据流，避免仅检查内部字段赋值。
function fixture(options = {}) {
  const events = [];
  const errors = [];
  const pages = definePages({
    home: tab(component),
    orders: tab(component),
    a: page(component),
    b: page(component),
    login: page(component, { cache: true }),
    dialog: popup(component),
  });
  const stack = createPageStack({
    pages,
    onNavigation: (event) => events.push(event),
    onError: (error) => errors.push(error),
    ...options,
  });
  return { stack, events, errors };
}
function assertPairs(events) {
  for (const id of new Set(events.map((event) => event.id))) {
    const pair = events.filter((event) => event.id === id);
    assert.deepEqual(
      pair.map((event) => event.type),
      ["requested", "settled"],
    );
    assert.equal(pair[1].result.id, id);
    assert.equal(pair[1].result.info, pair[1].info);
  }
}

test("info 仅属于本次导航，全部守卫和结果透传同一引用，页面参数与 meta 不受影响", async () => {
  const calls = [];
  const { stack, events } = fixture();
  await stack.reset([{ name: "home" }]);
  const binding = controllerFor(stack).guard(stack.getSnapshot().top.id, "leave", (guard) => {
    calls.push(["leave", guard.info]);
  });
  stack.beforeEach((guard) => calls.push(["enter", guard.info]) && undefined);
  const info = { marker: Symbol("business"), run: () => 1 };
  info.self = info;
  const params = { value: "page" };
  const result = await stack.push({ name: "a", params }, { info });
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["enter", "leave"],
  );
  assert.ok(calls.every(([, value]) => value === info));
  assert.equal(result.info, info);
  assert.equal(result.state.top.params, params);
  assert.equal(Object.hasOwn(result.state.top, "info"), false);
  assert.equal(Object.isFrozen(info), false);
  binding();
  assert.equal((await stack.push({ name: "b" })).info, undefined);
  assertPairs(events);
  stack.dispose();
});

test("全局前置处理按注册顺序且每次执行一次，reset 多目标与重定向不重复执行", async () => {
  const prepared = { tag: "prepared" };
  const log = [];
  const { stack, events } = fixture({
    beforeNavigate: ({ info }) => {
      log.push(["prepare", info]);
      return { info: prepared };
    },
  });
  stack.beforeNavigate(({ info }) => {
    assert.equal(info, prepared);
    log.push(["second", info]);
  });
  stack.beforeEach(({ to, info }) => {
    log.push([to.name, info]);
    if (to.name === "b") return { name: "login" };
  });
  const info = { tag: "input" };
  const result = await stack.reset([{ name: "home" }, { name: "b" }], { info });
  assert.deepEqual(
    log.map(([kind]) => kind),
    ["prepare", "second", "home", "b", "login"],
  );
  assert.equal(result.redirected, true);
  assert.equal(result.info, prepared);
  assert.equal(events[0].info, info);
  assert.equal(events[0].routes[1].name, "b");
  assert.equal(events[1].routes[1].name, "b");
  assert.equal(events[1].result.state.top.name, "login");
  assertPairs(events);
  stack.dispose();
});

test("初始导航可在配置中处理和观察；空 ready 不伪造导航事件", async () => {
  const first = fixture();
  await first.stack.ready;
  assert.equal(first.events.length, 0);
  first.stack.dispose();
  const info = new Map([["startup", 1]]);
  const configured = fixture({ initial: [{ name: "home" }], beforeNavigate: () => ({ info }) });
  assert.equal((await configured.stack.ready).info, info);
  assertPairs(configured.events);
  assert.equal(configured.events.length, 2);
  configured.stack.dispose();
});

test("普通、动态、Tab、弹窗及返回操作均产生独立 info 和唯一事件对", async () => {
  const { stack, events } = fixture();
  const callbacks = [];
  stack.beforeEach(({ info }) => {
    callbacks.push(info);
  });
  const calls = [
    (info) => stack.reset([{ name: "home" }], { info }),
    (info) => stack.push({ name: "a" }, { info }),
    (info) => stack.replace({ name: "b" }, { info }),
    (info) => stack.openPopup({ name: "dialog" }, { info }),
    (info) => stack.closePopup({ info }),
    (info) => stack.back(1, { info }),
    (info) => stack.switchTab({ name: "orders" }, { info }),
    (info) => stack.pushDynamic(page(component), undefined, { info }),
    (info) => stack.openDynamicPopup(popup(component), undefined, { info }),
  ];
  for (const [index, call] of calls.entries()) {
    const info = { index };
    const result = await call(info);
    assert.equal(result.status, "completed");
    assert.equal(result.info, info);
    assert.equal(callbacks.at(-1), info);
  }
  assert.equal(events.length, calls.length * 2);
  assertPairs(events);
  stack.dispose();
});

test("前置取消、抛错、非法返回、超时和 Observable 首值均使用统一结果", async () => {
  for (const [handler, status, code] of [
    [() => false, "cancelled", undefined],
    [
      () => {
        throw Error("prepare failed");
      },
      "failed",
      "GUARD_ERROR",
    ],
    [() => ({ route: { name: "a" } }), "failed", "GUARD_ERROR"],
    [() => new Promise(() => {}), "failed", "GUARD_TIMEOUT"],
    [() => EMPTY, "completed", undefined],
    [() => of({ info: 17 }), "completed", undefined],
  ]) {
    const { stack, events } = fixture({ guardTimeoutMs: 10, beforeNavigate: handler });
    const result = await stack.reset([{ name: "home" }], { info: 3 });
    assert.equal(result.status, status);
    if (code) assert.equal(result.error.code, code);
    if (status === "cancelled") assert.equal(result.reason, "guard");
    if (status !== "completed") assert.equal(stack.getSnapshot().history.length, 0);
    assertPairs(events);
    stack.dispose();
  }
});

test("前置处理中止会退订，旧执行的迟到拒绝不污染后续导航", async () => {
  const source = new Subject();
  const { stack, events } = fixture();
  const remove = stack.beforeNavigate(() => source);
  const abort = new AbortController();
  const pending = stack.reset([{ name: "home" }], { info: "first", signal: abort.signal });
  await tick();
  assert.equal(source.observers.length, 1);
  abort.abort();
  assert.equal((await pending).reason, "aborted");
  assert.equal(source.observers.length, 0);
  remove();
  const second = await stack.reset([{ name: "home" }], { info: "second" });
  assert.equal(second.info, "second");
  assertPairs(events);
  stack.dispose();
});

test("接纳失败和排队取消仍可全局观察，未执行的请求不运行前置处理", async () => {
  const { stack, events } = fixture({ maxQueue: 1 });
  let count = 0;
  stack.beforeNavigate(() => {
    count++;
  });
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await stack.push({ name: "a" }, { info: "aborted", signal: abort.signal })).reason,
    "aborted",
  );
  assert.equal(
    (await stack.push({ name: "a" }, { info: "invalid", reason: "bad" })).status,
    "failed",
  );
  assert.equal((await stack.pushDynamic({}, undefined, { info: "dynamic" })).status, "failed");
  const waitingAbort = new AbortController();
  const waiting = stack.reset([{ name: "home" }], { info: "waiting", signal: waitingAbort.signal });
  const fullPending = stack.push({ name: "a" }, { info: "full" });
  waitingAbort.abort();
  const full = await fullPending;
  assert.equal(full.error.code, "QUEUE_FULL");
  assert.equal((await waiting).reason, "aborted");
  assert.equal(count, 0);
  const remove = stack.beforeNavigate(() => new Promise(() => {}));
  const running = stack.reset([{ name: "home" }], { info: "running" });
  await tick();
  assert.equal((await stack.push({ name: "b" }, { info: "busy" })).reason, "busy");
  stack.cancel();
  await running;
  remove();
  assertPairs(events);
  assert.ok(events.some((e) => e.type === "settled" && e.info === "dynamic"));
  stack.dispose();
});

for (const operation of ["push", "replace", "reset", "switchTab", "openPopup"]) {
  test(`恢复 ${operation} 保留 info、关联原执行并重新预处理，成功消费缓存承接页拦截`, async () => {
    const { stack, events } = fixture();
    await stack.reset([{ name: "home" }]);
    let allow = false;
    const prepared = [];
    stack.beforeNavigate((navigation) => {
      prepared.push(navigation);
    });
    stack.beforeEach(({ to, info }) => {
      if (["a", "orders", "dialog"].includes(to.name)) {
        assert.equal(info, payload);
        if (!allow) return { name: "login", key: "auth" };
      }
    });
    const payload = { request: operation };
    const target = {
      name: operation === "switchTab" ? "orders" : operation === "openPopup" ? "dialog" : "a",
    };
    const first = await (operation === "reset"
      ? stack.reset([{ name: "home" }, target], { info: payload })
      : stack[operation](target, { info: payload }));
    const loginId = stack.getSnapshot().top.id;
    const denied = await stack.resume();
    assert.equal(denied.info, payload);
    assert.equal(denied.resumedFromId, first.id);
    allow = true;
    const resumed = await stack.resume();
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.info, payload);
    assert.equal(resumed.resumedFromId, denied.id);
    assert.notEqual(resumed.id, first.id);
    assert.equal(prepared.length, 3);
    assert.equal(prepared[1].route?.name ?? prepared[1].routes?.at(-1).name, target.name);
    assert.equal(controllerFor(stack).record(loginId)?.interception, undefined);
    assert.equal((await stack.resume()).reason, "not-intercepted");
    assertPairs(events);
    stack.dispose();
  });
}

test("恢复可整份替换或显式清空 info，取消和失败不消费原拦截", async () => {
  for (const replacement of [{ changed: true }, undefined, null]) {
    const { stack } = fixture();
    await stack.reset([{ name: "home" }]);
    let allow = false;
    let cancel = false;
    let fail = false;
    stack.beforeEach(({ to }) => {
      if (to.name === "a" && !allow) return { name: "login" };
    });
    const original = { original: true };
    await stack.push({ name: "a" }, { info: original });
    const remove = stack.beforeNavigate(() => {
      if (cancel) return false;
      if (fail) throw Error("retry");
    });
    cancel = true;
    assert.equal((await stack.resume({ info: replacement })).status, "cancelled");
    cancel = false;
    fail = true;
    assert.equal((await stack.resume({ info: replacement })).status, "failed");
    fail = false;
    allow = true;
    assert.equal((await stack.resume()).info, original);
    remove();
    // 新拦截单独验证替换，防止上一次成功恢复留下上下文。
    allow = false;
    await stack.replace({ name: "a", params: {} }, { info: original });
    allow = true;
    assert.equal((await stack.resume({ info: replacement })).info, replacement);
    stack.dispose();
  }
});

test("排队恢复绑定原拦截，承接页被同 key 新拦截复用时不会恢复另一请求", async () => {
  const { stack, events } = fixture();
  await stack.reset([{ name: "home" }]);
  let attempt = 0;
  stack.beforeEach(({ to }) => {
    if (["a", "b"].includes(to.name))
      return { name: "login", key: "auth", params: { attempt: ++attempt } };
  });
  let release;
  const detach = controllerFor(stack).attachRenderer(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  const first = stack.replace({ name: "a" }, { info: "A" });
  await tick();
  const second = stack.replace({ name: "b" }, { info: "B" });
  const stale = stack.resume();
  release();
  await first;
  await second;
  const result = await stale;
  assert.equal(result.reason, "not-intercepted");
  assert.equal(result.info, "A");
  assert.equal(controllerFor(stack).record(stack.getSnapshot().top.id).interception.info, "B");
  assertPairs(events);
  detach();
  stack.dispose();
});

test("导航观察者的同步和异步异常不阻塞导航，诊断保留原导航编号", async () => {
  const { stack, events, errors } = fixture();
  stack.onNavigation(() => {
    throw Error("sync observer");
  });
  stack.onNavigation(async () => {
    await tick();
    throw Error("late observer");
  });
  const first = await stack.reset([{ name: "home" }], { info: "one" });
  const second = await stack.push({ name: "a" }, { info: "two" });
  await tick();
  await tick();
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(errors.length, 8);
  assert.ok(errors.every((e) => [first.id, second.id].includes(e.navigationId)));
  assert.equal(errors.filter((e) => e.navigationId === first.id).length, 4);
  assertPairs(events);
  stack.dispose();
});

test("销毁为活动和排队请求各发一次终态，之后释放订阅并拒绝注册", async () => {
  const { stack, events } = fixture();
  const source = new Subject();
  stack.beforeNavigate(() => source);
  const first = stack.reset([{ name: "home" }], { info: 1 });
  const second = stack.push({ name: "a" }, { info: 2 });
  await tick();
  stack.dispose();
  assert.equal((await first).reason, "disposed");
  assert.equal((await second).reason, "disposed");
  await tick();
  assert.equal(source.observers.length, 0);
  assertPairs(events);
  const length = events.length;
  stack.onNavigation(() => assert.fail("disposed listener"));
  assert.equal((await stack.push({ name: "b" })).reason, "disposed");
  assert.equal(events.length, length);
});

test("requested 回调同步销毁时，所有观察者仍先收到请求再收到终态", async () => {
  const { stack } = fixture();
  const observed = [];
  stack.onNavigation((e) => {
    if (e.type === "requested") stack.dispose();
  });
  stack.onNavigation((e) => observed.push(e));
  const result = await stack.reset([{ name: "home" }]);
  assert.equal(result.reason, "disposed");
  assertPairs(observed);
  assert.equal(observed.length, 2);
});

test("回调可撤销且实例隔离，未配置的实例不继承另一实例的 info 或扩展点", async () => {
  const a = fixture();
  const b = fixture();
  const remove = a.stack.beforeNavigate(() => ({ info: "A" }));
  const stop = a.stack.onNavigation(() => {
    throw Error("removed");
  });
  stop();
  assert.equal((await a.stack.reset([{ name: "home" }])).info, "A");
  assert.equal((await b.stack.reset([{ name: "home" }])).info, undefined);
  remove();
  assert.equal((await a.stack.push({ name: "a" })).info, undefined);
  assert.equal(a.errors.length, 0);
  a.stack.dispose();
  b.stack.dispose();
});

test("没有有效拦截时恢复立即结束，不受另一次导航的 busy 状态影响", async () => {
  const { stack, events } = fixture();
  stack.beforeNavigate(() => new Promise(() => {}));
  const running = stack.reset([{ name: "home" }]);
  await tick();
  const result = await stack.resume({ info: "unused" });
  assert.equal(result.reason, "not-intercepted");
  assert.equal(result.info, "unused");
  stack.cancel();
  await running;
  assertPairs(events);
  stack.dispose();
});
