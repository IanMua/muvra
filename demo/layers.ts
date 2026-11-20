import { createApp } from "vue";
import LayerHost from "../tests/sfc/layers/LayerHost.vue";
import { createLayerLab } from "../tests/sfc/layers/catalog.js";

// 真实 SFC 只使用公开包入口；外部实验不连接原项目业务接口。
export async function mountLayerLab(
  target: string | Element,
  options: Parameters<typeof createLayerLab>[0] = {},
) {
  const lab = createLayerLab(options);
  await lab.stack.ready;
  const app = createApp(LayerHost, { lab });
  app.mount(target);
  return { ...lab, unmount: () => app.unmount() };
}
Object.assign(window, {
  layerLab: await mountLayerLab("#app", {
    duration: Number(new URLSearchParams(location.search).get("duration") ?? 650),
  }),
});
