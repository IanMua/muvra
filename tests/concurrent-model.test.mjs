import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, page, tab, popup } from "../dist/index.js";
const component = { render: () => null };
const randomFor = (seed) => () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const data = (routes) => routes.map((route) => ({ name: route.name, value: route.params?.value }));

// 一批调用在调度微任务开始前提交；只依据请求及完成结果计算模型，验证 FIFO 与独立排队取消。
for (let seed = 1; seed <= 10; seed++) {
  test(`并发模型种子 ${seed}：100 批共 600 个排队操作`, async () => {
    const random = randomFor(seed);
    const stack = createPageStack({
      pages: {
        home: tab(component),
        orders: tab(component),
        a: page(component),
        dialog: popup(component),
      },
      initial: [{ name: "home" }],
      maxHistory: 5,
      onError: () => {},
    });
    await stack.ready;
    stack.beforeEach(({ to }) => !to.params?.reject);
    let history = [{ name: "home", value: undefined }],
      popups = [];
    for (let batch = 0; batch < 100; batch++) {
      const requests = [];
      for (let index = 0; index < 6; index++) {
        const operation = Math.floor(random() * 6),
          abort = random() < 0.2,
          reject = random() < 0.15;
        const value = batch * 6 + index;
        const name = random() < 0.5 ? "home" : "orders";
        const delta = 1 + Math.floor(random() * 3);
        const controller = new AbortController();
        const options = { signal: controller.signal };
        let promise;
        if (operation === 0)
          promise = stack.push({ name: "a", params: { value, reject } }, options);
        if (operation === 1)
          promise = stack.replace({ name: "a", params: { value, reject } }, options);
        if (operation === 2)
          promise = stack.switchTab({ name, params: { value, reject } }, options);
        if (operation === 3)
          promise = stack.openPopup({ name: "dialog", params: { value, reject } }, options);
        if (operation === 4) promise = stack.back(delta, options);
        if (operation === 5)
          promise = stack.reset(
            [{ name: "home" }, { name: "a", params: { value, reject } }],
            options,
          );
        if (abort) controller.abort();
        requests.push({ operation, abort, reject, value, name, delta, promise });
      }
      assert.equal(stack.getSnapshot().queued, requests.filter((r) => !r.abort).length);
      for (const request of requests) {
        const result = await request.promise;
        const hint = `seed=${seed}, batch=${batch}, op=${request.operation}`;
        if (request.abort) {
          assert.equal(result.reason, "aborted", hint);
          continue;
        }
        const { operation: op, value, name, delta } = request;
        if (op !== 4 && request.reject) {
          assert.equal(result.reason, "guard", hint);
          continue;
        }
        if (op === 4 && !popups.length && history.length === 1) {
          assert.equal(result.reason, "root", hint);
          continue;
        }
        assert.equal(result.status, "completed", hint);
        if (op === 0) {
          history.push({ name: "a", value });
          popups = [];
        }
        if (op === 1) {
          history[history.length - 1] = { name: "a", value };
          popups = [];
        }
        if (op === 2) {
          history = [{ name, value }];
          popups = [];
        }
        if (op === 3) popups.push({ name: "dialog", value });
        if (op === 4) {
          if (popups.length) popups.pop();
          else history = history.slice(0, Math.max(1, history.length - delta));
        }
        if (op === 5) {
          history = [
            { name: "home", value: undefined },
            { name: "a", value },
          ];
          popups = [];
        }
        const root = ["home", "orders"].includes(history[0]?.name) ? history[0] : undefined;
        if (history.length > 5 + Number(Boolean(root)))
          history = [...(root ? [root] : []), ...history.slice(-5)];
        assert.deepEqual(data(result.state.history), history, hint);
        assert.deepEqual(data(result.state.popups), popups, hint);
      }
      assert.deepEqual(data(stack.getSnapshot().history), history);
      assert.deepEqual(data(stack.getSnapshot().popups), popups);
      assert.equal(stack.getSnapshot().busy, false);
    }
    stack.dispose();
  });
}
