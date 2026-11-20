import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, page, tab, popup } from "../dist/index.js";

// 模型只描述公开历史和覆盖层，不调用内核规划函数；固定种子可精确重放失败序列。
const component = { render: () => null };
const generator = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const simplify = (routes) => routes.map((r) => ({ name: r.name, value: r.params?.value }));
for (let seed = 1; seed <= 30; seed++) {
  test(`独立模型种子 ${seed}：400 步随机导航和取消`, async () => {
    const random = generator(seed);
    const keep = random() > 0.5;
    const renderDepth = random() > 0.5 ? 1 : 3;
    const stack = createPageStack({
      pages: {
        home: tab(component),
        orders: tab(component),
        a: page(component),
        b: page(component, { cache: true }),
        dialog: popup(component),
        confirm: popup(component),
      },
      initial: [{ name: "home" }],
      closePopupsOnNavigate: !keep,
      renderDepth,
      maxHistory: 5,
      maxCachedPages: 3,
      onError: () => {},
    });
    await stack.ready;
    let history = [{ name: "home", value: undefined }],
      popups = [];
    for (let step = 0; step < 400; step++) {
      const op = Math.floor(random() * 8);
      const name = random() > 0.5 ? "a" : "b";
      const route = { name, params: { value: step } };
      const tabName = random() > 0.5 ? "home" : "orders";
      const resetHasRoot = random() > 0.5;
      const popupName = random() > 0.5 ? "dialog" : "confirm";
      const delta = 1 + Math.floor(random() * 4);
      const cancel = random() < 0.15;
      const remove = cancel ? stack.beforeEach(() => false) : () => {};
      const before = stack.getSnapshot();
      let result;
      if (op === 0) result = await stack.push(route);
      if (op === 1) result = await stack.replace(route);
      if (op === 2)
        result = await stack.switchTab({
          name: tabName,
          params: { value: step },
        });
      if (op === 3) result = await stack.reset(resetHasRoot ? [{ name: "home" }, route] : [route]);
      if (op === 4)
        result = await stack.openPopup({
          name: popupName,
          params: { value: step },
        });
      if (op === 5) result = await stack.back(delta);
      if (op === 6) result = await stack.closePopup();
      if (op === 7) {
        await stack.clearCache();
        result = { status: "noop" };
      }
      remove();
      const after = stack.getSnapshot();
      const hint = `seed=${seed}, step=${step}, op=${op}, status=${result.status}`;
      const noTarget =
        (op === 5 && !popups.length && history.length === 1) || (op === 6 && !popups.length);
      if (op !== 7)
        assert.equal(result.status, noTarget ? "noop" : cancel ? "cancelled" : "completed", hint);
      if (result.status === "completed") {
        // 预期仅依据输入和模型旧状态计算，不从框架输出反推期望值。
        if (op === 0) history.push({ name, value: step });
        if (op === 1) history[history.length - 1] = { name, value: step };
        if (op === 2) history = [{ name: tabName, value: step }];
        if (op === 3)
          history = resetHasRoot
            ? [
                { name: "home", value: undefined },
                { name, value: step },
              ]
            : [{ name, value: step }];
        if (op <= 3 && !keep) popups = [];
        if (op === 4) popups.push({ name: popupName, value: step });
        if (op === 5) {
          if (popups.length) popups.pop();
          else history = history.slice(0, Math.max(1, history.length - delta));
        }
        if (op === 6) popups.pop();
        const hasRoot = ["home", "orders"].includes(history[0]?.name);
        if (history.length > 5 + Number(hasRoot))
          history = [...(hasRoot ? [history[0]] : []), ...history.slice(-5)];
      } else if (op !== 7) {
        assert.deepEqual(after.history, before.history, hint);
        assert.deepEqual(after.popups, before.popups, hint);
      }
      assert.deepEqual(simplify(after.history), history, hint);
      assert.deepEqual(simplify(after.popups), popups, hint);
      const classicLayers = history.slice(-renderDepth);
      const root = history[0];
      if (["home", "orders"].includes(root?.name) && !classicLayers.includes(root))
        classicLayers.unshift(root);
      assert.deepEqual(simplify(after.layers), [...classicLayers, ...popups], hint);
      assert.equal(after.phase, "idle", hint);
      assert.equal(after.pending, undefined, hint);
      assert.equal(after.canGoBack, popups.length > 0 || history.length > 1, hint);
      assert.equal(
        new Set(after.rendered.map((p) => p.route.id)).size,
        after.rendered.length,
        hint,
      );
      assert.ok(after.rendered.length <= renderDepth + 1 + popups.length + 3, hint);
      const visible = after.rendered.filter((p) => p.visible).map((p) => p.route.id);
      assert.deepEqual(
        visible.sort((a, b) => a - b),
        [after.current?.id, ...after.popups.map((p) => p.id)]
          .filter((p) => p !== undefined)
          .sort((a, b) => a - b),
        hint,
      );
      assert.equal(after.rendered.filter((p) => p.focused).length, 1, hint);
    }
    stack.dispose();
  });
}
