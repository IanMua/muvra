import { defineComponent, h, inject, onScopeDispose } from "vue";
import type { Component } from "vue";
import { PageStackError } from "./errors.js";
import { PageKey } from "./context.js";
import { settle } from "./async.js";
import type { LazyPageComponent } from "./component-inputs.js";

/**
 * 按需加载的边界由框架持有，错误页重试会重新调用失败的 loader。
 * 组件卸载时发出中止信号并消费迟到拒绝，避免加载结果污染已离开的页面。
 */
export function lazy<C extends Component>(
  loader: (signal: AbortSignal) => PromiseLike<C | { default: C }>,
): LazyPageComponent<C> {
  if (typeof loader !== "function")
    throw new PageStackError("INVALID_CONFIG", "lazy requires a component loader.");
  let loaded: Component | undefined;
  const wrapper = defineComponent({
    name: "PageStackLazy",
    inheritAttrs: false,
    async setup(_props, { attrs, slots }) {
      const abort = new AbortController();
      const owner = inject(PageKey, undefined)?.record.abort.signal;
      const onOwnerAbort = () => abort.abort(owner?.reason);
      if (owner?.aborted) onOwnerAbort();
      else owner?.addEventListener("abort", onOwnerAbort, { once: true });
      onScopeDispose(() => {
        abort.abort("page-unmounted");
        owner?.removeEventListener("abort", onOwnerAbort);
      });
      if (abort.signal.aborted) return () => null;
      try {
        if (!loaded) {
          // 动态 import 等 loader 无法响应 signal 时，框架仍需结束 SSR/组件等待并消费迟到拒绝。
          const module = await settle(() => loader(abort.signal), {
            signal: abort.signal,
            timeoutMs: 0,
            empty: undefined,
          });
          const component =
            module && typeof module === "object" && "default" in module ? module.default : module;
          if (!component || !["object", "function"].includes(typeof component))
            throw new PageStackError(
              "INVALID_CONFIG",
              "Lazy loader did not return a Vue component.",
            );
          if (!abort.signal.aborted) loaded = component;
        }
        return () => (loaded && !abort.signal.aborted ? h(loaded, attrs, slots) : null);
      } catch (cause) {
        if (abort.signal.aborted) return () => null;
        throw cause;
      }
    },
  });
  // 仅保留 loader 的公开输入类型；包装器的运行时实例仍由本层拥有。
  return wrapper as unknown as LazyPageComponent<C>;
}
