import { PageStackError } from "./errors.js";
import { notify } from "./notifications.js";
import type {
  BeforeNavigate,
  Diagnostic,
  NavigationEvent,
  NavigationListener,
  NavigationRequest,
  NavigationResult,
} from "./types.js";

/** 管理每实例的扩展点；引擎决定执行时机，本模块不操作导航历史或解释业务数据。 */
export function createNavigationLifecycle(report: (diagnostic: Diagnostic) => void) {
  const handlers = new Set<BeforeNavigate>();
  const listeners = new Set<NavigationListener>();
  const pending = new Set<number>();
  const events: NavigationEvent[] = [];
  let closing = false;
  let emitting = false;

  function release(): void {
    if (closing && !pending.size && !emitting) listeners.clear();
  }
  function emit(event: NavigationEvent): void {
    events.push(event);
    if (emitting) return;
    emitting = true;
    try {
      // 回调可能同步取消或销毁导航，先广播当前事件，再按序广播由它产生的终态。
      while (events.length) {
        const current = events.shift()!;
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          notify(
            () => listener(current),
            (cause) =>
              report({
                error: new PageStackError("SUBSCRIBER_ERROR", "Navigation listener failed.", cause),
                navigationId: current.id,
                route: current.type === "settled" ? current.result.state.top : undefined,
                severity: "error",
              }),
          );
        }
      }
    } finally {
      emitting = false;
      release();
    }
  }

  return {
    beforeNavigate(handler: BeforeNavigate): () => void {
      if (typeof handler !== "function")
        throw new PageStackError("INVALID_CONFIG", "Navigation preprocessor must be a function.");
      if (!closing) handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onNavigation(listener: NavigationListener): () => void {
      if (typeof listener !== "function")
        throw new PageStackError("INVALID_CONFIG", "Navigation listener must be a function.");
      if (!closing) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handlers: () => [...handlers],
    requested(request: NavigationRequest): void {
      pending.add(request.id);
      emit(Object.freeze({ ...request, type: "requested" }));
    },
    settled(request: NavigationRequest, result: NavigationResult): void {
      pending.delete(request.id);
      emit(Object.freeze({ ...request, type: "settled", result }));
    },
    close(): void {
      // 销毁时先停用控制回调，已接受请求的观察者保留到各自终态，随后解除引用。
      closing = true;
      handlers.clear();
      release();
    },
  };
}
