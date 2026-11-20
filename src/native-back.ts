import type { NativeBackDecision, PageStack } from "./types.js";

/**
 * 原生桥接需要立即应答时，先确认网页接管，再异步执行守卫和转场。
 * 守卫拒绝或执行较慢都不会被宿主误判为允许退出；根页面退出策略仍归宿主管理。
 */
export function handleNativeBack(stack: PageStack<any>): NativeBackDecision {
  const state = stack.getSnapshot();
  if (!state.busy && !state.canGoBack) return "exit";
  if (state.phase === "guard") stack.cancel();
  else void stack.back(1, { reason: "native" });
  return "handled";
}
