/** 生命周期和观察者不阻塞导航；同步异常及异步拒绝统一交给宿主诊断。 */
export function notify(callback: () => unknown, failed: (cause: unknown) => void): void {
  try {
    const returned = callback();
    if (
      returned &&
      (typeof returned === "object" || typeof returned === "function") &&
      "then" in returned
    ) {
      void Promise.resolve(returned).catch(failed);
    }
  } catch (cause) {
    failed(cause);
  }
}
