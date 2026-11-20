import { notify } from "../notifications.js";
export type Cleanup = () => void | PromiseLike<void>;

/** 资源按申请顺序的逆序回收；关闭后迟到的句柄立即释放，避免异步扩展复活。 */
export function createResourceScope(onError: (error: unknown) => void = () => {}) {
  const abort = new AbortController();
  const resources = new Set<Cleanup>();
  const release = (cleanup: Cleanup) => {
    try {
      const result = cleanup();
      if (result) void Promise.resolve(result).catch(report);
    } catch (error) {
      report(error);
    }
  };
  function report(error: unknown) {
    notify(
      () => onError(error),
      () => {},
    );
  }
  return Object.freeze({
    signal: abort.signal,
    own(cleanup: Cleanup): () => void {
      // 每次登记代表一次所有权，即使复用同一清理函数，也分别执行对应的释放。
      const registration: Cleanup = () => cleanup();
      if (abort.signal.aborted) release(cleanup);
      else resources.add(registration);
      return () => {
        if (resources.delete(registration)) release(registration);
      };
    },
    dispose(reason: unknown = "scope-disposed") {
      if (abort.signal.aborted) return;
      abort.abort(reason);
      const pending = [...resources].reverse();
      resources.clear();
      for (const cleanup of pending) release(cleanup);
    },
  });
}
