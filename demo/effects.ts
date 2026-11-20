import { createApp } from "vue";
import AnimationHost from "../tests/sfc/animation/AnimationHost.vue";
import { createAnimationLab } from "../tests/sfc/animation/catalog.js";

// 同一真实页面既能手动观察，也接受隔离浏览器验证；参数仅调整演示实例。
const query = new URLSearchParams(location.search);
const options = {
  ...(query.has("timeout") ? { timeoutMs: Number(query.get("timeout")) } : {}),
  ...(query.has("duration") ? { duration: Number(query.get("duration")) } : {}),
  disabled: query.has("disabled"),
};
export async function mountAnimationLab(
  target: Element | string,
  settings: Parameters<typeof createAnimationLab>[0] = {},
) {
  const lab = createAnimationLab(settings);
  await lab.stack.ready;
  const app = createApp(AnimationHost, { lab });
  app.mount(target);
  return { ...lab, unmount: () => app.unmount() };
}
Object.assign(window, { effectsLab: await mountAnimationLab("#app", options) });
