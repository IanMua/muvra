import test from "node:test";
import assert from "node:assert/strict";
import {
  createSSRApp,
  defineAsyncComponent,
  defineComponent,
  effectScope,
  h,
  nextTick,
  ref,
  shallowRef,
} from "vue";
import { renderToString } from "@vue/server-renderer";
import { compileScript, parse } from "vue/compiler-sfc";
import ts from "typescript";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BehaviorSubject } from "rxjs";
import {
  createPageStack,
  definePages,
  page,
  tab,
  popup,
  PageStackView,
  usePage,
  useStackState,
  lazy,
} from "../dist/index.js";
import { find, flush, mountView, text } from "./helpers.mjs";
const blank = { render: () => null };
const create = async (pages, options = {}) => {
  const errors = [];
  const stack = createPageStack({
    pages,
    initial: [{ name: "home" }],
    onError: (d) => errors.push(d),
    ...options,
  });
  await stack.ready;
  return { stack, errors };
};

test("共享 pageProps 对象和函数透传，路由参数优先", async () => {
  const component = defineComponent({
    props: ["shared", "message"],
    setup: (props) => () => h("p", `${props.shared}:${props.message}`),
  });
  for (const shared of [
    { shared: "global", message: "default" },
    (route) => ({ shared: route.name, message: "default" }),
  ]) {
    const { stack } = await create({ home: tab(component) });
    const view = mountView(stack, { pageProps: shared });
    await stack.switchTab({ name: "home", params: { message: "route" } });
    await flush();
    assert.ok(
      text(view.root).includes(`${typeof shared === "function" ? "home" : "global"}:route`),
    );
    assert.deepEqual(view.errors, []);
    view.unmount();
    stack.dispose();
  }
});
test("缓存 Tab 参数、回调及 Ref 更新保持响应性和引用", async () => {
  let context;
  let setups = 0;
  const component = defineComponent({
    setup() {
      setups++;
      context = usePage();
      return () => h("p", context.params.value.message.value);
    },
  });
  const message = ref("first");
  const callback = () => 7;
  const { stack } = await create(
    { home: tab(component), other: tab(blank) },
    { initial: [{ name: "home", params: { message, callback } }] },
  );
  const view = mountView(stack);
  await flush();
  assert.equal(context.params.value.message, message);
  assert.equal(context.params.value.callback, callback);
  message.value = "second";
  await flush();
  assert.ok(text(view.root).includes("second"));
  await stack.switchTab({ name: "other" });
  await stack.switchTab({
    name: "home",
    params: { message: ref("third"), callback },
  });
  await flush();
  assert.equal(setups, 1);
  assert.ok(text(view.root).includes("third"));
  view.unmount();
  stack.dispose();
});
test("真实生命周期：显示/隐藏有序，回收和销毁只卸载一次", async () => {
  const events = [];
  const component = (name) =>
    defineComponent({
      setup() {
        const ctx = usePage();
        ctx.onShow(() => events.push(`${name}:show`));
        ctx.onHide(() => events.push(`${name}:hide`));
        ctx.onUnload(() => events.push(`${name}:unload`));
        return () => h("p", name);
      },
    });
  const { stack } = await create(
    {
      home: tab(component("home")),
      a: page(component("a")),
      b: page(component("b")),
    },
    { renderDepth: 1 },
  );
  const view = mountView(stack);
  await flush();
  assert.deepEqual(events, ["home:show"]);
  await stack.push({ name: "a" });
  await stack.push({ name: "b" });
  await flush();
  assert.equal(events.filter((e) => e === "a:show").length, 1);
  assert.equal(events.filter((e) => e === "a:unload").length, 1);
  assert.ok(events.indexOf("a:hide") < events.indexOf("a:unload"));
  stack.dispose();
  await flush();
  view.unmount();
  assert.equal(events.filter((e) => e === "a:unload").length, 1);
  assert.equal(events.filter((e) => e === "b:unload").length, 1);
});
test("通过公开 composable 注册同步 Observable 返回守卫", async () => {
  const source = new BehaviorSubject(false);
  const guarded = defineComponent({
    setup() {
      usePage().beforeBack(() => source);
      return () => h("p", "guarded");
    },
  });
  const { stack } = await create({ home: tab(blank), guarded: page(guarded) });
  const view = mountView(stack);
  await stack.push({ name: "guarded" });
  assert.equal((await stack.back()).reason, "guard");
  assert.equal(source.observers.length, 0);
  source.next(true);
  assert.equal((await stack.back()).status, "completed");
  view.unmount();
  stack.dispose();
});
test("弹窗上下文的 isIntercepted / resume 实际恢复目标 Tab", async () => {
  let pageContext;
  let loggedIn = false;
  const login = defineComponent({
    setup() {
      pageContext = usePage();
      return () => h("p", "login");
    },
  });
  const { stack } = await create({
    home: tab(blank),
    orders: tab(blank),
    login: page(login),
  });
  const view = mountView(stack);
  stack.beforeEach(({ to }) => {
    if (to.name === "orders" && !loggedIn) return { name: "login" };
  });
  await stack.switchTab({ name: "orders" });
  await flush();
  assert.equal(pageContext.isIntercepted.value, true);
  loggedIn = true;
  await pageContext.resume();
  await flush();
  assert.deepEqual(
    stack.getSnapshot().history.map((r) => r.name),
    ["orders"],
  );
  assert.equal((await pageContext.resume()).reason, "not-intercepted");
  view.unmount();
  stack.dispose();
});
test("组件错误出现可重试边界，错误不会阻塞下一次导航", async () => {
  let broken = true;
  const component = defineComponent({
    setup() {
      if (broken) throw new Error("broken setup");
      return () => h("p", "recovered");
    },
  });
  const { stack, errors } = await create({
    home: tab(blank),
    broken: page(component),
    next: page(blank),
  });
  const view = mountView(stack);
  await stack.push({ name: "broken" });
  await flush();
  assert.ok(find(view.root, (n) => n.props.role === "alert"));
  assert.equal(errors[0].error.code, "COMPONENT_ERROR");
  assert.deepEqual(view.errors, []);
  broken = false;
  find(view.root, (n) => n.type === "button" && text(n) === "Retry").props.onClick();
  await flush();
  assert.ok(text(view.root).includes("recovered"));
  assert.equal((await stack.push({ name: "next" })).status, "completed");
  view.unmount();
  stack.dispose();
});
test("异步组件迟到挂载也能收到首次 onShow", async () => {
  let resolveComponent;
  let shows = 0;
  const component = defineAsyncComponent(
    () =>
      new Promise((resolve) => {
        resolveComponent = resolve;
      }),
  );
  const { stack } = await create({ home: tab(blank), async: page(component) });
  const view = mountView(stack);
  await stack.push({ name: "async" });
  resolveComponent(
    defineComponent({
      setup() {
        usePage().onShow(() => shows++);
        return () => h("p", "loaded");
      },
    }),
  );
  for (let index = 0; index < 5; index++) await flush();
  assert.equal(shows, 1);
  assert.ok(text(view.root).includes("loaded"));
  view.unmount();
  stack.dispose();
});

test("自定义加载和错误插槽获得页面及重试能力，根属性正常透传", async () => {
  let attempts = 0,
    reject;
  const component = lazy(async () => {
    if (++attempts === 1)
      return await new Promise((_resolve, fail) => {
        reject = fail;
      });
    return { render: () => h("p", "slot recovered") };
  });
  const { stack, errors } = await create({ home: tab(blank), custom: page(component) });
  const view = mountView(stack, {}, () =>
    h(
      PageStackView,
      { stack, transition: false, class: "host-root", "aria-label": "Navigation" },
      {
        loading: ({ route }) => h("p", `Loading ${route.name}`),
        error: ({ error, route, retry }) =>
          h("button", { onClick: retry }, `${route.name}: ${error.message}`),
      },
    ),
  );
  await stack.push({ name: "custom" });
  await flush();
  assert.ok(text(view.root).includes("Loading custom"));
  const container = find(view.root, (node) => node.props["data-page-stack"] === "");
  assert.equal(container.props.class, "host-root");
  assert.equal(container.props["aria-label"], "Navigation");
  reject(new Error("please retry"));
  for (let index = 0; index < 5; index++) await flush();
  const retry = find(
    view.root,
    (node) => node.type === "button" && text(node) === "custom: please retry",
  );
  assert.ok(retry);
  retry.props.onClick();
  for (let index = 0; index < 5; index++) await flush();
  assert.ok(text(view.root).includes("slot recovered"));
  assert.equal(attempts, 2);
  assert.equal(errors[0].error.code, "COMPONENT_ERROR");
  assert.deepEqual(view.errors, []);
  view.unmount();
  stack.dispose();
});

test("业务错误插槽自身抛错时仍有可用默认边界，undefined 异常也可捕获", async () => {
  const component = defineComponent({
    setup() {
      throw undefined;
    },
  });
  const { stack, errors } = await create({ home: tab(blank), broken: page(component) });
  const view = mountView(stack, {}, () =>
    h(
      PageStackView,
      { stack, transition: false },
      {
        error: () => {
          throw new Error("broken error UI");
        },
      },
    ),
  );
  await stack.push({ name: "broken" });
  await flush();
  assert.ok(find(view.root, (node) => node.props.role === "alert"));
  assert.ok(errors.some((d) => d.error.cause === undefined));
  assert.ok(errors.some((d) => d.error.cause?.message === "broken error UI"));
  assert.deepEqual(view.errors, []);
  assert.equal((await stack.back()).status, "completed");
  view.unmount();
  stack.dispose();
});
test("视图卸载时结束正在等待的动画，重新挂载仍可导航", async () => {
  const { stack } = await create({ home: tab(blank), a: page(blank) });
  const view = mountView(stack, { transition: () => new Promise(() => {}) });
  const pending = stack.push({ name: "a" });
  await flush();
  view.unmount();
  assert.equal((await pending).transition, "interrupted");
  const second = mountView(stack);
  assert.equal((await stack.back()).status, "completed");
  second.unmount();
  stack.dispose();
});
test("state composable 的作用域结束后停止接收更新", async () => {
  const { stack } = await create({ home: tab(blank), a: page(blank) });
  const scope = effectScope();
  let state;
  scope.run(() => {
    state = useStackState(stack);
  });
  await stack.push({ name: "a" });
  assert.equal(state.value.current.name, "a");
  scope.stop();
  await stack.back();
  assert.equal(state.value.current.name, "a");
  stack.dispose();
});
test("Vue 容器切换 stack prop 后完整解绑旧实例并接入新实例", async () => {
  const A = defineComponent({ setup: () => () => h("p", "stack-A") });
  const B = defineComponent({ setup: () => () => h("p", "stack-B") });
  const { stack: a } = await create({ home: tab(A) });
  const { stack: b } = await create({ home: tab(B) });
  const current = shallowRef(a);
  const view = mountView(a, {}, () =>
    h(PageStackView, { stack: current.value, transition: false }),
  );
  assert.ok(text(view.root).includes("stack-A"));
  current.value = b;
  await flush();
  assert.ok(text(view.root).includes("stack-B"));
  assert.deepEqual(view.errors, []);
  view.unmount();
  a.dispose();
  b.dispose();
});
test("SSR 可渲染独立实例且 props 不依赖浏览器 API", async () => {
  const Component = defineComponent({
    props: ["message"],
    setup: (p) => () => h("strong", p.message),
  });
  const { stack } = await create({ home: tab(Component) });
  const html = await renderToString(
    createSSRApp({
      render: () => h(PageStackView, { stack, pageProps: { message: "SSR-props" } }),
    }),
  );
  assert.ok(html.includes("SSR-props"));
  stack.dispose();
});

test("视图卸载释放 onUnload 资源，重新挂载为新的组件生命周期", async () => {
  const events = [];
  const component = defineComponent({
    setup() {
      const ctx = usePage();
      ctx.onShow(() => events.push("show"));
      ctx.onHide(() => events.push("hide"));
      ctx.onUnload(() => events.push("unload"));
      return () => h("p", "mounted");
    },
  });
  const { stack } = await create({ home: tab(component) });
  const first = mountView(stack);
  await flush();
  first.unmount();
  assert.deepEqual(events, ["show", "hide", "unload"]);
  const second = mountView(stack);
  await flush();
  stack.dispose();
  await flush();
  second.unmount();
  assert.deepEqual(events, ["show", "hide", "unload", "show", "hide", "unload"]);
});
test("页面级动画覆盖保留完整上下文，false 禁用动画", async () => {
  const calls = [];
  const { stack } = await create({
    home: tab(blank),
    a: page(blank, {
      transition: (ctx) => {
        calls.push(ctx);
      },
    }),
    b: page(blank, { transition: false }),
  });
  const view = mountView(stack, {
    transition: () => {
      throw new Error("global driver should not run");
    },
  });
  const entered = await stack.push({ name: "a" });
  assert.equal(entered.transition, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fromRoute.name, "home");
  assert.equal(calls[0].toRoute.name, "a");
  assert.equal((await stack.push({ name: "b" })).transition, "skipped");
  view.unmount();
  stack.dispose();
});

test("卸载回调读到最后参数、已隐藏状态和已销毁实例状态", async () => {
  const observations = [];
  let context;
  const component = defineComponent({
    setup() {
      context = usePage();
      context.onUnload(() =>
        observations.push({
          params: context.params.value,
          visible: context.visible.value,
          disposed: stack.getSnapshot().disposed,
        }),
      );
      return () => h("p", context.params.value.value);
    },
  });
  const { stack } = await create(
    { home: tab(component) },
    { initial: [{ name: "home", params: { value: "first" } }] },
  );
  const view = mountView(stack);
  await flush();
  await stack.switchTab({ name: "home", params: { value: "last" } });
  assert.equal(context.visible.value, true);
  stack.dispose();
  await flush();
  view.unmount();
  assert.deepEqual(observations, [{ params: { value: "last" }, visible: false, disposed: true }]);
});
test("异步 setup 页面有加载占位并在完成后收到显示生命周期", async () => {
  let resolveSetup;
  let shows = 0;
  const component = defineComponent({
    async setup() {
      usePage().onShow(() => shows++);
      await new Promise((resolve) => {
        resolveSetup = resolve;
      });
      return () => h("p", "async setup ready");
    },
  });
  const { stack } = await create({ home: tab(blank), async: page(component) });
  const view = mountView(stack);
  await stack.push({ name: "async" });
  await flush();
  assert.ok(find(view.root, (node) => node.props.role === "status"));
  resolveSetup();
  for (let index = 0; index < 5; index++) await flush();
  assert.equal(shows, 1);
  assert.ok(text(view.root).includes("async setup ready"));
  view.unmount();
  stack.dispose();
});
test("按需加载失败后 Retry 重新请求 loader，离开时中止加载", async () => {
  let attempts = 0;
  const component = lazy(async () => {
    if (++attempts === 1) throw new Error("temporary loader failure");
    return { default: defineComponent({ setup: () => () => h("p", "lazy recovered") }) };
  });
  const { stack } = await create({ home: tab(blank), lazy: page(component) });
  const view = mountView(stack);
  await stack.push({ name: "lazy" });
  for (let index = 0; index < 5; index++) await flush();
  assert.ok(find(view.root, (node) => node.props.role === "alert"));
  find(view.root, (node) => node.type === "button" && text(node) === "Retry").props.onClick();
  for (let index = 0; index < 5; index++) await flush();
  assert.equal(attempts, 2);
  assert.ok(text(view.root).includes("lazy recovered"));
  view.unmount();
  stack.dispose();
});
test("离开未完成的 lazy 页面会通知 signal，迟到拒绝不会成为页面错误", async () => {
  let signal, reject;
  const component = lazy((value) => {
    signal = value;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const { stack, errors } = await create(
    { home: tab(blank), lazy: page(component) },
    { renderDepth: 1 },
  );
  const view = mountView(stack);
  await stack.push({ name: "lazy" });
  await stack.back();
  assert.equal(signal.aborted, true);
  reject(new Error("late"));
  for (let index = 0; index < 5; index++) await flush();
  assert.deepEqual(errors, []);
  assert.deepEqual(view.errors, []);
  view.unmount();
  stack.dispose();
});
test("一个实例绑定第二个视图时，在创建重复页面前拒绝且不破坏原视图", async () => {
  let shows = 0;
  const component = defineComponent({
    setup() {
      usePage().onShow(() => shows++);
      return () => h("p", "single owner");
    },
  });
  const { stack } = await create({ home: tab(component) });
  const first = mountView(stack);
  const second = mountView(stack);
  await flush();
  assert.equal(shows, 1);
  assert.equal(second.errors[0].code, "RENDERER_CONFLICT");
  assert.ok(text(first.root).includes("single owner"));
  second.unmount();
  first.unmount();
  stack.dispose();
});
test("页面 signal 跟随真实组件卸载及内核回收中止", async () => {
  const signals = [];
  const component = defineComponent({
    setup() {
      signals.push(usePage().signal);
      return () => h("p", "signal");
    },
  });
  const { stack } = await create({ home: tab(component) });
  const first = mountView(stack);
  assert.equal(signals[0].aborted, false);
  first.unmount();
  assert.equal(signals[0].aborted, true);
  const second = mountView(stack);
  assert.equal(signals[1].aborted, false);
  stack.dispose();
  assert.equal(signals[1].aborted, true);
  second.unmount();
});
test("SSR 请求销毁也会中止 lazy loader，渲染等待能够退出", async () => {
  let signal;
  const component = lazy((value) => {
    signal = value;
    return new Promise((_resolve, reject) =>
      value.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  const { stack } = await create({ home: tab(component) });
  const rendered = renderToString(createSSRApp({ render: () => h(PageStackView, { stack }) }));
  await flush();
  assert.equal(signal.aborted, false);
  stack.dispose();
  assert.equal(signal.aborted, true);
  await rendered;
});
test("真实 script setup 与模板正确解包参数 Ref，并响应缓存参数更新", async () => {
  const source = `<script setup lang="ts">
import {usePage} from 'muvra';
const {params, visible}=usePage<{message:string}>();
</script><template><p data-sfc>{{params.message}}:{{visible}}</p></template>`;
  const { descriptor } = parse(source, { filename: "PageSmoke.vue" });
  const compiled = compileScript(descriptor, { id: "page-stack-smoke", inlineTemplate: true });
  const output = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  await mkdir(resolve("reports/sfc"), { recursive: true });
  const directory = await mkdtemp(resolve("reports/sfc/fixture-"));
  const file = resolve(directory, "compiled.mjs");
  await writeFile(file, output);
  const { default: component } = await import(pathToFileURL(file).href);
  const { stack } = await create(
    { home: tab(component) },
    { initial: [{ name: "home", params: { message: "compiled SFC" } }] },
  );
  const view = mountView(stack);
  await flush();
  assert.ok(text(view.root).includes("compiled SFC:true"));
  await stack.switchTab({ name: "home", params: { message: "updated SFC" } });
  await flush();
  assert.ok(text(view.root).includes("updated SFC:true"));
  view.unmount();
  stack.dispose();
});

test("忽略中止的 loader 也不会阻塞 SSR 销毁，迟到拒绝保持已处理", async () => {
  let signal, reject;
  const component = lazy((value) => {
    signal = value;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const { stack, errors } = await create({ home: tab(component) });
  const rendered = renderToString(createSSRApp({ render: () => h(PageStackView, { stack }) }));
  await flush();
  assert.equal(signal.aborted, false);
  stack.dispose();
  assert.equal(signal.aborted, true);
  // loader 始终不响应 signal，只有框架主动停止等待才会先于计时器返回。
  let timer;
  try {
    await Promise.race([
      rendered,
      new Promise((_resolve, fail) => {
        timer = setTimeout(() => fail(new Error("SSR remained blocked after dispose")), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  reject(new Error("late loader rejection"));
  await flush();
  assert.deepEqual(errors, []);
});
test("零动画下连续排队往返不会复用已卸载的页面上下文", async () => {
  const contexts = new Map();
  const component = (name) =>
    defineComponent({
      setup() {
        const context = usePage();
        contexts.set(name, context);
        return () => h("p", `${name}:${context.params.value?.value ?? ""}`);
      },
    });
  const { stack } = await create(
    { home: tab(blank), a: page(component("a")), b: page(component("b")) },
    { renderDepth: 1, transitionDurationMs: 0, maxQueue: 200 },
  );
  const view = mountView(stack);
  const commands = [];
  for (let index = 0; index < 30; index++) {
    commands.push(stack.push({ name: "a", params: { value: index } }));
    commands.push(stack.push({ name: "b" }));
    commands.push(stack.back());
  }
  const results = await Promise.all(commands);
  await flush();
  assert.ok(results.every((result) => result.status === "completed"));
  assert.equal(contexts.get("a").signal.aborted, false);
  assert.equal(contexts.get("a").params.value.value, 29);
  assert.equal(contexts.get("a").visible.value, true);
  assert.equal(contexts.get("b").signal.aborted, true);
  assert.deepEqual(view.errors, []);
  view.unmount();
  stack.dispose();
});

test("页面上下文恢复保留导航 info，旧组件作用域不能恢复重挂后的拦截", async () => {
  const contexts = [];
  const observed = [];
  let allowed = false;
  const login = defineComponent({
    setup() {
      contexts.push(usePage());
      return () => h("p", "login");
    },
  });
  const { stack } = await create(
    { home: tab(blank), target: page(blank), login: page(login) },
    {
      onNavigation: (event) => observed.push(event),
    },
  );
  stack.beforeEach(({ to }) => {
    if (to.name === "target" && !allowed) return { name: "login" };
  });
  let view = mountView(stack);
  const info = { arbitrary: "business" };
  const intercepted = await stack.push({ name: "target" }, { info });
  await flush();
  const old = contexts.at(-1);
  view.unmount();
  view = mountView(stack);
  await flush();
  assert.equal((await old.resume()).reason, "not-intercepted");
  allowed = true;
  const resumed = await contexts.at(-1).resume();
  assert.equal(resumed.info, info);
  assert.equal(resumed.resumedFromId, intercepted.id);
  const terminal = observed.filter(
    (event) => event.type === "settled" && event.operation === "resume",
  );
  assert.equal(terminal.length, 2);
  assert.equal(terminal[1].info, info);
  view.unmount();
  stack.dispose();
});
