import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, tab, page, popup, handleNativeBack } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";
const component = { render: () => null };
async function make() {
  const errors = [];
  const stack = createPageStack({
    pages: {
      home: tab(component),
      a: page(component),
      dialog: popup(component),
    },
    initial: [{ name: "home" }],
    onError: (d) => errors.push(d),
  });
  await stack.ready;
  return { stack, errors };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("根页允许宿主退出，弹窗和普通页由网页立即接管", async () => {
  const { stack } = await make();
  assert.equal(handleNativeBack(stack), "exit");
  await stack.openPopup({ name: "dialog" });
  assert.equal(handleNativeBack(stack), "handled");
  await tick();
  assert.equal(stack.getSnapshot().top.name, "home");
  await stack.push({ name: "a" });
  assert.equal(handleNativeBack(stack), "handled");
  await tick();
  assert.equal(stack.getSnapshot().top.name, "home");
});
test("慢速或拒绝守卫不延迟桥接应答，也不触发原生超时兜底", async () => {
  const { stack } = await make();
  await stack.push({ name: "a" });
  let decide;
  controllerFor(stack).guard(
    stack.getSnapshot().top.id,
    "back",
    () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  );
  assert.equal(handleNativeBack(stack), "handled");
  await tick();
  assert.equal(stack.getSnapshot().phase, "guard");
  assert.equal(stack.getSnapshot().top.name, "a");
  decide(false);
  await tick();
  assert.equal(stack.getSnapshot().top.name, "a");
});
test("有排队导航时根页也不能立即退出", async () => {
  const { stack } = await make();
  const pending = stack.push({ name: "a" });
  assert.equal(stack.getSnapshot().busy, true);
  assert.equal(stack.getSnapshot().queued, 1);
  assert.equal(handleNativeBack(stack), "handled");
  await pending;
  await tick();
  assert.equal(stack.getSnapshot().top.name, "home");
  assert.equal(stack.getSnapshot().busy, false);
});
test("再次原生返回可以中止尚未提交的检查", async () => {
  const { stack } = await make();
  stack.beforeEach(() => new Promise(() => {}));
  const pending = stack.push({ name: "a" });
  await tick();
  assert.equal(handleNativeBack(stack), "handled");
  assert.equal((await pending).reason, "aborted");
  assert.equal(handleNativeBack(stack), "exit");
});
