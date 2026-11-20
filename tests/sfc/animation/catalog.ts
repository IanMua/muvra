import { dissolve, fade, glow, overlay } from "../../../demo/transitions/effects.js";
import { reactive, ref, shallowRef } from "vue";
import {
  compose,
  createPageStack,
  definePages,
  defineTransition,
  page,
  popup,
  sequence,
  tab,
} from "muvra";
import type { Diagnostic, NavigationResult, TransitionEffect } from "muvra";
import HomeScene from "./HomeScene.vue";
import DissolveScene from "./DissolveScene.vue";
import GlowScene from "./GlowScene.vue";
import PopupScene from "./PopupScene.vue";
import GlowLayer from "./GlowLayer.vue";
import FailureLayer from "./FailureLayer.vue";

/** 每个演示宿主持有自己的实例及观测数据，重复挂载和双实例验证互不共享动画资源。 */
export function createAnimationLab(
  options: { timeoutMs?: number; duration?: number; disabled?: boolean } = {},
) {
  const duration = options.duration ?? 1_200;
  const telemetry = reactive({ mounted: 0, unmounted: 0, activeTimers: 0 });
  const steps = ref<string[]>([]);
  const diagnostics = shallowRef<readonly Diagnostic[]>([]);
  const result = shallowRef<NavigationResult>();
  const visible = ref(true);
  const record = (name: string, effect: TransitionEffect) =>
    defineTransition({
      duration: effect.duration,
      run: async (scope) => {
        steps.value.push(`${name}:start`);
        await scope.play(effect);
        steps.value.push(`${name}:end`);
      },
    });
  const pause = (time: number) =>
    defineTransition({ duration: time, run: (scope) => scope.wait(time) });
  const pages = definePages({
    home: tab(HomeScene, { transition: fade({ duration: 180 }) }),
    dissolve: page(DissolveScene, { transition: dissolve({ duration }) }),
    glow: page(GlowScene, {
      transition: compose(
        fade({ duration: 400 }),
        glow({ duration: 900 }),
        overlay(GlowLayer, { duration: 1_100, props: { telemetry } }),
      ),
    }),
    staged: page(GlowScene, {
      transition: sequence(
        record(
          "prepare",
          defineTransition({
            duration: 180,
            run: async (scope) => {
              // 编排准备阶段保留旧画面，防止揭幕开始前提前露出目标页。
              scope.style(scope.to, { visibility: "hidden" });
              await scope.wait(180);
            },
          }),
        ),
        record(
          "reveal",
          defineTransition({
            duration: 600,
            run: async (scope) => {
              scope.style(scope.to, { visibility: "visible" });
              await scope.play(compose(dissolve({ duration: 500 }), glow({ duration: 600 })));
            },
          }),
        ),
        record("settle", pause(100)),
      ),
    }),
    dialog: popup(PopupScene, {
      transition: compose(dissolve({ duration: 650 }), glow({ duration: 700 })),
    }),
    secondDialog: popup(PopupScene, {
      transition: compose(
        fade({ duration: 200 }),
        overlay(GlowLayer, { duration: 500, props: { telemetry } }),
      ),
    }),
    broken: page(GlowScene, { transition: compose(glow(), overlay(FailureLayer)) }),
    partial: page(GlowScene, {
      transition: defineTransition({
        duration: 700,
        run(scope) {
          void scope.animate(scope.to, [{ opacity: 0 }, { opacity: 1 }]);
          throw new Error("intentional-partial-start-error");
        },
      }),
    }),
    hanging: page(GlowScene, {
      transition: defineTransition({
        duration: 100,
        run: async (scope) => {
          await scope.layer(GlowLayer, { telemetry });
          await scope.wait(60_000);
        },
      }),
    }),
  });
  const stack = createPageStack({
    pages,
    initial: [{ name: "home" }],
    ...(options.timeoutMs === undefined ? {} : { transitionTimeoutMs: options.timeoutMs }),
    ...(options.disabled ? { transitionDurationMs: 0 } : {}),
    onError: (diagnostic) => {
      diagnostics.value = [...diagnostics.value, diagnostic];
    },
  });
  let lastAbort: AbortController | undefined;
  const save = async (pending: Promise<NavigationResult>) => {
    result.value = await pending;
    return result.value;
  };
  const open = (name: "dissolve" | "glow" | "staged" | "broken" | "partial" | "hanging") => {
    lastAbort = new AbortController();
    return save(
      name === "dissolve"
        ? stack.push(
            { name, params: { orderNo: "order-animation-42" } },
            { signal: lastAbort.signal },
          )
        : stack.push({ name }, { signal: lastAbort.signal }),
    );
  };
  return {
    stack,
    telemetry,
    steps,
    diagnostics,
    result,
    visible,
    open,
    back: () => save(stack.back()),
    popup: () => save(stack.openPopup({ name: "dialog", params: { message: "First popup" } })),
    secondPopup: () =>
      save(stack.openPopup({ name: "secondDialog", params: { message: "Second popup" } })),
    closePopup: () => save(stack.closePopup()),
    abort: () => lastAbort?.abort("demo-abort"),
  };
}
