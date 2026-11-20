import { dissolve, fade, glow, overlay } from "./demo-effects.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { compose, sequence, defineTransition, definePages, page } from "../dist/index.js";
import { runTransition } from "../dist/animation/scope.js";
import { selectTransition } from "../dist/animation/effect.js";

const context = (signal = new AbortController().signal, extra = {}) => ({
  operation: "push",
  from: undefined,
  to: undefined,
  fromRoute: undefined,
  toRoute: undefined,
  durationMs: 20,
  signal,
  ...extra,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
};
function animation() {
  const finish = deferred();
  return {
    finished: finish.promise,
    finish: finish.resolve,
    cancels: 0,
    cancel() {
      this.cancels++;
      finish.reject(new Error("cancelled animation"));
    },
  };
}
function styles(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getPropertyValue: (key) => values.get(key) ?? "",
    getPropertyPriority: () => "",
    setProperty: (key, value) => values.set(key, value),
    removeProperty: (key) => values.delete(key),
  };
}
test("编排时长包含延迟与嵌套，并拒绝无效时长和目录声明", () => {
  assert.equal(glow({ duration: 0, delay: 100 }).duration, 0);
  assert.equal(compose(fade({ duration: 10 }), glow({ duration: 30, delay: 5 })).duration, 35);
  assert.equal(
    sequence(fade({ duration: 10 }), compose(dissolve({ duration: 12 }), glow({ duration: 20 })))
      .duration,
    30,
  );
  for (const duration of [-1, NaN, Infinity, 0.5, 2_147_483_000])
    assert.throws(() => fade({ duration }), { code: "INVALID_CONFIG" });
  assert.throws(() => dissolve({ frequency: 0 }), { code: "INVALID_CONFIG" });
  assert.throws(() => overlay(null), { code: "INVALID_CONFIG" });
  assert.throws(
    () =>
      definePages({ a: page({ render: () => null }, { transition: { duration: -1, run() {} } }) }),
    { code: "INVALID_CONFIG" },
  );
  assert.ok(Object.isFrozen(dissolve()));
});
test("compose 并行启动，sequence 仅在前一步完成后启动后一步", async () => {
  const events = [],
    gate = deferred();
  const first = defineTransition({
    duration: 10,
    run: async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    },
  });
  const second = defineTransition({
    duration: 10,
    run: () => {
      events.push("second");
    },
  });
  const parallel = runTransition(compose(first, second), context());
  assert.deepEqual(events, ["first:start", "second"]);
  gate.resolve();
  await parallel;
  events.length = 0;
  await runTransition(sequence(first, second), context());
  assert.deepEqual(events, ["first:start", "first:end", "second"]);
});
test("取消顺序编排不启动后续步骤，已登记资源逆序且只清理一次", async () => {
  const events = [],
    abort = new AbortController();
  const first = defineTransition({
    duration: 100,
    run: async (scope) => {
      scope.onCleanup(() => events.push("one"));
      scope.onCleanup(() => events.push("two"));
      await scope.wait(10_000);
    },
  });
  const second = defineTransition({ duration: 100, run: () => events.push("late") });
  const running = runTransition(sequence(first, second), context(abort.signal));
  abort.abort();
  assert.deepEqual(events, ["two", "one"]);
  await assert.rejects(running, (error) => error.reason === "aborted");
  abort.abort();
  assert.deepEqual(events, ["two", "one"]);
});
test("未 await 的轨道仍被等待，完成后释放自己的句柄且不遍历业务动画", async () => {
  const own = animation();
  let complete = false;
  const target = {
    animate: () => own,
    getAnimations() {
      throw new Error("unrelated business animation");
    },
  };
  const effect = defineTransition({
    duration: 20,
    run(scope) {
      void scope.animate(target, [{ opacity: 0 }, { opacity: 1 }]);
    },
  });
  const pending = runTransition(effect, context()).then(() => {
    complete = true;
  });
  await Promise.resolve();
  assert.equal(complete, false);
  own.finish();
  await pending;
  assert.equal(own.cancels, 1);
});
test("部分启动失败也取消第一条轨道、删除图层、还原样式并消费取消拒绝", async () => {
  const first = animation(),
    target = { style: styles({ filter: "blur(1px)" }), animate: () => first };
  let removed = 0;
  const effect = defineTransition({
    duration: 10,
    run: async (scope) => {
      await scope.layer();
      scope.style(target, { filter: "url(#private)" });
      void scope.animate(target, [{ opacity: 0 }]);
      throw new Error("second-start-failed");
    },
  });
  await assert.rejects(
    runTransition(effect, context(), {
      createLayer: () => ({ element: target, ready: Promise.resolve(), dispose: () => removed++ }),
    }),
    /second-start-failed/,
  );
  assert.equal(first.cancels, 1);
  assert.equal(removed, 1);
  assert.equal(target.style.getPropertyValue("filter"), "blur(1px)");
  await new Promise((resolve) => setImmediate(resolve));
});
test("并行步骤出错立即取消其他步骤，迟到业务 Promise 不得重新申请图层", async () => {
  const late = deferred(),
    aborts = [];
  let saved,
    layers = 0;
  const pending = defineTransition({
    duration: 10,
    run: async (scope) => {
      saved = scope;
      scope.onCleanup(() => aborts.push("released"));
      await late.promise;
    },
  });
  const failure = defineTransition({
    duration: 10,
    run() {
      throw new Error("broken sibling");
    },
  });
  await assert.rejects(
    runTransition(compose(pending, failure), context(), {
      createLayer() {
        layers++;
        throw new Error("unexpected");
      },
    }),
    /broken sibling/,
  );
  late.reject(new Error("late rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(saved.layer());
  assert.equal(layers, 0);
  assert.deepEqual(aborts, ["released"]);
});
test("清理函数抛错不阻止后续回收，并传播可诊断错误", async () => {
  const calls = [],
    reports = [];
  await assert.rejects(
    runTransition(
      defineTransition({
        duration: 1,
        run(scope) {
          scope.onCleanup(() => calls.push("last"));
          scope.onCleanup(() => {
            throw new Error("dispose");
          });
        },
      }),
      context(),
      { onCleanupError: (error) => reports.push(error) },
    ),
    AggregateError,
  );
  assert.deepEqual(calls, ["last"]);
  assert.equal(reports.length, 1);
});
test("帧回调中止立即取消 RAF，迟到帧不能继续写入", async () => {
  const abort = new AbortController(),
    frames = new Map();
  let next = 0,
    writes = 0;
  const window = {
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => {
      frames.set(++next, fn);
      return next;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const effect = defineTransition({
    duration: 20,
    run: (scope) =>
      scope.frame(() => {
        writes++;
      }),
  });
  const running = runTransition(effect, context(abort.signal), {
    document: { defaultView: window },
  });
  assert.equal(writes, 1);
  const late = [...frames.values()][0];
  abort.abort();
  assert.equal(frames.size, 0);
  late(10);
  await assert.rejects(running);
  assert.equal(writes, 1);
});
test("返回和关闭弹窗由离场配置决定，false 优先级也保持一致", () => {
  const background = fade(),
    popup = dissolve();
  assert.equal(selectTransition("openPopup", background, popup, false), popup);
  assert.equal(selectTransition("closePopup", popup, background, false), popup);
  assert.equal(selectTransition("back", false, background, popup), false);
  assert.equal(selectTransition("push", background, false, popup), false);
});

test("外部 animate 同步触发取消后才返回句柄时，也立即取消该句柄", async () => {
  const abort = new AbortController(),
    own = animation();
  const target = {
    animate() {
      abort.abort();
      return own;
    },
  };
  await assert.rejects(
    runTransition(
      defineTransition({
        duration: 20,
        run(scope) {
          return scope.animate(target, [{ opacity: 0 }]);
        },
      }),
      context(abort.signal),
    ),
  );
  assert.equal(own.cancels, 1);
  await new Promise((resolve) => setImmediate(resolve));
});

test("并行子效果默认采用自己的时长，零时长步骤不申请资源", async () => {
  const durations = [];
  const target = {
    animate(_frames, options) {
      durations.push(options.duration);
      return { finished: Promise.resolve(), cancel() {} };
    },
  };
  const child = (duration) =>
    defineTransition({
      duration,
      run(scope) {
        return scope.animate(target, [{ opacity: 1 }]);
      },
    });
  await runTransition(compose(child(12), child(20), child(0)), context());
  assert.deepEqual(durations, [12, 20]);
});

test("图层申请同步失败或组件未就绪时取消，租约仍被释放", async () => {
  let disposed = 0;
  const effect = defineTransition({
    duration: 20,
    run: async (scope) => {
      await scope.layer();
    },
  });
  await assert.rejects(
    runTransition(effect, context(), {
      createLayer(_component, _props, fail) {
        fail(new Error("sync layer failure"));
        return {
          element: {},
          ready: Promise.resolve(),
          dispose() {
            disposed++;
          },
        };
      },
    }),
    /sync layer failure/,
  );
  assert.equal(disposed, 1);
  const abort = new AbortController();
  const running = runTransition(effect, context(abort.signal), {
    createLayer() {
      return {
        element: {},
        ready: new Promise(() => {}),
        dispose() {
          disposed++;
        },
      };
    },
  });
  abort.abort();
  await assert.rejects(running);
  assert.equal(disposed, 2);
});

test("动画异步清理晚于播放结束拒绝时，仍通过原诊断出口报告", async () => {
  const released = deferred();
  const errors = [];
  await runTransition(
    defineTransition({
      duration: 1,
      run(scope) {
        scope.onCleanup(() => released.promise);
      },
    }),
    context(),
    { onCleanupError: (error) => errors.push(error.message) },
  );
  released.reject(new Error("late-async-cleanup"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, ["late-async-cleanup"]);
});
