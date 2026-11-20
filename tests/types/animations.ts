import { dissolve, fade, glow, overlay } from "../../demo/transitions/effects.js";
import { h } from "vue";
import {
  compose,
  createPageStack,
  definePages,
  defineTransition,
  page,
  PageStackView,
  sequence,
  tab,
} from "../../src/index.js";
import type { TransitionEffect, TransitionScope } from "../../src/index.js";
const component = { render: () => null };
const custom = defineTransition({
  duration: 200,
  run: async (scope: TransitionScope) => {
    const layer = await scope.layer(component);
    scope.onCleanup(() => {});
    scope.style(layer, { opacity: "0.5" });
    await scope.animate(layer, [{ opacity: 0 }, { opacity: 1 }]);
  },
});
const effect: TransitionEffect = sequence(
  fade(),
  compose(dissolve({ duration: 650 }), glow(), overlay(component)),
  custom,
);
const pages = definePages({
  home: tab(component),
  detail: page.withParams<{ orderNo: string }>()(component, { transition: effect }),
});
const stack = createPageStack({ pages, initial: [{ name: "home" }] });
h(PageStackView, { stack, transition: effect });
stack.push({ name: "detail", params: { orderNo: "42" } });
// @ts-expect-error 动画声明仍要求数字时长。
fade({ duration: "fast" });
// @ts-expect-error 溶解按线性阈值推进，不宣称支持未实现的 CSS 缓动。
dissolve({ easing: "ease" });
// @ts-expect-error 编排只接受可管理的效果，原始驱动应先包装为 defineTransition。
compose(() => {});
// @ts-expect-error 新动画 API 不应破坏页面参数的必填约束。
stack.push({ name: "detail" });
