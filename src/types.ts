import type { Component, ComputedRef } from "vue";
import type { ExtensionDefinition } from "./layers/extensions.js";
import type { ProgressTransition, TransitionEffect } from "./animation/types.js";
import type { LayerContent } from "./layers/types.js";

/** 页面目录同时决定运行时种类和调用参数，避免字符串注册与全局类型声明脱节。 */
export type PageKind = "page" | "tab" | "popup";
declare const paramsType: unique symbol;
export interface ObservableLike<T> {
  subscribe(observer: {
    next?: (value: T) => void;
    error?: (error: unknown) => void;
    complete?: () => void;
  }): void | (() => void) | { unsubscribe(): void };
}
export type GuardDecision = boolean | void | RouteInput;
export type GuardReturn<T> = T | PromiseLike<T> | ObservableLike<T>;
export interface RouteInput {
  readonly name: string;
  readonly key?: string;
  readonly params?: unknown;
}
export interface ResolvedRoute {
  readonly id: number;
  readonly name: string;
  readonly key: string;
  readonly params: unknown;
  readonly kind: PageKind;
  readonly meta: Readonly<Record<string, unknown>>;
}
export type Operation =
  | "push"
  | "replace"
  | "reset"
  | "switchTab"
  | "openPopup"
  | "closePopup"
  | "back"
  | "resume";
export interface GuardContext {
  readonly operation: Operation;
  /** 本次执行的业务附加信息；框架不解析其内容，也不将其作为页面参数。 */
  readonly info: unknown;
  readonly resumedFromId: number | undefined;
  readonly from: ResolvedRoute | undefined;
  readonly to: ResolvedRoute | undefined;
  readonly signal: AbortSignal;
  readonly reason: "user" | "program" | "native" | "keyboard";
  readonly delta: number;
}
export type NavigationGuard<C extends PageCatalog = PageCatalog> = (
  context: GuardContext,
) => GuardReturn<boolean | void | Route<C>>;
export type LeaveGuard = (context: GuardContext) => GuardReturn<boolean | void>;
export interface PageOptions {
  /** 声明层扩展为每个实际页面实例分别安装，脚本可用同 key 覆盖配置。 */
  readonly extensions?: readonly ExtensionDefinition[];
  readonly cache?: boolean;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly beforeEnter?: NavigationGuard;
  /** 前进时进入页优先，返回或关闭弹窗时离开页优先；false 显式禁用。 */
  readonly transition?: TransitionDriver | TransitionEffect | ProgressTransition | false;
  /** 宿主可校验运行时输入；返回字符串时使用该字符串解释校验失败。 */
  readonly validate?: (params: unknown) => boolean | string | void;
}
export interface PageDefinition<K extends PageKind = PageKind, P = unknown> extends PageOptions {
  readonly kind: K;
  readonly component: Component;
  readonly [paramsType]?: P;
}
// 目录内部允许各页参数异构，具体调用仍由下面的条件类型约束。
export type PageCatalog = Readonly<Record<string, PageDefinition<PageKind, any>>>;
export type PageNames<C extends PageCatalog, K extends PageKind = PageKind> = {
  [N in keyof C & string]: C[N]["kind"] extends K ? N : never;
}[keyof C & string];
export type ParamsOf<D> = D extends PageDefinition<PageKind, infer P> ? P : never;
type ParamsInput<P> = [P] extends [void]
  ? { readonly params?: undefined }
  : {} extends P
    ? { readonly params?: P }
    : { readonly params: P };
export type Route<C extends PageCatalog, K extends PageKind = PageKind> = {
  [N in PageNames<C, K>]: { readonly name: N } & (C[N]["kind"] extends "tab"
    ? { readonly key?: never }
    : { readonly key?: string }) &
    ParamsInput<ParamsOf<C[N]>>;
}[PageNames<C, K>];
export type NonEmpty<T> = readonly [T, ...T[]];

export interface RenderedPage {
  readonly route: ResolvedRoute;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly zIndex: number;
}
/** 宿主在手势前读取接管状态。有目标时，令牌只在该返回候选有效期间可用。 */
export type BackState =
  | { readonly mode: "delegate" | "busy" }
  | { readonly mode: "commit-only" | "interactive"; readonly token: string };

export interface BackSession {
  /** 进度可双向变化，只影响预览画面。 */
  update(progress: number): void;
  cancel(): void;
  /** 确认才发出正式导航。已失效的会话没有导航结果，重复确认复用同一个结果。 */
  commit(): Promise<NavigationResult | undefined>;
}

export interface BackPreviewContext {
  readonly operation: "back" | "closePopup";
  readonly from: ResolvedRoute;
  readonly to: ResolvedRoute;
}

/** 应用按候选选择复用已挂载页面、提供只读图层，或交给普通返回。 */
export type BackPreviewProvider = (
  context: BackPreviewContext,
) => "mounted" | LayerContent | undefined;

export interface StackSnapshot {
  readonly revision: number;
  readonly phase: "idle" | "guard" | "transition" | "disposed";
  readonly pending: Readonly<{ id: number; operation: Operation }> | undefined;
  readonly history: readonly ResolvedRoute[];
  readonly popups: readonly ResolvedRoute[];
  readonly layers: readonly ResolvedRoute[];
  readonly rendered: readonly RenderedPage[];
  readonly current: ResolvedRoute | undefined;
  readonly top: ResolvedRoute | undefined;
  readonly canGoBack: boolean;
  readonly back: BackState;
  readonly busy: boolean;
  readonly queued: number;
  readonly disposed: boolean;
}
export type TransitionOutcome = "skipped" | "completed" | "failed" | "timed-out" | "interrupted";
interface ResultBase {
  readonly id: number;
  readonly operation: Operation;
  readonly info: unknown;
  readonly resumedFromId: number | undefined;
  readonly state: StackSnapshot;
}
export type NavigationResult =
  | (ResultBase & {
      readonly status: "completed";
      readonly transition: TransitionOutcome;
      readonly redirected: boolean;
    })
  | (ResultBase & {
      readonly status: "cancelled";
      readonly reason: "guard" | "aborted" | "disposed" | "busy";
    })
  | (ResultBase & {
      readonly status: "noop";
      readonly reason: "root" | "empty" | "same" | "not-intercepted";
    })
  | (ResultBase & {
      readonly status: "failed";
      readonly error: import("./errors.js").PageStackError;
    });
export interface NavigationOptions {
  /** 按引用传递；省略时普通导航为空，恢复导航继承原拦截，显式 undefined 可清空。 */
  readonly info?: unknown;
  readonly signal?: AbortSignal;
  readonly reason?: "user" | "program" | "native" | "keyboard";
  readonly clearCache?: boolean;
}

/** 请求中的目标尚未经过页面校验；重定向不改写它，最终页面从结果快照读取。 */
export interface NavigationRequest {
  readonly id: number;
  readonly operation: Operation;
  readonly route?: RouteInput;
  readonly routes?: readonly RouteInput[];
  readonly delta?: number;
  readonly reason: NonNullable<NavigationOptions["reason"]>;
  readonly info: unknown;
  readonly resumedFromId: number | undefined;
}
export interface BeforeNavigateContext extends NavigationRequest {
  readonly from: ResolvedRoute | undefined;
  readonly signal: AbortSignal;
}
export type BeforeNavigateResult = boolean | void | { readonly info: unknown };
export type BeforeNavigate = (
  navigation: BeforeNavigateContext,
) => GuardReturn<BeforeNavigateResult>;
/** requested 记录调用，settled 记录唯一结果；观察回调的返回值不影响导航。 */
export type NavigationEvent =
  | (NavigationRequest & { readonly type: "requested" })
  | (NavigationRequest & { readonly type: "settled"; readonly result: NavigationResult });
export type NavigationListener = (event: NavigationEvent) => void;

export interface StackOptions<C extends PageCatalog> {
  readonly pages: C;
  readonly initial?: NonEmpty<Route<C, "page" | "tab">>;
  /** 物理层保留的普通历史尾部深度，默认 2；必须为正整数，all 表示全部。 */
  readonly renderDepth?: number | "all";
  /** 默认额外保留逻辑根 Tab，避免普通页推进后丢失底部根实例。 */
  readonly keepTabRoot?: boolean;
  /** 普通历史页预算，根 Tab 另计；默认 32，必须为正整数。 */
  readonly maxHistory?: number;
  /** 物理层外的缓存预算，默认 16；0 表示不保留层外缓存。 */
  readonly maxCachedPages?: number;
  readonly closePopupsOnNavigate?: boolean;
  /** 单个守卫截止时间，默认 30000 毫秒；0 关闭计时，仍可通过 signal 中止。 */
  readonly guardTimeoutMs?: number;
  /** 默认 max(2000, 整个编排时长 + 1000) 毫秒；0 关闭计时，最大 2147483647。 */
  readonly transitionTimeoutMs?: number;
  /** 默认驱动时长 280 毫秒，预设使用自身 duration；0 禁用整个容器的动画。 */
  readonly transitionDurationMs?: number;
  /** 最大重定向轮数，默认 8，必须为正整数。 */
  readonly maxRedirects?: number;
  /** 等待队列容量，不含正在执行的命令；默认 32，必须为正整数。 */
  readonly maxQueue?: number;
  /** 弹窗覆盖层容量，默认 32，必须为正整数。 */
  readonly maxPopups?: number;
  readonly beforeEach?: NavigationGuard<C>;
  readonly beforeNavigate?: BeforeNavigate;
  readonly onNavigation?: NavigationListener;
  readonly onError?: (diagnostic: Diagnostic) => void;
}
export interface Diagnostic {
  readonly error: import("./errors.js").PageStackError;
  readonly navigationId: number | undefined;
  readonly route: ResolvedRoute | undefined;
  readonly severity: "warning" | "error";
}
export type CatalogEntry<C extends PageCatalog = PageCatalog> = {
  [N in keyof C & string]: Readonly<{
    name: N;
    kind: C[N]["kind"];
    meta: Readonly<Record<string, unknown>>;
  }>;
}[keyof C & string];
export type DynamicArguments<P> = [P] extends [void]
  ? [params?: undefined, options?: NavigationOptions]
  : {} extends P
    ? [params?: P, options?: NavigationOptions]
    : [params: P, options?: NavigationOptions];
export interface PageStack<C extends PageCatalog = PageCatalog> {
  readonly ready: Promise<NavigationResult>;
  readonly catalog: readonly CatalogEntry<C>[];
  getSnapshot(): StackSnapshot;
  subscribe(listener: (state: StackSnapshot) => void): () => void;
  onError(listener: (diagnostic: Diagnostic) => void): () => void;
  beforeEach(guard: NavigationGuard<C>): () => void;
  beforeNavigate(handler: BeforeNavigate): () => void;
  onNavigation(listener: NavigationListener): () => void;
  push(route: Route<C, "page">, options?: NavigationOptions): Promise<NavigationResult>;
  replace(route: Route<C, "page">, options?: NavigationOptions): Promise<NavigationResult>;
  reset(
    routes: NonEmpty<Route<C, "page" | "tab">>,
    options?: NavigationOptions,
  ): Promise<NavigationResult>;
  switchTab(route: Route<C, "tab">, options?: NavigationOptions): Promise<NavigationResult>;
  openPopup(route: Route<C, "popup">, options?: NavigationOptions): Promise<NavigationResult>;
  pushDynamic<P>(
    definition: PageDefinition<"page", P>,
    ...args: DynamicArguments<P>
  ): Promise<NavigationResult>;
  openDynamicPopup<P>(
    definition: PageDefinition<"popup", P>,
    ...args: DynamicArguments<P>
  ): Promise<NavigationResult>;
  closePopup(options?: NavigationOptions): Promise<NavigationResult>;
  back(delta?: number, options?: NavigationOptions): Promise<NavigationResult>;
  beginBack(token: string, options?: NavigationOptions): BackSession | undefined;
  resume(options?: NavigationOptions): Promise<NavigationResult>;
  /** 只回收当前未渲染的缓存实例，逻辑历史中的页面可在返回时重新创建。 */
  clearCache(): Promise<number>;
  /** 中止当前检查或转场；排队任务可通过各自的 AbortSignal 单独取消。 */
  cancel(): void;
  dispose(): void;
}
export interface PageContext<P> {
  /** 返回撤销函数；组件卸载时自动撤销脚本贡献并恢复声明配置。 */
  extend(extension: ExtensionDefinition): () => void;
  /** 组件卸载或内核回收页面时中止，供网络请求及异步资源绑定真实生命周期。 */
  readonly signal: AbortSignal;
  readonly route: ComputedRef<ResolvedRoute>;
  readonly params: ComputedRef<P>;
  readonly visible: ComputedRef<boolean>;
  readonly focused: ComputedRef<boolean>;
  readonly isIntercepted: ComputedRef<boolean>;
  resume(options?: NavigationOptions): Promise<NavigationResult>;
  onShow(callback: () => void): () => void;
  onHide(callback: () => void): () => void;
  onUnload(callback: () => void): () => void;
  beforeLeave(guard: LeaveGuard): () => void;
  beforeBack(guard: LeaveGuard): () => void;
}
export interface TransitionContext {
  readonly operation: Operation;
  readonly from: HTMLElement | undefined;
  readonly to: HTMLElement | undefined;
  readonly fromRoute: ResolvedRoute | undefined;
  readonly toRoute: ResolvedRoute | undefined;
  readonly durationMs: number;
  readonly signal: AbortSignal;
}
export type TransitionDriver = (context: TransitionContext) => void | PromiseLike<void>;
export type NativeBackDecision = "handled" | "exit";
