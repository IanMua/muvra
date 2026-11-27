import { createApp, h, ref } from "vue";
import { createPageStack, page, PageStackView, usePage } from "../../../src/index.js";
import type { BackSession, ProgressTransition } from "../../../src/index.js";

const config = new URLSearchParams(location.search);
const shown: string[] = [];
const runs: { to: string | undefined; frames: number[]; cleaned: boolean; targetWidth: number }[] =
  [];
const previewEnabled = ref(true);
let guard: "allow" | "wait" | "redirect" = "allow";
let decide: ((value: boolean) => void) | undefined;
let guardCalls = 0;

const scene = {
  setup() {
    const context = usePage();
    context.onShow(() => shown.push(context.route.value.name));
    context.beforeBack(() => {
      guardCalls++;
      if (guard === "wait")
        return new Promise<boolean>((resolve) => {
          decide = resolve;
        });
    });
    return () => h("h1", context.route.value.name);
  },
};
const motion: ProgressTransition = {
  kind: "progress",
  duration: 120,
  prepare(scope) {
    const run = {
      to: scope.toRoute?.name,
      frames: [] as number[],
      cleaned: false,
      targetWidth: scope.to?.getBoundingClientRect().width ?? 0,
    };
    runs.push(run);
    scope.onCleanup(() => {
      run.cleaned = true;
    });
    return (progress) => {
      run.frames.push(progress);
      scope.style(scope.from, { transform: `translateX(${Math.round(progress * 100)}%)` });
    };
  },
};
const stack = createPageStack({
  pages: { list: page(scene), detail: page(scene), login: page(scene), external: page(scene) },
  initial: [{ name: "list" }, { name: "detail" }],
  renderDepth: config.has("stand-in") ? 1 : 2,
  beforeEach: ({ operation, to }) => {
    if (guard === "redirect" && operation === "back" && to?.name === "list")
      return { name: "login" };
  },
});
await stack.ready;
let session: BackSession | undefined;
createApp({
  render: () =>
    h(PageStackView, {
      stack,
      transition: motion,
      backPreview: () => {
        if (!previewEnabled.value) return;
        return config.has("stand-in") ? () => h("h2", "List preview") : "mounted";
      },
    }),
}).mount("#fixture");

// 浏览器通过公开栈 API 发送手势，记录 DOM 之外的守卫和生命周期结果。
Object.assign(window, {
  backLab: {
    stack,
    runs,
    shown,
    guardCalls: () => guardCalls,
    setGuard: (value: typeof guard) => (guard = value),
    decide: (value: boolean) => decide?.(value),
    setPreview: (value: boolean) => (previewEnabled.value = value),
    begin() {
      const state = stack.getSnapshot().back;
      if ("token" in state) session = stack.beginBack(state.token);
      return Boolean(session);
    },
    update: (progress: number) => session?.update(progress),
    cancel: () => session?.cancel(),
    commit: () => session?.commit(),
  },
});
