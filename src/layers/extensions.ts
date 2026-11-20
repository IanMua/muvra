import { notify } from "../notifications.js";
import { shallowRef } from "vue";
import { createResourceScope } from "./resources.js";
import type { Cleanup } from "./resources.js";
import type {
  LayerAnchor,
  LayerHandle,
  LayerLayout,
  LayerOptions,
  LayerStack,
  LayerStyles,
  LayerStyleSource,
} from "./types.js";

export interface ExtensionContext {
  readonly owner: LayerAnchor;
  readonly signal: AbortSignal;
  readonly styles: LayerStyles;
  readonly layers: {
    create(options?: Omit<LayerOptions, "owner" | "group">): LayerHandle;
    getElement(anchor: LayerAnchor): HTMLElement | undefined;
  };
  onLayout(listener: (layout: LayerLayout) => void): () => void;
  onCleanup(cleanup: Cleanup): () => void;
}
export interface ExtensionDefinition<P extends object = any> {
  readonly key: string | symbol;
  readonly options: Readonly<P>;
  /** 合并由扩展解释；内核不对业务配置进行深合并。 */
  readonly mergeOptions?: (base: Readonly<P>, override: Readonly<P>) => P;
  readonly setup: (context: ExtensionContext, options: Readonly<P>) => void | Cleanup;
}
export interface ExtensionHost {
  extend(definition: ExtensionDefinition): () => void;
  dispose(): void;
}
// 扩展创建的装饰层有独立分组，默认布局订阅不会把装饰层再次当成基础内容。
const decorationGroup = Symbol("extension-layers");

/** 定义可以复用，DOM、响应式订阅和取消句柄必须在每个宿主的 setup 中创建。 */
export function defineExtension<P extends object = Record<string, never>>(
  definition: Omit<ExtensionDefinition<P>, "options"> & { readonly options?: Readonly<P> },
): ExtensionDefinition<P> {
  if (
    (typeof definition.key !== "string" && typeof definition.key !== "symbol") ||
    definition.key === "" ||
    typeof definition.setup !== "function" ||
    (definition.mergeOptions !== undefined && typeof definition.mergeOptions !== "function")
  )
    throw new TypeError("An extension requires a key and a setup function.");
  return Object.freeze({
    ...definition,
    options: Object.freeze({ ...definition.options }) as Readonly<P>,
  });
}

export function validExtension(value: unknown): value is ExtensionDefinition {
  if (!value || typeof value !== "object") return false;
  const entry = value as ExtensionDefinition;
  return (
    (typeof entry.key === "symbol" || (typeof entry.key === "string" && entry.key.length > 0)) &&
    typeof entry.setup === "function" &&
    Boolean(entry.options && typeof entry.options === "object") &&
    (entry.mergeOptions === undefined || typeof entry.mergeOptions === "function")
  );
}

/** 同一个 key 只安装一次；脚本贡献撤销后，重新计算声明层配置而不保留旧闭包。 */
export function createExtensionHost(
  layers: LayerStack,
  owner: LayerHandle,
  defaults: readonly ExtensionDefinition[] = [],
  options: { readonly group?: symbol; readonly onError?: (error: unknown) => void } = {},
): ExtensionHost {
  if (layers.signal.aborted || owner.signal.aborted || !layers.has(owner.anchor))
    throw new Error("Extension owner must belong to the active layer stack.");
  const report = (error: unknown) =>
    notify(
      () => options.onError?.(error),
      () => {},
    );
  const lifetime = createResourceScope(report);
  const declarations = Object.freeze([...defaults]);
  const contributions = new Map<symbol, ExtensionDefinition>();
  const instances = new Map<
    string | symbol,
    {
      readonly setup: ExtensionDefinition["setup"];
      readonly config: ReturnType<typeof shallowRef<object>>;
      readonly scope: ReturnType<typeof createResourceScope>;
    }
  >();
  let reconciling = false,
    dirty = false;
  const host: ExtensionHost = {
    extend(definition) {
      if (lifetime.signal.aborted) throw new Error("Extension host is disposed.");
      if (!validExtension(definition)) throw new TypeError("Invalid extension definition.");
      const token = Symbol("extension-contribution");
      contributions.set(token, definition);
      reconcile();
      return () => {
        if (contributions.delete(token) && !lifetime.signal.aborted) reconcile();
      };
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.dispose();
      for (const instance of instances.values()) instance.scope.dispose();
      instances.clear();
      contributions.clear();
    },
  };
  function reconcile() {
    dirty = true;
    if (reconciling || lifetime.signal.aborted) return;
    reconciling = true;
    try {
      while (dirty && !lifetime.signal.aborted) {
        dirty = false;
        const merged = new Map<string | symbol, ExtensionDefinition>();
        for (const definition of [...declarations, ...contributions.values()]) {
          if (!validExtension(definition)) throw new TypeError("Invalid extension definition.");
          const previous = merged.get(definition.key);
          merged.set(
            definition.key,
            previous && previous.setup === definition.setup
              ? {
                  ...definition,
                  options:
                    definition.mergeOptions?.(previous.options, definition.options) ??
                    definition.options,
                }
              : definition,
          );
        }
        for (const [key, instance] of instances) {
          if (merged.get(key)?.setup !== instance.setup) {
            instances.delete(key);
            instance.scope.dispose();
          }
        }
        for (const [key, definition] of merged) {
          const previous = instances.get(key);
          if (previous) {
            previous.config.value = definition.options;
            continue;
          }
          const scope = createResourceScope(report);
          const config = shallowRef<object>(definition.options);
          instances.set(key, { setup: definition.setup, config, scope });
          // 配置整体替换只触发一次更新；getter 始终读取当前贡献，不捕获首次 options。
          const live = new Proxy(
            {},
            {
              get: (_target, property) => Reflect.get(config.value, property),
              has: (_target, property) => Reflect.has(config.value, property),
              ownKeys: () => Reflect.ownKeys(config.value),
              getOwnPropertyDescriptor: (_target, property) =>
                Reflect.has(config.value, property)
                  ? {
                      configurable: true,
                      enumerable: true,
                      value: Reflect.get(config.value, property),
                      writable: false,
                    }
                  : undefined,
              set: () => false,
            },
          );
          const active = () => {
            if (scope.signal.aborted || owner.signal.aborted)
              throw new Error("Extension scope is disposed.");
          };
          const context: ExtensionContext = Object.freeze({
            owner: owner.anchor,
            signal: scope.signal,
            styles: Object.freeze({
              bind(source: LayerStyleSource) {
                active();
                return scope.own(owner.styles.bind(source));
              },
            }),
            layers: Object.freeze({
              create(input = {}) {
                active();
                const layer = layers.create({
                  ...input,
                  owner: owner.anchor,
                  group: decorationGroup,
                });
                let release = () => {};
                release = scope.own(() => {
                  layer.signal.removeEventListener("abort", release);
                  layer.dispose();
                });
                // 主动销毁的短命图层立即移除登记，长寿命页面不会累计已结束的资源闭包。
                if (!layer.signal.aborted)
                  layer.signal.addEventListener("abort", release, { once: true });
                active();
                return layer;
              },
              getElement: layers.getElement,
            }),
            onLayout(listener: (layout: LayerLayout) => void) {
              active();
              const remove = layers.onLayout(
                (layout) => {
                  if (scope.signal.aborted) return;
                  notify(() => listener(layout), report);
                },
                options.group ?? owner.group ?? null,
              );
              return scope.own(remove);
            },
            onCleanup: scope.own,
          });
          try {
            const cleanup = definition.setup(context, live);
            if (cleanup) scope.own(cleanup);
          } catch (error) {
            instances.delete(key);
            scope.dispose();
            report(error);
          }
        }
      }
    } catch (error) {
      report(error);
    } finally {
      reconciling = false;
    }
  }
  const abort = () => host.dispose();
  owner.signal.addEventListener("abort", abort, { once: true });
  lifetime.own(() => owner.signal.removeEventListener("abort", abort));
  if (owner.signal.aborted) host.dispose();
  else reconcile();
  return Object.freeze(host);
}
