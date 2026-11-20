import { toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";
import { defineExtension } from "../index.js";
import type { ExtensionContext, LayerHandle } from "../index.js";

export interface BackdropOptions {
  readonly color?: MaybeRefOrGetter<string>;
  readonly opacity?: MaybeRefOrGetter<number>;
}
const key = "page-stack:backdrop";
const mergeOptions = (base: Readonly<BackdropOptions>, override: Readonly<BackdropOptions>) => ({
  ...base,
  ...override,
});

/** 遮罩只是普通扩展：使用公开图层、布局订阅和资源作用域，不访问导航内核。 */
function setup(context: ExtensionContext, options: Readonly<BackdropOptions>) {
  let layer: LayerHandle | undefined;
  context.onLayout(({ visible }) => {
    const foreground = visible.at(-1);
    const background = visible.at(-2);
    // 返回动画中焦点已经切换，实际前景仍是离开页；这里只按物理显示顺序判断。
    if (foreground !== context.owner || !background) {
      layer?.dispose();
      layer = undefined;
      return;
    }
    const placement = { above: background, below: foreground };
    if (layer) layer.place(placement);
    else
      layer = context.layers.create({
        placement,
        attrs: { "data-page-stack-backdrop": "", "aria-hidden": "true", inert: true },
        style: () => {
          const opacity = toValue(options.opacity) ?? 0.3;
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
            throw new RangeError("Backdrop opacity must be between 0 and 1.");
          return { background: toValue(options.color) ?? "#000", opacity };
        },
      });
  });
}
export function backdrop(options: BackdropOptions = {}) {
  return defineExtension({ key, options, mergeOptions, setup });
}
