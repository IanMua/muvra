import { PageStackError } from "./errors.js";
import { notify } from "./notifications.js";
import type { HookKind, InternalPage } from "./internal.js";
import type { Diagnostic, PageDefinition, ResolvedRoute } from "./types.js";

/** 实例、缓存及生命周期共同拥有一个寿命边界，回收时统一释放所有回调和守卫。 */
export function createRecordStore(context: {
  definitionFor(name: string): PageDefinition | undefined;
  report(diagnostic: Diagnostic): void;
  navigationId(): number | undefined;
}) {
  const records = new Map<number, InternalPage>();
  let used = 0;
  const error = (_code: "HOOK_ERROR", message: string, cause: unknown) =>
    new PageStackError("HOOK_ERROR", message, cause);
  function emit(record: InternalPage, kind: HookKind): void {
    for (const hook of [...record.hooks[kind]]) {
      if (!hook.ready) continue;
      const navigationId = context.navigationId();
      notify(hook.callback, (cause) => {
        context.report({
          error: error("HOOK_ERROR", `Page "${record.route.name}" ${kind} hook failed.`, cause),
          navigationId,
          route: record.route,
          severity: "error",
        });
      });
    }
  }
  function drop(record: InternalPage): void {
    if (!record.alive) return;
    if (record.visible) {
      record.visible = false;
      emit(record, "hide");
    }
    record.focused = false;
    record.alive = false;
    record.abort.abort("page-unloaded");
    record.interception = undefined;
    emit(record, "unload");
    for (const hooks of Object.values(record.hooks)) hooks.clear();
    record.leaveGuards.clear();
    record.backGuards.clear();
    records.delete(record.route.id);
  }
  function ensure(routes: readonly ResolvedRoute[]): void {
    for (const route of routes) {
      const existing = records.get(route.id);
      if (existing) {
        existing.route = route;
        existing.lastUsed = ++used;
        continue;
      }
      records.set(route.id, {
        abort: new AbortController(),
        route,
        definition: context.definitionFor(route.name)!,
        visible: false,
        focused: false,
        alive: true,
        lastUsed: ++used,
        interception: undefined,
        hooks: { show: new Set(), hide: new Set(), unload: new Set() },
        leaveGuards: new Set(),
        backGuards: new Set(),
      });
    }
  }
  function prune(
    layers: readonly ResolvedRoute[],
    clearAll: boolean,
    maxCachedPages: number,
  ): void {
    const wanted = new Set(layers.map((route) => route.id));
    for (const record of [...records.values()]) {
      if (wanted.has(record.route.id)) continue;
      const keep = record.definition.cache ?? record.route.kind === "tab";
      if (clearAll || !keep || record.route.kind === "popup") drop(record);
    }
    const cached = [...records.values()]
      .filter((record) => !wanted.has(record.route.id))
      .sort((a, b) => b.lastUsed - a.lastUsed);
    for (const record of cached.slice(maxCachedPages)) drop(record);
  }
  function hook(id: number, kind: HookKind, callback: () => void) {
    const record = records.get(id);
    const hook = { callback, ready: kind === "unload" };
    record?.hooks[kind].add(hook);
    return {
      activate() {
        if (hook.ready || !record?.alive) return;
        hook.ready = true;
        if ((kind === "show" && record.visible) || (kind === "hide" && !record.visible)) {
          const navigationId = context.navigationId();
          notify(callback, (cause) => {
            context.report({
              error: error("HOOK_ERROR", `Page "${record.route.name}" ${kind} hook failed.`, cause),
              navigationId,
              route: record.route,
              severity: "error",
            });
          });
        }
      },
      remove() {
        record?.hooks[kind].delete(hook);
      },
    };
  }
  return { records, ensure, prune, drop, emit, hook };
}
