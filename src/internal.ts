import type {
  PageDefinition,
  PageStack,
  ResolvedRoute,
  Operation,
  LeaveGuard,
  Diagnostic,
  NavigationOptions,
  NavigationResult,
  BackPreviewContext,
} from "./types.js";

export type HookKind = "show" | "hide" | "unload";
export interface Hook {
  callback: () => void;
  ready: boolean;
}
export interface Intent {
  operation: Operation;
  route?: import("./types.js").RouteInput;
  routes?: readonly import("./types.js").RouteInput[];
  delta?: number;
}
export interface Interception {
  /** 拦截以对象身份绑定，执行编号用于关联恢复；不复用原执行的中止信号。 */
  id: number;
  info: unknown;
  intent: Intent;
  history: readonly ResolvedRoute[];
  popups: readonly ResolvedRoute[];
}
export interface InternalPage {
  abort: AbortController;
  route: ResolvedRoute;
  definition: PageDefinition;
  visible: boolean;
  focused: boolean;
  alive: boolean;
  lastUsed: number;
  interception: Interception | undefined;
  hooks: Record<HookKind, Set<Hook>>;
  leaveGuards: Set<LeaveGuard>;
  backGuards: Set<LeaveGuard>;
}
export interface RenderRequest {
  operation: Operation;
  from: ResolvedRoute | undefined;
  to: ResolvedRoute | undefined;
  durationMs: number;
  signal: AbortSignal;
}
export type BackTarget = BackPreviewContext & { readonly durationMs: number };
/** 预览句柄随视图持有资源，内核只决定它何时可以跟随实际导航提交。 */
export interface BackPreview {
  update(progress: number): void;
  rewind(): Promise<void>;
  waitForCommit(): void;
  complete(request: RenderRequest): Promise<boolean>;
  dispose(): void;
}
export interface BackRenderer {
  available(target: BackTarget): boolean;
  start(target: BackTarget): BackPreview | undefined;
}
export interface InternalController {
  resume(
    id: number,
    options?: NavigationOptions,
    scopeSignal?: AbortSignal,
  ): Promise<NavigationResult>;
  reserveView(): () => void;
  record(id: number): InternalPage | undefined;
  hook(id: number, kind: HookKind, callback: () => void): { activate(): void; remove(): void };
  guard(id: number, kind: "leave" | "back", callback: LeaveGuard): () => void;
  attachRenderer(
    run: (request: RenderRequest) => Promise<boolean>,
    duration?: (request: Omit<RenderRequest, "signal">) => number,
    back?: BackRenderer,
  ): () => void;
  refreshBack(): void;
  report(diagnostic: Diagnostic): void;
}

// 内部能力仅存于 WeakMap；包入口不导出此文件，业务无法通过公开快照改写导航状态。
const controllers = new WeakMap<object, InternalController>();
export function bindController(stack: object, controller: InternalController): void {
  controllers.set(stack, controller);
}
export function controllerFor(stack: PageStack<any>): InternalController {
  const controller = controllers.get(stack);
  if (!controller) throw new TypeError("Expected a PageStack instance created by this package.");
  return controller;
}
