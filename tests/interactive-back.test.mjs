import test from "node:test";
import assert from "node:assert/strict";
import { createPageStack, page, popup } from "../dist/index.js";
import { controllerFor } from "../dist/internal.js";

const scene = { render: () => null };

async function fixture(t, preview = true) {
  const calls = [];
  const events = [];
  const stack = createPageStack({
    pages: { list: page(scene), detail: page(scene), login: page(scene), dialog: popup(scene) },
    initial: [{ name: "list" }, { name: "detail" }],
  });
  await stack.ready;
  t.after(() => stack.dispose());
  stack.onNavigation((event) => events.push(event));
  const detach = preview
    ? controllerFor(stack).attachRenderer(
        async ({ operation, to }) => {
          calls.push(["ordinary", operation, to.name]);
          return true;
        },
        undefined,
        {
          available: () => true,
          start({ operation, from, to }) {
            calls.push(["preview", operation, from.name, to.name]);
            let disposed = false;
            return {
              update: (value) => calls.push(["progress", value]),
              rewind: async () => calls.push(["rewind"]),
              waitForCommit: () => calls.push(["confirm"]),
              complete: async () => {
                assert.equal(disposed, false);
                calls.push(["complete"]);
                return true;
              },
              dispose() {
                if (disposed) return;
                disposed = true;
                calls.push(["dispose"]);
              },
            };
          },
        },
      )
    : () => {};
  return { stack, calls, events, detach };
}

test("拖动和取消不会创建导航、改栈或触发守卫", async (t) => {
  const { stack, calls, events } = await fixture(t);
  stack.beforeNavigate(() => assert.fail("取消的手势不应进入守卫"));
  const original = stack.getSnapshot();
  assert.equal(original.back.mode, "interactive");
  const session = stack.beginBack(original.back.token);
  assert.equal(stack.beginBack(original.back.token), undefined);
  session.update(0.6);
  session.update(1.4);
  session.update(0.2);
  session.update(NaN);
  assert.strictEqual(stack.getSnapshot(), original);
  session.cancel();
  session.update(0.9);
  session.cancel();
  assert.equal(await session.commit(), undefined);
  assert.strictEqual(stack.getSnapshot(), original);
  assert.deepEqual(calls, [
    ["preview", "back", "detail", "list"],
    ["progress", 0.6],
    ["progress", 1],
    ["progress", 0.2],
    ["rewind"],
  ]);
  assert.deepEqual(events, []);
});

test("确认时才执行守卫，拒绝返回后回收预览并保留原栈", async (t) => {
  const { stack, calls, events } = await fixture(t);
  const info = { flow: "gesture" };
  let decide;
  let guards = 0;
  controllerFor(stack).guard(stack.getSnapshot().top.id, "back", (context) => {
    guards++;
    assert.strictEqual(context.info, info);
    assert.equal(context.reason, "native");
    return new Promise((resolve) => {
      decide = resolve;
    });
  });
  const { token } = stack.getSnapshot().back;
  const session = stack.beginBack(token, { info, reason: "native" });
  session.update(0.45);
  assert.equal(guards, 0);
  let reentered;
  stack.onNavigation((event) => {
    if (event.type === "requested") reentered = session.commit();
  });
  const completion = session.commit();
  assert.strictEqual(completion, reentered);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guards, 1);
  assert.equal(stack.getSnapshot().back.mode, "busy");
  assert.equal(stack.getSnapshot().top.name, "detail");
  decide(false);
  const outcome = await completion;
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.reason, "guard");
  assert.deepEqual(
    outcome.state.history.map((page) => page.name),
    ["list", "detail"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["requested", "settled"],
  );
  assert.deepEqual(calls.slice(-2), [["confirm"], ["dispose"]]);
  assert.strictEqual(session.commit(), completion);
});

test("返回被重定向时释放原预览，按真实目标提交并能恢复原返回", async (t) => {
  const { stack, calls, events } = await fixture(t);
  let signedIn = false;
  stack.beforeEach((context) => {
    if (context.to?.name === "list" && !signedIn) return { name: "login" };
  });
  const info = { entry: "back" };
  const session = stack.beginBack(stack.getSnapshot().back.token, { info });
  session.update(0.7);
  const redirected = await session.commit();
  assert.equal(redirected.status, "completed");
  assert.equal(redirected.redirected, true);
  assert.equal(redirected.state.top.name, "login");
  assert.deepEqual(
    redirected.state.history.map((page) => page.name),
    ["list", "detail", "login"],
  );
  assert.deepEqual(calls.slice(-2), [["dispose"], ["ordinary", "push", "login"]]);
  signedIn = true;
  const resumed = await stack.resume();
  assert.equal(resumed.resumedFromId, redirected.id);
  assert.strictEqual(resumed.info, info);
  assert.deepEqual(
    resumed.state.history.map((page) => page.name),
    ["list"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["requested", "settled", "requested", "settled"],
  );
});

test("另一导航使旧令牌和会话同时失效，迟到确认不会返回新页面", async (t) => {
  const { stack, calls, events } = await fixture(t);
  const token = stack.getSnapshot().back.token;
  const session = stack.beginBack(token);
  session.update(0.5);
  await stack.push({ name: "detail", key: "external-entry" });
  const current = stack.getSnapshot();
  assert.equal(current.top.key, "external-entry");
  assert.notEqual(current.back.token, token);
  assert.equal(stack.beginBack(token), undefined);
  assert.equal(await session.commit(), undefined);
  session.update(1);
  session.cancel();
  assert.strictEqual(stack.getSnapshot(), current);
  assert.deepEqual(
    events.map((event) => event.operation),
    ["push", "push"],
  );
  assert.deepEqual(calls.slice(-2), [["dispose"], ["ordinary", "push", "detail"]]);
});

test("同一目标只提交一次，弹窗优先，空闲根页交给宿主", async (t) => {
  const { stack, calls, detach } = await fixture(t);
  await stack.openPopup({ name: "dialog" });
  const session = stack.beginBack(stack.getSnapshot().back.token);
  const result = await session.commit();
  assert.equal(result.transition, "completed");
  assert.equal(result.state.top.name, "detail");
  assert.equal(result.state.popups.length, 0);
  assert.deepEqual(calls.slice(-4), [
    ["preview", "closePopup", "dialog", "detail"],
    ["confirm"],
    ["complete"],
    ["dispose"],
  ]);
  detach();
  const next = stack.getSnapshot().back;
  assert.equal(next.mode, "commit-only");
  assert.equal((await stack.beginBack(next.token).commit()).state.top.name, "list");
  assert.equal(stack.getSnapshot().back.mode, "delegate");
});

test("跨实例令牌失效，外部 AbortSignal 取消未确认手势", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, false);
  const token = first.stack.getSnapshot().back.token;
  assert.equal(second.stack.beginBack(token), undefined);
  const abort = new AbortController();
  const session = first.stack.beginBack(token, { signal: abort.signal });
  abort.abort();
  assert.equal(await session.commit(), undefined);
  assert.deepEqual(first.calls.at(-1), ["dispose"]);
  assert.deepEqual(first.events, []);
});
