import { waapiTransition } from "./transitions/waapi.js";
import { createApp, defineComponent, h, ref, shallowRef } from "vue";
import type { VNode } from "vue";
import { BehaviorSubject } from "rxjs";
import {
  createPageStack,
  definePages,
  page,
  popup,
  tab,
  PageStackView,
  usePage,
  useStackState,
  handleNativeBack,
  lazy,
} from "../src/index.js";
import type { Diagnostic, NavigationResult, PageStack, TransitionContext } from "../src/index.js";

// 实验宿主仅使用公开 API；浏览器测试通过 lab 读取公开结果，避免直接改写实例池。
const loggedIn = ref(false),
  rejectEntry = ref(false),
  mounted = ref(true),
  broken = ref(true);
const mode = ref("normal"),
  diagnostics: Diagnostic[] = [],
  lastResult = shallowRef<NavigationResult>();
const nativeDecision = ref("not requested");
const keyboard = ref(true),
  restoreFocus = ref(true),
  omitTransitionTransition = ref(false);
const counters: Record<string, number> = {};
const subjects = new Set<BehaviorSubject<boolean>>();
let driverCalls = 0,
  driverAborts = 0,
  detailId = 0;
const count = (name: string) => {
  counters[name] = (counters[name] ?? 0) + 1;
};
const command = async (promise: Promise<NavigationResult>): Promise<NavigationResult> => {
  const result = await promise;
  lastResult.value = result;
  return result;
};
// 同文件的目录和页面互相引用时，明确渲染边界，避免泛型导航类型形成推导循环。
const button = (label: string, click: () => unknown): VNode =>
  h("button", { type: "button", onClick: click }, label);
const Home = defineComponent({
  props: { tenant: String },
  setup(props) {
    const context = usePage();
    const draft = ref("");
    count("home:mount");
    context.onShow(() => count("home:show"));
    context.onHide(() => count("home:hide"));
    context.onUnload(() => count("home:unload"));
    return (): VNode =>
      h("section", { class: "page" }, [
        h("h2", "Home"),
        h("p", { class: "shared" }, `Shared tenant: ${props.tenant}`),
        h("label", [
          "Home draft",
          h("input", {
            "aria-label": "Home draft",
            value: draft.value,
            onInput: (event: Event) => {
              draft.value = (event.target as HTMLInputElement).value;
            },
          }),
        ]),
        h("div", { class: "actions" }, [
          button("Open detail", () =>
            command(
              stack.push({
                name: "detail",
                params: { id: String(++detailId) },
              }),
            ),
          ),
          button("Open dialog", () =>
            command(
              stack.openPopup({
                name: "dialog",
                params: { title: "First dialog" },
              }),
            ),
          ),
          button("Orders Tab", () => command(stack.switchTab({ name: "orders" }))),
        ]),
      ]);
  },
});
const Detail = defineComponent({
  props: { id: { type: String, required: true }, tenant: String },
  setup(props) {
    const context = usePage();
    const draft = ref("");
    const block = ref(false);
    const guard = new BehaviorSubject(true);
    subjects.add(guard);
    count("detail:mount");
    context.beforeBack(() => guard);
    context.onUnload(() => {
      count("detail:unload");
      subjects.delete(guard);
      guard.complete();
    });
    return (): VNode =>
      h("section", { class: "page" }, [
        h("h2", `Detail ${props.id}`),
        h("label", [
          "Detail draft",
          h("input", {
            "aria-label": "Detail draft",
            value: draft.value,
            onInput: (e: Event) => {
              draft.value = (e.target as HTMLInputElement).value;
            },
          }),
        ]),
        h("label", [
          h("input", {
            type: "checkbox",
            checked: block.value,
            onChange: (e: Event) => {
              block.value = (e.target as HTMLInputElement).checked;
              guard.next(!block.value);
            },
          }),
          "Block back",
        ]),
        h("div", { class: "actions" }, [
          button("Back", () => command(stack.back())),
          button("Open another detail", () =>
            command(
              stack.push({
                name: "detail",
                params: { id: String(++detailId) },
              }),
            ),
          ),
          button("Open dialog", () =>
            command(
              stack.openPopup({
                name: "dialog",
                params: { title: "Detail dialog" },
              }),
            ),
          ),
        ]),
      ]);
  },
});
const Login = defineComponent({
  setup() {
    const context = usePage();
    return (): VNode =>
      h("section", { class: "page" }, [
        h("h2", "Login"),
        h("p", `Intercepted: ${context.isIntercepted.value}`),
        button("Sign in and resume", () => {
          loggedIn.value = true;
          return command(context.resume());
        }),
      ]);
  },
});
const Orders = defineComponent({
  setup() {
    return (): VNode =>
      h("section", { class: "page" }, [
        h("h2", "Orders"),
        button("Home Tab", () => command(stack.switchTab({ name: "home" }))),
      ]);
  },
});
const Dialog = defineComponent({
  props: { title: { type: String, required: true } },
  setup(props) {
    const draft = ref("");
    const context = usePage();
    context.onUnload(() => count("dialog:unload"));
    return (): VNode =>
      h("div", { class: "overlay" }, [
        h("div", { class: "card" }, [
          h("h2", String(props.title)),
          h("label", [
            "Popup draft",
            h("input", {
              "aria-label": "Popup draft",
              value: draft.value,
              onInput: (e: Event) => {
                draft.value = (e.target as HTMLInputElement).value;
              },
            }),
          ]),
          h("div", { class: "actions" }, [
            button("Nested dialog", () =>
              command(
                stack.openPopup({
                  name: "dialog",
                  params: { title: "Nested dialog" },
                }),
              ),
            ),
            button("Close", () => command(stack.closePopup())),
          ]),
        ]),
      ]);
  },
});
const Broken = defineComponent({
  setup() {
    const context = usePage();
    context.onUnload(() => count("broken:unload"));
    if (broken.value) throw new Error("Injected component failure");
    return (): VNode =>
      h("section", { class: "page" }, [
        h("h2", "Recovered page"),
        button("Back", () => command(stack.back())),
      ]);
  },
});
const pages = definePages({
  home: tab(Home, { meta: { title: "Home" } }),
  orders: tab(Orders, { meta: { auth: true } }),
  detail: page(Detail, {
    validate: (value) =>
      typeof (value as { id?: unknown })?.id === "string" || "Detail id must be a string.",
  }),
  login: page(Login),
  dialog: popup(Dialog, { meta: { title: "Dialog" } }),
  broken: page(Broken),
  lazy: page(
    lazy(async (signal) => {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("load aborted"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 200);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return defineComponent({
        setup: () => (): VNode =>
          h("section", { class: "page" }, [
            h("h2", "Lazy page ready"),
            button("Back", () => command(stack.back())),
          ]),
      });
    }),
  ),
});
const stack = createPageStack({
  pages,
  initial: [{ name: "home" }],
  transitionDurationMs: 65,
  transitionTimeoutMs: 150,
  guardTimeoutMs: 300,
  onError: (d) => diagnostics.push(d),
});
stack.beforeEach(({ to }) => {
  if (rejectEntry.value) return false;
  if (to?.meta.auth && !loggedIn.value) return { name: "login" };
});
const Secondary = defineComponent({
  setup: () => (): VNode =>
    h("section", { class: "page" }, [h("h2", "Independent stack"), h("p", "Instance B")]),
});
const secondary = createPageStack({
  pages: { home: tab(Secondary) },
  initial: [{ name: "home" }],
  onError: (d) => diagnostics.push(d),
});
const spare = createPageStack({
  pages: {
    home: tab(
      defineComponent({
        setup: () => (): VNode => h("section", { class: "page" }, "Swapped instance"),
      }),
    ),
  },
  initial: [{ name: "home" }],
});
const mainStack = shallowRef<PageStack<any>>(stack);
async function transition(context: TransitionContext): Promise<void> {
  driverCalls++;
  if (mode.value === "throw") throw new Error("Injected driver failure");
  if (mode.value === "hang") {
    context.signal.addEventListener(
      "abort",
      () => {
        driverAborts++;
      },
      { once: true },
    );
    return new Promise(() => {});
  }
  if (mode.value === "partial" && context.to) {
    const animate = context.to.animate;
    context.to.animate = () => {
      throw new Error("Injected second-track failure");
    };
    try {
      await waapiTransition(context);
    } finally {
      context.to.animate = animate;
    }
  } else await waapiTransition(context);
}
const App = defineComponent({
  setup() {
    const state = useStackState(stack);
    return (): VNode =>
      h("main", [
        h("header", [
          h("h1", "Muvra"),
          h("p", "独立实验 · 原项目保持不变 · Core / Vue / API / Browser"),
        ]),
        h("div", { class: "toolbar" }, [
          button("Home Tab", () => command(stack.switchTab({ name: "home" }))),
          button("Reset home", () => command(stack.reset([{ name: "home" }]))),
          button("Native Back", () => {
            // 原生桥接需要立即决定是否退出；网页守卫继续异步执行。
            nativeDecision.value = handleNativeBack(stack);
          }),
          button("Dynamic dialog", () =>
            command(stack.openDynamicPopup(popup(Dialog), { title: "Dynamic dialog" })),
          ),
          button("Lazy page", () => command(stack.push({ name: "lazy" }))),
          button("Break page", () => command(stack.push({ name: "broken" }))),
          button("Recover component", () => {
            broken.value = false;
          }),
          button("Toggle view", () => {
            mounted.value = !mounted.value;
          }),
          button("Swap instance", () => {
            mainStack.value = mainStack.value === spare ? stack : spare;
          }),
        ]),
        h("div", { class: "frames" }, [
          h(
            "div",
            { class: "frame", "data-main-frame": "" },
            mounted.value
              ? h(PageStackView, {
                  stack: mainStack.value,
                  pageProps: { tenant: "demo-tenant" },
                  // 宿主可以把交互交给自身 UI 库；省略 transition 时验证框架不隐式播放动画。
                  keyboard: keyboard.value,
                  restoreFocus: restoreFocus.value,
                  ...(omitTransitionTransition.value ? {} : { transition }),
                })
              : h("p", "View unmounted"),
          ),
          h(
            "div",
            { class: "frame secondary", "data-secondary-frame": "" },
            h(PageStackView, { stack: secondary, transition: false }),
          ),
        ]),
        h(
          "pre",
          { class: "status", "data-status": "" },
          JSON.stringify(
            {
              phase: state.value.phase,
              history: state.value.history.map((r) => r.name),
              popups: state.value.popups.map((r) => r.name),
              last: lastResult.value?.status,
              transition:
                lastResult.value?.status === "completed" ? lastResult.value.transition : undefined,
              diagnostics: diagnostics.length,
              nativeDecision: nativeDecision.value,
            },
            null,
            2,
          ),
        ),
        h("p", { class: "caption" }, "此页面用于验证框架行为，不连接业务后端。"),
      ]);
  },
});
await Promise.all([stack.ready, secondary.ready, spare.ready]);
const app = createApp(App);
app.mount("#app");
Object.assign(window, {
  lab: {
    stack,
    secondary,
    diagnostics,
    counters,
    setMode(value: string) {
      mode.value = value;
    },
    setViewOptions(value: {
      keyboard?: boolean;
      restoreFocus?: boolean;
      omitTransition?: boolean;
    }) {
      if (value.keyboard !== undefined) keyboard.value = value.keyboard;
      if (value.restoreFocus !== undefined) restoreFocus.value = value.restoreFocus;
      if (value.omitTransition !== undefined) omitTransitionTransition.value = value.omitTransition;
    },
    setEntryRejected(value: boolean) {
      rejectEntry.value = value;
    },
    recover() {
      broken.value = false;
    },
    guardObservers() {
      return [...subjects].reduce((sum, source) => sum + source.observers.length, 0);
    },
    driverStats() {
      return { calls: driverCalls, aborts: driverAborts };
    },
    result() {
      return lastResult.value;
    },
    teardown() {
      app.unmount();
      stack.dispose();
      secondary.dispose();
      spare.dispose();
    },
  },
});
