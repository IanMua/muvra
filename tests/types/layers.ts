import { h, ref } from "vue";
import {
  createExtensionHost,
  createLayerStack,
  defineExtension,
  LayerStackView,
  page,
  popup,
  usePage,
} from "muvra";
import { backdrop } from "muvra/extensions/backdrop";

const opacity = ref(0.3);
const scene = createLayerStack();
const lower = scene.create();
const upper = scene.create({ placement: { above: lower.anchor }, interactive: true });
scene.order([lower.anchor, upper.anchor]);
h(LayerStackView, { stack: scene });
const extension = backdrop({ color: "#000", opacity: () => opacity.value });
const host = createExtensionHost(scene, upper, [extension]);
const release = host.extend(backdrop({ opacity }));
release();
const component = { render: () => null };
page(component, { extensions: [extension] });
popup(component, { extensions: [extension] });
const custom = defineExtension({
  key: "shape",
  options: { radius: 10 },
  setup(context, options) {
    context.styles.bind(() => ({ borderRadius: `${options.radius}px` }));
    const layer = context.layers.create({ placement: { below: context.owner } });
    context.onCleanup(() => layer.dispose());
  },
});
const register = () => usePage().extend(custom);
void register;
// @ts-expect-error 遮罩透明度只接受数字、Ref 或数字 getter。
backdrop({ opacity: "0.5" });
// @ts-expect-error 普通扩展不能获取页面图层的销毁权限。
custom.setup({ owner: { id: 1, dispose() {} } }, { radius: 1 });
// @ts-expect-error 样式贡献值不接受布尔类型。
upper.styles.bind({ opacity: true });
// @ts-expect-error 扩展定义必须提供 key，不能产生无法覆盖和撤销的匿名实例。
defineExtension({ setup() {} });
// @ts-expect-error 安装必须同步登记资源，不能把 Promise 当成清理函数。
defineExtension({ key: "async", async setup() {} });
// @ts-expect-error 框架根入口不再提供视觉预设。
import { dissolve } from "muvra";
void dissolve;
