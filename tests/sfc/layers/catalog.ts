import { h, reactive, ref } from "vue";
import {
  createLayerStack,
  createPageStack,
  defineExtension,
  definePages,
  defineTransition,
  page,
  popup,
  tab,
} from "muvra";
import { backdrop } from "muvra/extensions/backdrop";
import type { NavigationResult } from "muvra";
import HomeScene from "./HomeScene.vue";
import OrderScene from "./OrderScene.vue";
import PopupCard from "./PopupCard.vue";

/** 同时提供导航页面和独立图层，证明装饰层不需要伪造路由或操作导航历史。 */
export function createLayerLab(options: { duration?: number } = {}) {
  const telemetry = reactive({ defaults: 0, scripts: 0 });
  const blocked = ref(false);
  const result = ref<NavigationResult>();
  const diagnostics = ref<string[]>([]);
  const duration = options.duration ?? 650;
  const motion = defineTransition({
    duration,
    run(scope) {
      const leaving = scope.operation === "back" || scope.operation === "closePopup";
      return scope.animate(
        leaving ? scope.from : scope.to,
        leaving
          ? [
              { transform: "translateY(0)", opacity: 1 },
              { transform: "translateY(12%)", opacity: 0 },
            ]
          : [
              { transform: "translateY(12%)", opacity: 0 },
              { transform: "translateY(0)", opacity: 1 },
            ],
      );
    },
  });
  const track = defineExtension({
    key: "declaration-lifetime",
    setup(context) {
      telemetry.defaults++;
      context.onCleanup(() => {
        telemetry.defaults--;
      });
    },
  });
  const pages = definePages({
    home: tab(HomeScene),
    order: page(OrderScene, { transition: motion, extensions: [backdrop(), track] }),
    dialog: popup(PopupCard, {
      transition: motion,
      extensions: [backdrop({ color: "#17314f", opacity: 0.22 }), track],
    }),
  });
  const stack = createPageStack({
    pages,
    initial: [{ name: "home" }],
    onError: (entry) => diagnostics.value.push(entry.error.message),
  });
  stack.beforeEach(() => {
    if (blocked.value) {
      blocked.value = false;
      return false;
    }
  });
  const save = async (pending: Promise<NavigationResult>) => {
    result.value = await pending;
    return result.value;
  };
  const scene = createLayerStack();
  const opacity = ref(0.3);
  const lower = scene.create({
    content: () => h("div", { class: "standalone-base" }, "普通内容图层 · 没有路由"),
  });
  const upper = scene.create({ content: () => h("div", { class: "standalone-card" }, "前景图层") });
  scene.order([lower.anchor, upper.anchor]);
  // 业务自己创建中间层，和可选 backdrop 扩展使用完全相同的公开接口。
  const shade = scene.create({
    placement: { above: lower.anchor, below: upper.anchor },
    style: () => ({ background: "#0b152a", opacity: opacity.value }),
  });
  return {
    stack,
    scene,
    opacity,
    telemetry,
    diagnostics,
    result,
    blocked,
    popup: (title: string, dynamic = true) =>
      save(stack.openPopup({ name: "dialog", params: { title, dynamic } })),
    order: () => save(stack.push({ name: "order", params: { orderNo: "42" } })),
    back: () => save(stack.back()),
    reset: () => save(stack.reset([{ name: "home" }])),
    removeShade: () => shade.dispose(),
    dispose() {
      stack.dispose();
      scene.dispose();
    },
  };
}
