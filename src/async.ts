import { Interrupted, PageStackError } from "./errors.js";
import type { GuardReturn, ObservableLike } from "./types.js";

function observable<T>(value: unknown): value is ObservableLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "subscribe" in value &&
    typeof value.subscribe === "function"
  );
}

/**
 * 将异步首值、空完成、中止和超时统一收敛为一次结束，供守卫、动画与加载边界共享。
 * 同步 Observable 可能先通知再返回句柄，清理必须兼顾句柄到达前后的两种时序。
 */
export function settle<T>(
  factory: () => GuardReturn<T>,
  options: {
    signal: AbortSignal;
    timeoutMs: number;
    timeoutCode?: "GUARD_TIMEOUT" | "TRANSITION_TIMEOUT";
    empty: T;
    onCleanupError?: (error: unknown) => void;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let subscription: ReturnType<ObservableLike<T>["subscribe"]>;
    let cleaned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanupSubscription = () => {
      if (!subscription || cleaned) return;
      cleaned = true;
      try {
        if (typeof subscription === "function") subscription();
        else subscription.unsubscribe();
      } catch (error) {
        options.onCleanupError?.(error);
      }
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      cleanupSubscription();
    };
    const finish = (ok: boolean, value: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      if (ok) resolve(value as T);
      else reject(value);
    };
    const abort = () =>
      finish(false, new Interrupted(options.signal.reason === "disposed" ? "disposed" : "aborted"));
    if (options.signal.aborted) {
      abort();
      return;
    }
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.timeoutMs > 0) {
      const code = options.timeoutCode;
      if (!code) {
        finish(
          false,
          new PageStackError("INVALID_CONFIG", "An async deadline requires an error code."),
        );
        return;
      }
      timer = setTimeout(() => {
        finish(false, new PageStackError(code, `Operation exceeded ${options.timeoutMs} ms.`));
      }, options.timeoutMs);
    }
    try {
      const value = factory();
      if (observable<T>(value)) {
        if (done) return;
        subscription = value.subscribe({
          next: (item) => finish(true, item),
          error: (error) => finish(false, error),
          complete: () => finish(true, options.empty),
        });
        if (done) cleanupSubscription();
      } else {
        // 即使调用方已中止，也持续消费迟到 Promise 的拒绝，防止未处理异常。
        Promise.resolve(value).then(
          (item) => finish(true, item),
          (error) => finish(false, error),
        );
      }
    } catch (error) {
      finish(false, error);
    }
  });
}
