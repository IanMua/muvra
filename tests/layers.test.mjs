import test from "node:test";
import assert from "node:assert/strict";
import { ref } from "vue";
import {
  createLayerStack,
  createResourceScope,
  createExtensionHost,
  defineExtension,
} from "../dist/index.js";
import { backdrop } from "../dist/extensions/backdrop.js";

test("独立图层：相对层级稳定、循环与跨实例锚点在提交前拒绝", () => {
  const scene = createLayerStack();
  const a = scene.create(),
    b = scene.create();
  scene.order([a.anchor, b.anchor]);
  const middle = scene.create({ placement: { above: a.anchor, below: b.anchor } });
  const order = () => scene.getSnapshot().layers.map((entry) => entry.anchor);
  assert.deepEqual(order(), [a.anchor, middle.anchor, b.anchor]);
  assert.throws(() => a.place({ above: b.anchor }), /cycle/);
  assert.deepEqual(order(), [a.anchor, middle.anchor, b.anchor]);
  assert.throws(() => scene.order([b.anchor, a.anchor]), /cycle/);
  assert.throws(() => scene.order([a.anchor, a.anchor]), /duplicates/);
  const other = createLayerStack();
  const foreign = other.create();
  assert.throws(() => middle.place({ above: foreign.anchor }), /foreign/);
  assert.throws(() => scene.create({ owner: { id: a.anchor.id } }), /foreign/);
  assert.ok(Object.isFrozen(scene.getSnapshot().layers));
  scene.dispose();
  other.dispose();
});

test("独立图层：显示、所有权与位置引用分别管理，失去参照时不会漂到最上面", () => {
  const scene = createLayerStack();
  const background = scene.create();
  const owner = scene.create();
  const child = scene.create({
    owner: owner.anchor,
    placement: { above: background.anchor, below: owner.anchor },
  });
  const find = () => scene.getSnapshot().layers.find((entry) => entry.anchor === child.anchor);
  owner.update({ visible: false });
  assert.equal(find().visible, false);
  owner.update({ visible: true });
  assert.equal(find().visible, true);
  background.dispose();
  assert.equal(find().visible, false);
  child.place({ below: owner.anchor });
  assert.equal(find().visible, true);
  owner.dispose();
  assert.equal(child.signal.aborted, true);
  assert.equal(scene.getSnapshot().layers.length, 0);
  scene.dispose();
});

test("样式贡献：响应式更新、重叠撤销与销毁都不恢复过期值", () => {
  const scene = createLayerStack();
  const radius = ref(10);
  let reads = 0;
  const layer = scene.create({
    style: () => {
      reads++;
      return { borderRadius: `${radius.value}px` };
    },
  });
  const first = layer.styles.bind({ borderRadius: "20px", color: "red" });
  const second = layer.styles.bind({ borderRadius: "30px" });
  const style = () => scene.getSnapshot().layers[0].style;
  assert.equal(style().borderRadius, "30px");
  first();
  radius.value = 15;
  assert.equal(style().borderRadius, "30px");
  assert.equal(style().color, undefined);
  second();
  assert.equal(style().borderRadius, "15px");
  layer.dispose();
  const before = reads;
  radius.value = 99;
  assert.equal(reads, before);
  assert.throws(
    () =>
      scene.create({
        style: () => {
          throw new Error("invalid-style");
        },
      }),
    /invalid-style/,
  );
  assert.equal(scene.getSnapshot().layers.length, 0);
  scene.dispose();
});

test("资源作用域：逆序、幂等、迟到句柄、异步清理异常均有归属", async () => {
  const events = [],
    errors = [];
  const scope = createResourceScope((error) => errors.push(error.message));
  const sharedCleanup = () => {
    events.push(0);
  };
  scope.own(sharedCleanup);
  scope.own(sharedCleanup);
  scope.own(() => events.push(1));
  scope.own(() => {
    events.push(2);
    throw new Error("sync-cleanup");
  });
  scope.own(async () => {
    events.push(3);
    throw new Error("async-cleanup");
  });
  scope.dispose();
  scope.dispose();
  scope.own(() => events.push(4));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [3, 2, 1, 0, 0, 4]);
  assert.deepEqual(errors.sort(), ["async-cleanup", "sync-cleanup"]);
  assert.equal(scope.signal.aborted, true);
});

test("渲染租约：等待挂载可取消，卸载和销毁不会留下等待者", async () => {
  const scene = createLayerStack();
  const layer = scene.create();
  const renderer = scene.attachRenderer();
  assert.throws(() => scene.attachRenderer(), /already/);
  const cancel = new AbortController();
  const cancelled = assert.rejects(layer.whenMounted(cancel.signal), /aborted/);
  cancel.abort();
  await cancelled;
  const pending = layer.whenMounted();
  const element = {};
  renderer.bind(layer.anchor, element);
  assert.equal(await pending, element);
  renderer.bind(layer.anchor, undefined);
  const detached = assert.rejects(layer.whenMounted(), /detached/);
  renderer.dispose();
  await detached;
  const deleted = assert.rejects(layer.whenMounted(), /disposed/);
  layer.dispose();
  await deleted;
  scene.dispose();
});

test("图层动画：结束只释放自身轨道，销毁会结束忽略取消的外部句柄", async () => {
  const scene = createLayerStack();
  const layer = scene.create();
  const renderer = scene.attachRenderer();
  let cancels = 0;
  renderer.bind(layer.anchor, {
    animate: () => ({
      finished: Promise.resolve(),
      cancel() {
        cancels++;
      },
    }),
  });
  await layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1 });
  assert.equal(cancels, 1);
  renderer.bind(layer.anchor, {
    animate: () => ({
      finished: new Promise(() => {}),
      cancel() {
        cancels++;
      },
    }),
  });
  const pending = assert.rejects(layer.animate([{ opacity: 0 }]), /released/);
  await Promise.resolve();
  layer.dispose();
  await pending;
  assert.equal(cancels, 2);
  renderer.dispose();
  scene.dispose();
});

test("同 key 扩展：一个安装实例、脚本优先、撤销回退、页面实例隔离", () => {
  const scene = createLayerStack();
  const a = scene.create(),
    b = scene.create();
  let setups = 0,
    disposals = 0;
  const setup = (context, options) => {
    setups++;
    context.styles.bind(() => ({ color: options.color, opacity: options.opacity }));
    context.onCleanup(() => {
      disposals++;
    });
  };
  const mergeOptions = (base, override) => ({ ...base, ...override });
  const declaration = defineExtension({
    key: "appearance",
    options: { color: "red", opacity: 0.2 },
    mergeOptions,
    setup,
  });
  const hostA = createExtensionHost(scene, a, [declaration]);
  const hostB = createExtensionHost(scene, b, [declaration]);
  const remove = hostA.extend(
    defineExtension({ key: "appearance", options: { opacity: 0.8 }, mergeOptions, setup }),
  );
  const styles = () => scene.getSnapshot().layers.map((entry) => entry.style);
  assert.equal(setups, 2);
  assert.deepEqual(styles(), [
    { color: "red", opacity: 0.8 },
    { color: "red", opacity: 0.2 },
  ]);
  const last = hostA.extend(
    defineExtension({ key: "appearance", options: { color: "blue" }, mergeOptions, setup }),
  );
  remove();
  assert.deepEqual(styles()[0], { color: "blue", opacity: 0.2 });
  last();
  assert.deepEqual(styles()[0], { color: "red", opacity: 0.2 });
  hostA.dispose();
  hostB.dispose();
  assert.equal(disposals, 2);
  assert.deepEqual(styles(), [{}, {}]);
  assert.throws(() => hostA.extend(declaration), /disposed/);
  scene.dispose();
});

test("遮罩只用公开接口：前景单层遮罩，运行时只改透明度仍保留声明颜色", () => {
  const scene = createLayerStack();
  const group = Symbol("content");
  const home = scene.create({ group }),
    a = scene.create({ group }),
    b = scene.create({ group, visible: false });
  scene.order([home.anchor, a.anchor, b.anchor]);
  const hostA = createExtensionHost(scene, a, [backdrop({ color: "navy", opacity: 0.25 })], {
    group,
  });
  const hostB = createExtensionHost(scene, b, [backdrop({ color: "purple", opacity: 0.4 })], {
    group,
  });
  const masks = () =>
    scene.getSnapshot().layers.filter((entry) => "data-page-stack-backdrop" in entry.attrs);
  assert.equal(masks().length, 1);
  const opacity = ref(0.7);
  const remove = hostA.extend(backdrop({ opacity }));
  assert.deepEqual(masks()[0].style, { background: "navy", opacity: 0.7 });
  opacity.value = 0.8;
  assert.equal(masks()[0].style.opacity, 0.8);
  remove();
  assert.deepEqual(masks()[0].style, { background: "navy", opacity: 0.25 });
  b.update({ visible: true });
  assert.equal(masks().length, 1);
  assert.equal(masks()[0].style.background, "purple");
  const layers = scene.getSnapshot().layers;
  assert.ok(layers.findIndex((entry) => entry.anchor === a.anchor) < layers.indexOf(masks()[0]));
  assert.ok(layers.indexOf(masks()[0]) < layers.findIndex((entry) => entry.anchor === b.anchor));
  b.dispose();
  assert.equal(masks().length, 1);
  assert.equal(masks()[0].style.background, "navy");
  a.update({ visible: false });
  assert.equal(masks().length, 0);
  hostA.dispose();
  hostB.dispose();
  scene.dispose();
});

test("同步回收：创建通知或样式 getter 中销毁，不泄漏迟到 watcher 和图层句柄", () => {
  const value = ref(1);
  let reads = 0;
  const scene = createLayerStack();
  scene.subscribe(() => scene.dispose());
  const layer = scene.create({
    style: () => {
      reads++;
      return { opacity: value.value };
    },
  });
  assert.equal(layer.signal.aborted, true);
  const before = reads;
  value.value++;
  assert.equal(reads, before);
  const other = createLayerStack();
  assert.throws(
    () =>
      other.create({
        style: () => {
          void value.value;
          other.dispose();
          return {};
        },
      }),
    /disposed/,
  );
  value.value++;
  assert.equal(other.getSnapshot().layers.length, 0);
});

test("同步扩展回收：图层返回前宿主关闭，迟到资源不触发初始化时序异常", () => {
  const errors = [];
  const scene = createLayerStack({ onError: (error) => errors.push(error) });
  const owner = scene.create();
  const host = createExtensionHost(scene, owner, [], { onError: (error) => errors.push(error) });
  scene.subscribe((value) => {
    if (value.layers.length > 1) host.dispose();
  });
  host.extend(
    defineExtension({
      key: "late",
      setup(context) {
        context.layers.create();
      },
    }),
  );
  assert.equal(scene.getSnapshot().layers.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /scope is disposed/);
  assert.ok(!(errors[0] instanceof ReferenceError));
  scene.dispose();
});

test("图层观察者异步拒绝被诊断，其他观察者与清理仍继续", async () => {
  const errors = [];
  let calls = 0;
  const scene = createLayerStack({ onError: (error) => errors.push(error.message) });
  scene.subscribe(async () => {
    throw new Error("observer");
  });
  scene.subscribe(() => {
    calls++;
  });
  scene.create();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(errors, ["observer"]);
  assert.equal(calls, 1);
  scene.dispose();
  await Promise.resolve();
  await Promise.resolve();
});

test("默认扩展宿主不需要私有分组，遮罩不会把自己递归当成背景", () => {
  const errors = [];
  const scene = createLayerStack({ onError: (error) => errors.push(error) });
  const lower = scene.create(),
    upper = scene.create();
  scene.order([lower.anchor, upper.anchor]);
  const host = createExtensionHost(scene, upper, [backdrop()], {
    onError: (error) => errors.push(error),
  });
  assert.equal(scene.getSnapshot().layers.length, 3);
  assert.deepEqual(errors, []);
  host.dispose();
  assert.equal(scene.getSnapshot().layers.length, 2);
  scene.dispose();
});
