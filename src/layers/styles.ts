import { effectScope, watch } from "vue";
import type { LayerStyle, LayerStyleSource } from "./types.js";

export function bindLayerStyle(
  source: LayerStyleSource,
  commit: (value: LayerStyle) => void,
  report: (error: unknown) => void,
) {
  // getter 内复制属性以追踪响应式字段；提交过程不参与依赖收集，避免发布形成循环。
  const effects = effectScope(true);
  let initializing = true,
    initialFailure = false,
    failure: unknown;
  let previous: LayerStyle = {};
  effects.run(() =>
    watch(
      () => {
        try {
          return (previous = { ...(typeof source === "function" ? source() : source) });
        } catch (error) {
          if (initializing) {
            initialFailure = true;
            failure = error;
          } else report(error);
          return previous;
        }
      },
      commit,
      { immediate: true, flush: "sync" },
    ),
  );
  initializing = false;
  if (initialFailure) {
    effects.stop();
    throw failure;
  }
  return () => effects.stop();
}
