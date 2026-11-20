import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, page, tab, popup } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";
const component = { render: () => null };
const make = async (options = {}) => {
  const stack = createPageStack({
    pages: { home: tab(component), a: page(component), login: page(component) },
    initial: [{ name: "home" }],
    onError: () => {},
    ...options,
  });
  await stack.ready;
  return stack;
};

test("动态普通页保留配置和参数，超出渲染深度后仍可重建", async () => {
  const stack = await make({ renderDepth: 1 });
  let entered = 0;
  const result = await stack.pushDynamic(
    page(component, {
      meta: { title: "dynamic" },
      beforeEnter: () => {
        entered++;
      },
    }),
    { id: 7 },
  );
  assert.equal(result.status, "completed");
  const route = stack.getSnapshot().current;
  assert.equal(route.meta.title, "dynamic");
  assert.equal(route.params.id, 7);
  await stack.push({ name: "a" });
  await stack.back();
  assert.equal(stack.getSnapshot().current.id, route.id);
  assert.equal(entered, 2);
  await stack.back();
  assert.equal((await stack.push({ name: route.name })).error.code, "UNKNOWN_PAGE");
});
test("动态弹窗关闭后释放定义和实例", async () => {
  const stack = await make();
  const params = { callback: () => true };
  await stack.openDynamicPopup(popup(component), params);
  const route = stack.getSnapshot().top;
  assert.equal(route.params, params);
  await stack.closePopup();
  assert.equal((await stack.openPopup({ name: route.name })).error.code, "UNKNOWN_PAGE");
});
test("动态目标经过登录拦截后定义仍可用于恢复", async () => {
  const stack = await make();
  let loggedIn = false;
  stack.beforeEach(({ to }) => {
    if (to.meta.auth && !loggedIn) return { name: "login" };
  });
  await stack.pushDynamic(page(component, { meta: { auth: true } }), {
    id: 42,
  });
  assert.equal(stack.getSnapshot().current.name, "login");
  loggedIn = true;
  await stack.resume();
  assert.equal(stack.getSnapshot().current.params.id, 42);
  assert.equal(
    stack.getSnapshot().history.some((r) => r.name === "login"),
    false,
  );
});
test("弹窗深度预算超限返回明确错误且已有弹窗保持不变", async () => {
  const stack = await make({ maxPopups: 2 });
  await stack.openDynamicPopup(popup(component));
  await stack.openDynamicPopup(popup(component));
  const before = stack.getSnapshot();
  const result = await stack.openDynamicPopup(popup(component));
  assert.equal(result.error.code, "POPUP_LIMIT");
  assert.deepEqual(result.state.popups, before.popups);
});
test("返回守卫能读取真实原因和实际回退层数", async () => {
  const stack = await make();
  await stack.push({ name: "a" });
  await stack.push({ name: "a" });
  let context;
  controllerFor(stack).guard(stack.getSnapshot().top.id, "back", (value) => {
    context = value;
    return false;
  });
  await stack.back(99, { reason: "native" });
  assert.equal(context.reason, "native");
  assert.equal(context.delta, 2);
});
test("恢复时转场源是当前登录页，隐藏原页面不会重复执行离开守卫", async () => {
  const stack = await make();
  let approved = false,
    leaves = 0;
  controllerFor(stack).guard(stack.getSnapshot().top.id, "leave", () => {
    leaves++;
  });
  stack.beforeEach(({ to }) => {
    if (to.name === "a" && !approved) return { name: "login" };
  });
  await stack.push({ name: "a" });
  assert.equal(leaves, 1);
  let from;
  const detach = controllerFor(stack).attachRenderer(async (request) => {
    from = request.from.name;
    return true;
  });
  approved = true;
  await stack.resume();
  detach();
  assert.equal(from, "login");
  assert.equal(leaves, 1);
});
