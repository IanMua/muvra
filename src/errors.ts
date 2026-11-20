export type ErrorCode =
  | "INVALID_CONFIG"
  | "UNKNOWN_PAGE"
  | "INVALID_ROUTE"
  | "INVALID_KIND"
  | "DUPLICATE_KEY"
  | "GUARD_ERROR"
  | "GUARD_TIMEOUT"
  | "REDIRECT_LIMIT"
  | "TRANSITION_ERROR"
  | "TRANSITION_TIMEOUT"
  | "SUBSCRIBER_ERROR"
  | "HOOK_ERROR"
  | "DISPOSED"
  | "REENTRANT_NAVIGATION"
  | "QUEUE_FULL"
  | "POPUP_LIMIT"
  | "RENDERER_CONFLICT"
  | "COMPONENT_ERROR";

/** 所有框架失败携带稳定错误码，宿主无需匹配英文错误消息来决定行为。 */
export class PageStackError extends Error {
  override readonly name = "PageStackError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`[page-stack:${code}] ${message}`, { cause });
  }
}
export class Interrupted extends Error {
  constructor(readonly reason: "aborted" | "disposed") {
    super(reason);
  }
}
