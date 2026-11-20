import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, definePages, page, popup } from "../dist/index.js";
const component = { render: () => null };

// 移除的配置在 JavaScript 和原始目录入口中都应明确拒绝，不能伪装成仍有作用。
test("页面字段选择已移除，旧配置在声明和目录入口明确拒绝", () => {
  for (const params of [["orderNo"], [], undefined]) {
    assert.throws(
      () => page(component, { params }),
      (error) => error.code === "INVALID_CONFIG",
    );
    assert.throws(
      () => definePages({ order: { kind: "page", component, params } }),
      (error) => error.code === "INVALID_CONFIG",
    );
  }
});
test("显式输入入口复用正常校验、种类和动态导航能力", async () => {
  const definition = page.withParams()(component, {
    validate: (value) => typeof value?.id === "string" || "id required",
  });
  const stack = createPageStack({
    pages: { home: page(component) },
    initial: [{ name: "home" }],
    onError: () => {},
  });
  await stack.ready;
  assert.equal((await stack.pushDynamic(definition, { id: 1 })).error.code, "INVALID_ROUTE");
  assert.equal((await stack.pushDynamic(definition, { id: "1" })).status, "completed");
  assert.equal(stack.getSnapshot().current.params.id, "1");
  assert.equal(
    (await stack.openDynamicPopup(popup.withParams()(component), { message: "hello" })).status,
    "completed",
  );
  stack.dispose();
});
