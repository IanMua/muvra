import test from "node:test";
import assert from "node:assert/strict";
import { settle } from "../dist/async.js";
import { waapiTransition } from "./demo-effects.mjs";

const options = (signal = new AbortController().signal) => ({
  signal,
  timeoutMs: 20,
  timeoutCode: "GUARD_TIMEOUT",
  empty: true,
});
test("factory 内部已中止时不再订阅返回的 Observable", async () => {
  const abort = new AbortController();
  let subscribed = 0;
  const pending = settle(() => {
    abort.abort();
    return {
      subscribe() {
        subscribed++;
      },
    };
  }, options(abort.signal));
  await assert.rejects(pending);
  assert.equal(subscribed, 0);
});
test("同步首值后才取得的退订函数只调用一次", async () => {
  let cleaned = 0;
  const value = await settle(
    () => ({
      subscribe(o) {
        o.next(false);
        o.next(true);
        o.complete();
        return () => cleaned++;
      },
    }),
    options(),
  );
  assert.equal(value, false);
  assert.equal(cleaned, 1);
});
test("退订错误不会阻止首值结束，并可由宿主诊断", async () => {
  const errors = [];
  const value = await settle(
    () => ({
      subscribe(o) {
        o.next(true);
        return {
          unsubscribe() {
            throw new Error("cleanup");
          },
        };
      },
    }),
    { ...options(), onCleanupError: (e) => errors.push(e) },
  );
  assert.equal(value, true);
  assert.equal(errors.length, 1);
});
test("运行中的 Observable 被中止时退订，迟到结果不改变结束", async () => {
  const abort = new AbortController();
  let cleaned = 0;
  let observer;
  const pending = settle(
    () => ({
      subscribe(o) {
        observer = o;
        return {
          unsubscribe() {
            cleaned++;
          },
        };
      },
    }),
    options(abort.signal),
  );
  abort.abort();
  await assert.rejects(pending, (e) => e.reason === "aborted");
  observer.next(true);
  assert.equal(cleaned, 1);
});
test("中止后迟到 Promise 拒绝被消费，不产生未处理拒绝", async () => {
  const abort = new AbortController();
  let reject;
  const pending = settle(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    options(abort.signal),
  );
  abort.abort();
  await assert.rejects(pending);
  reject(new Error("late"));
  await new Promise((r) => setImmediate(r));
});
function animation(pending = false) {
  let reject;
  let canceled = 0;
  return {
    get canceled() {
      return canceled;
    },
    finished: pending
      ? new Promise((_resolve, fail) => {
          reject = fail;
        })
      : Promise.resolve(),
    cancel() {
      canceled++;
      reject?.(new Error("cancel"));
    },
  };
}
test("WAAPI 第二条启动失败时回收第一条并处理取消拒绝", async () => {
  const first = animation(true);
  await assert.rejects(
    waapiTransition({
      operation: "push",
      from: { animate: () => first },
      to: {
        animate() {
          throw new Error("second");
        },
      },
      durationMs: 200,
      signal: new AbortController().signal,
    }),
    /second/,
  );
  assert.equal(first.canceled, 1);
  await new Promise((r) => setImmediate(r));
});
test("WAAPI 正常完成只取消自身动画，不遍历业务动画", async () => {
  const one = animation(),
    two = animation();
  await waapiTransition({
    operation: "push",
    from: {
      animate: () => one,
      getAnimations() {
        throw new Error("business");
      },
    },
    to: { animate: () => two },
    durationMs: 200,
    signal: new AbortController().signal,
  });
  assert.equal(one.canceled, 1);
  assert.equal(two.canceled, 1);
});
