import type { Component } from "vue";
import type { PageCatalog, PageDefinition, PageKind, PageOptions } from "./types.js";
import type { PageDefiner } from "./component-inputs.js";
import { PageStackError } from "./errors.js";
import { validExtension } from "./layers/extensions.js";
import { validTransition } from "./animation/effect.js";

/** 移除的字段选择不能在 JavaScript 调用中被静默忽略，声明处直接给出迁移原因。 */
function rejectParameterSelection(options: object): void {
  if (Object.hasOwn(options, "params"))
    throw new PageStackError(
      "INVALID_CONFIG",
      "Page parameter selection is no longer supported; declare inputs as component props.",
    );
}

/** 三种声明共享运行时构造；泛型推导只描述输入，不引入另一份页面注册或导航状态。 */
function createDefiner<K extends PageKind>(kind: K): PageDefiner<K> {
  const define = (component: Component, options: PageOptions = {}): PageDefinition<K> => {
    rejectParameterSelection(options);
    return Object.freeze({
      ...options,
      ...(options.extensions ? { extensions: Object.freeze([...options.extensions]) } : {}),
      kind,
      component,
    });
  };
  // 类型参数在运行时被擦除，显式入口与自动推导入口复用同一个构造过程。
  return Object.assign(define, { withParams: () => define }) as PageDefiner<K>;
}
export const page = createDefiner("page");
export const tab = createDefiner("tab");
export const popup = createDefiner("popup");
export function definePages<const C extends PageCatalog>(catalog: C): C {
  if (!catalog || typeof catalog !== "object" || !Object.keys(catalog).length) {
    throw new PageStackError("INVALID_CONFIG", "A non-empty page catalog is required.");
  }
  const copy: Record<string, PageDefinition> = Object.create(null);
  for (const [name, definition] of Object.entries(catalog)) {
    if (
      !name.trim() ||
      !definition ||
      !["page", "tab", "popup"].includes(definition.kind) ||
      !definition.component ||
      !["object", "function"].includes(typeof definition.component)
    ) {
      throw new PageStackError("INVALID_CONFIG", `Invalid definition for page "${name}".`);
    }
    if (definition.kind === "popup" && definition.cache) {
      throw new PageStackError("INVALID_CONFIG", `Popup "${name}" cannot retain closed instances.`);
    }
    rejectParameterSelection(definition);
    if (
      (definition.cache !== undefined && typeof definition.cache !== "boolean") ||
      (definition.beforeEnter !== undefined && typeof definition.beforeEnter !== "function") ||
      (definition.validate !== undefined && typeof definition.validate !== "function") ||
      !validTransition(definition.transition) ||
      (definition.extensions !== undefined &&
        (!Array.isArray(definition.extensions) || !definition.extensions.every(validExtension))) ||
      (definition.meta !== undefined && (!definition.meta || typeof definition.meta !== "object"))
    ) {
      throw new PageStackError("INVALID_CONFIG", `Invalid options for page "${name}".`);
    }
    copy[name] = Object.freeze({
      ...definition,
      meta: Object.freeze({ ...definition.meta }),
      ...(definition.extensions ? { extensions: Object.freeze([...definition.extensions]) } : {}),
    });
  }
  return Object.freeze(copy) as C;
}
