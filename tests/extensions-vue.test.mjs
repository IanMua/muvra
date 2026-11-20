import test from "node:test";
import assert from "node:assert/strict";
import { createSSRApp, defineComponent, h, ref } from "vue";
import { renderToString } from "@vue/server-renderer";
import {
  createPageStack,
  defineExtension,
  page,
  popup,
  tab,
  PageStackView,
  usePage,
} from "../dist/index.js";
import { backdrop } from "../dist/extensions/backdrop.js";
import { find, flush, mountView } from "./helpers.mjs";

const blank = { render: () => h("p", "page") };
const mask = (view) =>
  find(view.root, (node) => Object.hasOwn(node.props, "data-page-stack-backdrop"));
const pageNode = (view, id) => find(view.root, (node) => node.props["data-page-id"] === id);
const make = async (pages) => {
  const diagnostics = [];
  const stack = createPageStack({
    pages: { home: tab(blank), ...pages },
    initial: [{ name: "home" }],
    onError: (error) => diagnostics.push(error),
  });
  await stack.ready;
  return { stack, diagnostics };
};

test("真实 Vue：脚本动态贡献随组件销毁，声明颜色与默认透明度正确恢复", async () => {
  let context, remove;
  const opacity = ref(0.6);
  const card = defineComponent({
    setup() {
      context = usePage();
      remove = context.extend(backdrop({ opacity }));
      return () => h("p", "card");
    },
  });
  const { stack } = await make({
    card: popup(card, { extensions: [backdrop({ color: "navy", opacity: 0.2 })] }),
  });
  const view = mountView(stack);
  await stack.openPopup({ name: "card" });
  await flush();
  assert.equal(mask(view).style.background, "navy");
  assert.equal(mask(view).style.opacity, 0.6);
  opacity.value = 0.8;
  await flush();
  assert.equal(mask(view).style.opacity, 0.8);
  remove();
  await flush();
  assert.equal(mask(view).style.opacity, 0.2);
  await stack.closePopup();
  await flush();
  assert.equal(mask(view), undefined);
  assert.throws(() => context.extend(backdrop()), { code: "DISPOSED" });
  assert.deepEqual(view.errors, []);
  view.unmount();
  stack.dispose();
});

test("真实 Vue：关闭 B 时逻辑焦点已到 A，物理遮罩仍夹在 A 与 B 之间", async () => {
  let gate, start;
  const started = new Promise((resolve) => {
    start = resolve;
  });
  const transition = ({ operation }) =>
    operation === "closePopup"
      ? new Promise((resolve) => {
          gate = resolve;
          start();
        })
      : undefined;
  const { stack } = await make({
    a: popup(blank, { extensions: [backdrop({ color: "red" })] }),
    b: popup(blank, { transition, extensions: [backdrop({ color: "blue" })] }),
  });
  const view = mountView(stack, { transition: true });
  await stack.openPopup({ name: "a" });
  await stack.openPopup({ name: "b" });
  await flush();
  const a = stack.getSnapshot().popups[0].id,
    b = stack.getSnapshot().popups[1].id;
  const pending = stack.back();
  await started;
  await flush();
  assert.equal(stack.getSnapshot().top.id, a);
  assert.equal(mask(view).style.background, "blue");
  assert.ok(pageNode(view, a).style.zIndex < mask(view).style.zIndex);
  assert.ok(mask(view).style.zIndex < pageNode(view, b).style.zIndex);
  gate();
  await pending;
  await flush();
  assert.equal(mask(view).style.background, "red");
  assert.equal(pageNode(view, b), undefined);
  view.unmount();
  stack.dispose();
});

test("真实 Vue：守卫取消不会销毁遮罩，普通页动画取消及失败后不留下遮罩", async () => {
  const { stack } = await make({
    card: popup(blank, { extensions: [backdrop()] }),
    order: page(blank, { transition: () => new Promise(() => {}), extensions: [backdrop()] }),
    broken: page(blank, {
      transition: () => {
        throw new Error("motion-failed");
      },
      extensions: [backdrop()],
    }),
  });
  const view = mountView(stack, { transition: true });
  await stack.openPopup({ name: "card" });
  await flush();
  const before = mask(view);
  const remove = stack.beforeEach(() => false);
  assert.equal((await stack.back()).status, "cancelled");
  await flush();
  assert.equal(mask(view), before);
  remove();
  await stack.closePopup();
  const pending = stack.push({ name: "order" });
  for (let i = 0; i < 10 && stack.getSnapshot().phase !== "transition"; i++) await flush();
  assert.equal(stack.getSnapshot().phase, "transition");
  stack.cancel();
  await pending;
  await flush();
  assert.equal(stack.getSnapshot().current.name, "order");
  assert.equal(mask(view), undefined);
  assert.equal((await stack.push({ name: "broken" })).transition, "failed");
  await flush();
  assert.equal(mask(view), undefined);
  view.unmount();
  stack.dispose();
});

test("真实 Vue：同名弹窗、视图重挂和双栈均不共享扩展实例", async () => {
  let alive = 0,
    setups = 0;
  const extension = defineExtension({
    key: "counter",
    setup(context) {
      alive++;
      setups++;
      context.onCleanup(() => {
        alive--;
      });
    },
  });
  const definition = popup(blank, { extensions: [extension, backdrop()] });
  const first = await make({ dialog: definition }),
    second = await make({ dialog: definition });
  let firstView = mountView(first.stack);
  const secondView = mountView(second.stack);
  await first.stack.openPopup({ name: "dialog" });
  await first.stack.openPopup({ name: "dialog" });
  await second.stack.openPopup({ name: "dialog" });
  await flush();
  assert.equal(alive, 3);
  firstView.unmount();
  assert.equal(alive, 1);
  firstView = mountView(first.stack);
  await flush();
  assert.equal(alive, 3);
  assert.equal(setups, 5);
  first.stack.dispose();
  await flush();
  assert.equal(alive, 1);
  assert.equal(mask(firstView), undefined);
  firstView.unmount();
  secondView.unmount();
  second.stack.dispose();
  assert.equal(alive, 0);
});

test("真实 Vue：错误重试卸载脚本覆盖，声明扩展保留且只安装一次", async () => {
  let fail = true,
    installs = 0;
  const base = defineExtension({
    key: "default",
    setup() {
      installs++;
    },
  });
  const card = defineComponent({
    setup() {
      const context = usePage();
      if (!fail) context.extend(backdrop({ opacity: 0.8 }));
      return () => {
        if (fail) throw new Error("page-failed");
        return h("p", "recovered");
      };
    },
  });
  const { stack } = await make({
    card: popup(card, { extensions: [backdrop({ opacity: 0.2 }), base] }),
  });
  const view = mountView(stack);
  await stack.openPopup({ name: "card" });
  await flush();
  assert.equal(mask(view).style.opacity, 0.2);
  fail = false;
  find(view.root, (node) => node.type === "button" && node.text === "Retry").props.onClick();
  await flush();
  assert.equal(mask(view).style.opacity, 0.8);
  assert.equal(installs, 1);
  view.unmount();
  stack.dispose();
});

test("SSR：声明扩展没有 DOM 也能运行，请求销毁会停止独立响应式订阅", async () => {
  const source = ref(0.2);
  let reads = 0,
    active = 0;
  const extension = defineExtension({
    key: "ssr",
    setup(context) {
      active++;
      context.styles.bind(() => {
        reads++;
        return { opacity: source.value };
      });
      context.onCleanup(() => {
        active--;
      });
    },
  });
  const { stack } = await make({ card: popup(blank, { extensions: [backdrop(), extension] }) });
  await stack.openPopup({ name: "card" });
  const html = await renderToString(createSSRApp({ render: () => h(PageStackView, { stack }) }));
  assert.match(html, /data-page-stack-backdrop/);
  assert.equal(active, 1);
  stack.dispose();
  const before = reads;
  source.value = 0.8;
  assert.equal(active, 0);
  assert.equal(reads, before);
});

test("动画清理晚于下一次导航失败时，诊断仍归原来的导航", async () => {
  let rejectCleanup;
  const cleanup = new Promise((_resolve, reject) => {
    rejectCleanup = reject;
  });
  const { defineTransition } = await import("../dist/index.js");
  const { stack, diagnostics } = await make({
    first: page(blank, {
      transition: defineTransition({
        duration: 1,
        run(scope) {
          scope.onCleanup(() => cleanup);
        },
      }),
    }),
    next: page(blank, { transition: () => new Promise(() => {}) }),
  });
  const view = mountView(stack, { transition: true });
  const first = await stack.push({ name: "first" });
  const pending = stack.push({ name: "next" });
  for (let i = 0; i < 12 && stack.getSnapshot().phase !== "transition"; i++) await flush();
  assert.notEqual(stack.getSnapshot().pending.id, first.id);
  rejectCleanup(new Error("delayed-cleanup-error"));
  await flush();
  const failure = diagnostics.find(
    (entry) =>
      entry.error.code === "TRANSITION_ERROR" &&
      entry.error.cause?.message === "delayed-cleanup-error",
  );
  assert.equal(failure.navigationId, first.id);
  assert.equal(failure.route.name, "first");
  stack.cancel();
  await pending;
  view.unmount();
  stack.dispose();
});
