import { definePages } from "./definitions.js";
import { settle } from "./async.js";
import { createPlanner } from "./planner.js";
import { createRecordStore } from "./record-store.js";
import type { Plan } from "./planner.js";
import { notify } from "./notifications.js";
import { createNavigationLifecycle } from "./navigation-lifecycle.js";
import { Interrupted, PageStackError } from "./errors.js";
import { bindController } from "./internal.js";
import type { HookKind, InternalPage, Intent, Interception, RenderRequest } from "./internal.js";
import type {
  BeforeNavigateContext,
  BeforeNavigateResult,
  CatalogEntry,
  Diagnostic,
  DynamicArguments,
  GuardContext,
  GuardDecision,
  GuardReturn,
  NavigationGuard,
  NavigationOptions,
  NavigationResult,
  NavigationRequest,
  PageCatalog,
  PageDefinition,
  PageStack,
  ResolvedRoute,
  RouteInput,
  StackOptions,
  StackSnapshot,
  TransitionOutcome,
} from "./types.js";

interface ResumeBinding {
  pageId: number;
  interception: Interception;
  scopeSignal: AbortSignal | undefined;
}
interface RequestState {
  id: number;
  intent: Intent;
  info: unknown;
  reason: NonNullable<NavigationOptions["reason"]>;
  resumedFromId: number | undefined;
  binding: ResumeBinding | undefined;
  requested: boolean;
  settled: NavigationResult | undefined;
}
interface Job extends RequestState {
  options: NavigationOptions;
  abort: AbortController;
  resolve(result: NavigationResult): void;
  removeSignal(): void;
}
type RuntimeGuard = (context: GuardContext) => GuardReturn<GuardDecision>;
type Outcome =
  | { status: "completed"; transition: TransitionOutcome; redirected: boolean }
  | { status: "cancelled"; reason: "guard" | "aborted" | "disposed" | "busy" }
  | { status: "noop"; reason: "root" | "empty" | "same" | "not-intercepted" }
  | { status: "failed"; error: PageStackError };

/** 每次创建拥有独立目录、实例池、守卫及队列；模块中不保存任何应用导航状态。 */
export function createPageStack<const C extends PageCatalog>(input: StackOptions<C>): PageStack<C> {
  if (!input || typeof input !== "object")
    throw new PageStackError("INVALID_CONFIG", "Stack options must be an object.");
  const accepted = new Set([
    "pages",
    "initial",
    "renderDepth",
    "keepTabRoot",
    "maxHistory",
    "maxCachedPages",
    "closePopupsOnNavigate",
    "guardTimeoutMs",
    "transitionTimeoutMs",
    "transitionDurationMs",
    "maxRedirects",
    "maxQueue",
    "maxPopups",
    "beforeEach",
    "beforeNavigate",
    "onNavigation",
    "onError",
  ]);
  for (const [name, value] of Object.entries(input)) {
    if (!accepted.has(name) || value === null)
      throw new PageStackError("INVALID_CONFIG", `Unknown or null stack option "${name}".`);
  }
  for (const name of ["beforeEach", "beforeNavigate", "onNavigation", "onError"] as const) {
    if (input[name] !== undefined && typeof input[name] !== "function")
      throw new PageStackError("INVALID_CONFIG", `${name} must be a function.`);
  }
  const pages = definePages(input.pages);
  const automaticTransitionDeadline = input.transitionTimeoutMs === undefined;
  const transitionDurationMs = input.transitionDurationMs ?? 280;
  if (!Number.isSafeInteger(transitionDurationMs) || transitionDurationMs < 0)
    throw new PageStackError(
      "INVALID_CONFIG",
      "transitionDurationMs must be a non-negative integer.",
    );
  const options = {
    renderDepth: input.renderDepth ?? 2,
    keepTabRoot: input.keepTabRoot ?? true,
    maxHistory: input.maxHistory ?? 32,
    maxCachedPages: input.maxCachedPages ?? 16,
    closePopupsOnNavigate: input.closePopupsOnNavigate ?? true,
    guardTimeoutMs: input.guardTimeoutMs ?? 30_000,
    // 默认等待预算覆盖预期动画时长，避免只调整 duration 就被固定看门狗提前中止。
    transitionTimeoutMs: input.transitionTimeoutMs ?? Math.max(2_000, transitionDurationMs + 1_000),
    transitionDurationMs,
    maxRedirects: input.maxRedirects ?? 8,
    maxQueue: input.maxQueue ?? 32,
    maxPopups: input.maxPopups ?? 32,
  };
  for (const name of ["maxHistory", "maxRedirects", "maxQueue", "maxPopups"] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 1)
      throw new PageStackError("INVALID_CONFIG", `${name} must be a positive integer.`);
  }
  for (const name of ["maxCachedPages", "guardTimeoutMs", "transitionTimeoutMs"] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 0)
      throw new PageStackError("INVALID_CONFIG", `${name} must be a non-negative integer.`);
  }
  if (
    options.renderDepth !== "all" &&
    (!Number.isSafeInteger(options.renderDepth) || options.renderDepth < 1)
  ) {
    throw new PageStackError("INVALID_CONFIG", "renderDepth must be a positive integer or 'all'.");
  }
  for (const name of ["keepTabRoot", "closePopupsOnNavigate"] as const) {
    if (typeof options[name] !== "boolean")
      throw new PageStackError("INVALID_CONFIG", `${name} must be boolean.`);
  }
  for (const name of ["guardTimeoutMs", "transitionTimeoutMs"] as const) {
    if (options[name] > 2_147_483_647)
      throw new PageStackError(
        "INVALID_CONFIG",
        `${name} exceeds the timer range; use 0 to explicitly disable the deadline.`,
      );
  }
  let history: ResolvedRoute[] = [];
  let popups: ResolvedRoute[] = [];
  let layers: ResolvedRoute[] = [];
  const transitionVisible = new Set<number>();
  const dynamicDefinitions = new Map<string, PageDefinition>();
  let dynamicSeed = 0;
  const definitionFor = (name: string) =>
    Object.hasOwn(pages, name) ? pages[name] : dynamicDefinitions.get(name);
  const store = createRecordStore({
    definitionFor,
    report,
    navigationId: () => active?.id,
  });
  const records = store.records;
  const listeners = new Set<(snapshot: StackSnapshot) => void>();
  const diagnostics = new Set<(diagnostic: Diagnostic) => void>();
  if (input.onError) diagnostics.add(input.onError);
  const guards = new Set<RuntimeGuard>();
  if (input.beforeEach) guards.add(input.beforeEach);
  const lifecycle = createNavigationLifecycle(report);
  if (input.beforeNavigate) lifecycle.beforeNavigate(input.beforeNavigate);
  if (input.onNavigation) lifecycle.onNavigation(input.onNavigation);
  const queue: Job[] = [];
  let routeSeed = 0;
  let navigationSeed = 0;
  let revision = 0;
  let disposed = false;
  let draining = false;
  let invokingGuard = false;
  let reporting = false;
  let phase: StackSnapshot["phase"] = "idle";
  let active: Job | undefined;
  let renderer: ((request: RenderRequest) => Promise<boolean>) | undefined;
  let rendererDuration: ((request: Omit<RenderRequest, "signal">) => number) | undefined;
  let transitionAbort: AbortController | undefined;
  let viewLease: symbol | undefined;
  let snapshot: StackSnapshot;

  const catalog = Object.freeze(
    Object.entries(pages).map(([name, definition]) =>
      Object.freeze({
        name,
        kind: definition.kind,
        meta: definition.meta ?? Object.freeze({}),
      }),
    ),
  ) as readonly CatalogEntry<C>[];

  function report(diagnostic: Diagnostic): void {
    if (!diagnostics.size || reporting) {
      (diagnostic.severity === "warning" ? console.warn : console.error)(diagnostic.error);
      return;
    }
    reporting = true;
    try {
      for (const listener of [...diagnostics]) {
        notify(
          () => listener(Object.freeze(diagnostic)),
          (error) => {
            console.error("[page-stack] Diagnostic listener failed:", error);
          },
        );
      }
    } finally {
      reporting = false;
    }
  }
  function error(
    code: import("./errors.js").ErrorCode,
    message: string,
    cause?: unknown,
  ): PageStackError {
    return cause instanceof PageStackError ? cause : new PageStackError(code, message, cause);
  }
  function publish(): void {
    const top = popups.at(-1) ?? history.at(-1);
    const current = history.at(-1);
    const visible = new Set<number>(popups.map((route) => route.id));
    if (current) visible.add(current.id);
    // 转场期间临时保留离场页，最终状态只显示顶部经典页面及所有弹窗背景。
    if (phase === "transition") for (const id of transitionVisible) visible.add(id);
    const events: [InternalPage, HookKind][] = [];
    const z = new Map(layers.map((route, index) => [route.id, index]));
    for (const record of records.values()) {
      const next = visible.has(record.route.id) && z.has(record.route.id);
      if (record.visible !== next) {
        record.visible = next;
        events.push([record, next ? "show" : "hide"]);
      }
      record.focused = record.route.id === top?.id;
    }
    snapshot = Object.freeze({
      revision,
      phase,
      pending:
        active && !disposed
          ? Object.freeze({ id: active.id, operation: active.intent.operation })
          : undefined,
      history: Object.freeze([...history]),
      popups: Object.freeze([...popups]),
      layers: Object.freeze([...layers]),
      rendered: Object.freeze(
        [...records.values()].map((record) =>
          Object.freeze({
            route: record.route,
            visible: record.visible,
            focused: record.focused,
            zIndex: z.get(record.route.id) ?? -1,
          }),
        ),
      ),
      current,
      top,
      canGoBack: popups.length > 0 || history.length > 1,
      busy: !disposed && (active !== undefined || queue.length > 0),
      queued: queue.length,
      disposed,
    });
    for (const listener of [...listeners]) {
      const navigationId = active?.id;
      notify(
        () => listener(snapshot),
        (cause) => {
          report({
            error: error("SUBSCRIBER_ERROR", "State listener failed.", cause),
            navigationId,
            route: top,
            severity: "error",
          });
        },
      );
    }
    for (const [record, kind] of events) store.emit(record, kind);
  }
  function materialized(): ResolvedRoute[] {
    const classic =
      options.renderDepth === "all" ? [...history] : history.slice(-options.renderDepth);
    const root = history[0];
    if (
      options.keepTabRoot &&
      root?.kind === "tab" &&
      !classic.some((route) => route.id === root.id)
    )
      classic.unshift(root);
    return [...classic, ...popups];
  }
  function normalize(value: RouteInput, fresh: boolean): ResolvedRoute {
    if (!value || typeof value !== "object" || typeof value.name !== "string")
      throw new PageStackError("INVALID_ROUTE", "Route must contain a page name.");
    const definition = definitionFor(value.name);
    if (!definition)
      throw new PageStackError("UNKNOWN_PAGE", `Page "${value.name}" is not registered.`);
    if (value.key !== undefined && (typeof value.key !== "string" || !value.key.trim()))
      throw new PageStackError("INVALID_ROUTE", "Route key must be a non-empty string.");
    if (definition.kind === "tab" && value.key !== undefined)
      throw new PageStackError(
        "INVALID_ROUTE",
        "Tab identity is its name; custom keys are not accepted.",
      );
    let validation: boolean | string | void;
    try {
      validation = definition.validate?.(value.params);
    } catch (cause) {
      throw new PageStackError(
        "INVALID_ROUTE",
        `Params validator for page "${value.name}" failed.`,
        cause,
      );
    }
    if (
      validation !== undefined &&
      typeof validation !== "boolean" &&
      typeof validation !== "string"
    ) {
      void Promise.resolve(validation).catch(() => {});
      throw new PageStackError(
        "INVALID_ROUTE",
        "Params validator must return void, boolean, or a message synchronously; use beforeEnter for asynchronous checks.",
      );
    }
    if (validation === false || typeof validation === "string")
      throw new PageStackError(
        "INVALID_ROUTE",
        typeof validation === "string" ? validation : `Invalid params for page "${value.name}".`,
      );
    const key = definition.kind === "tab" ? `tab:${value.name}` : value.key;
    const known =
      fresh || !key
        ? undefined
        : [...history, ...popups, ...[...records.values()].map((record) => record.route)].find(
            (route) => route.name === value.name && route.key === key,
          );
    const id = known?.id ?? ++routeSeed;
    return Object.freeze({
      id,
      name: value.name,
      key: key ?? `entry:${id}`,
      params: value.params,
      kind: definition.kind,
      meta: definition.meta ?? Object.freeze({}),
    });
  }
  const plan = createPlanner(options, normalize);
  /** 前置处理与页面守卫共享首值、超时、中止和迟到拒绝处理，避免产生第二套异步规则。 */
  async function callCheck<T>(
    callback: () => GuardReturn<T>,
    job: Job,
    from: ResolvedRoute | undefined,
  ): Promise<T | undefined> {
    try {
      return await settle<T | undefined>(
        () => {
          invokingGuard = true;
          try {
            return callback();
          } finally {
            invokingGuard = false;
          }
        },
        {
          signal: job.abort.signal,
          timeoutMs: options.guardTimeoutMs,
          timeoutCode: "GUARD_TIMEOUT",
          empty: undefined,
          onCleanupError: (cause) =>
            report({
              error: error("GUARD_ERROR", "Navigation check cleanup failed.", cause),
              navigationId: job.id,
              route: from,
              severity: "error",
            }),
        },
      );
    } catch (cause) {
      if (cause instanceof Interrupted) throw cause;
      if (cause instanceof PageStackError && cause.code === "GUARD_TIMEOUT")
        job.abort.abort("timeout");
      throw error("GUARD_ERROR", "Navigation check failed.", cause);
    }
  }
  function callGuard(
    guard: RuntimeGuard | import("./types.js").LeaveGuard,
    context: GuardContext,
    job: Job,
  ): Promise<GuardDecision> {
    return callCheck(() => guard(context), job, context.from);
  }
  function validResume(job: RequestState): boolean {
    const binding = job.binding;
    return Boolean(
      binding &&
      !binding.scopeSignal?.aborted &&
      snapshot.top?.id === binding.pageId &&
      records.get(binding.pageId)?.interception === binding.interception,
    );
  }
  function requestOf(job: RequestState): NavigationRequest {
    const intent = job.binding?.interception.intent ?? job.intent;
    return Object.freeze({
      ...intent,
      operation: job.intent.operation,
      id: job.id,
      reason: job.reason,
      info: job.info,
      resumedFromId: job.resumedFromId,
    });
  }
  function requested(job: RequestState): void {
    if (job.requested || job.id === 0) return;
    job.requested = true;
    lifecycle.requested(requestOf(job));
  }
  async function preprocess(job: Job): Promise<boolean> {
    for (const handler of lifecycle.handlers()) {
      const navigation: BeforeNavigateContext = Object.freeze({
        ...requestOf(job),
        from: snapshot.top,
        signal: job.abort.signal,
      });
      const value: BeforeNavigateResult = await callCheck(
        () => handler(navigation),
        job,
        navigation.from,
      );
      if (value === false) return false;
      if (value === undefined || value === true) continue;
      if (
        !value ||
        typeof value !== "object" ||
        !Object.hasOwn(value, "info") ||
        Object.keys(value).some((key) => key !== "info")
      )
        throw new PageStackError(
          "GUARD_ERROR",
          "Preprocessor must return void, boolean, or { info }.",
        );
      job.info = value.info;
    }
    return true;
  }
  function decision(value: GuardDecision): "allow" | "cancel" | RouteInput {
    if (value === undefined || value === true) return "allow";
    if (value === false) return "cancel";
    if (value && typeof value === "object" && typeof value.name === "string") return value;
    throw new PageStackError("GUARD_ERROR", "Guard must return void, a boolean, or a route.");
  }
  function redirectIntent(original: Intent, target: RouteInput): Intent {
    const definition = definitionFor(target.name);
    if (!definition)
      throw new PageStackError("UNKNOWN_PAGE", `Redirect page "${target.name}" is not registered.`);
    const operation =
      definition.kind === "tab"
        ? "switchTab"
        : definition.kind === "popup"
          ? "openPopup"
          : original.operation === "replace"
            ? "replace"
            : "push";
    return { operation, route: target };
  }
  async function prepare(job: Job): Promise<Plan | "cancel"> {
    let intent = job.intent;
    let baseHistory: readonly ResolvedRoute[] = history;
    let basePopups: readonly ResolvedRoute[] = popups;
    let interception: Interception | undefined;
    if (intent.operation === "resume") {
      interception = job.binding?.interception;
      if (!validResume(job) || !interception)
        return {
          ...plan({ operation: "back" }, [], [], false),
          noop: "not-intercepted",
        };
      intent = interception.intent;
      baseHistory = interception.history;
      basePopups = interception.popups;
    }
    const origin: Interception = {
      id: job.id,
      info: job.info,
      intent,
      history: [...baseHistory],
      popups: [...basePopups],
    };
    let redirected = false;
    for (let round = 0; round <= options.maxRedirects; round++) {
      if (job.abort.signal.aborted) throw new Interrupted(disposed ? "disposed" : "aborted");
      const next = plan(intent, baseHistory, basePopups, job.options.clearCache === true);
      if (job.intent.operation === "resume") {
        // 历史按原意图恢复，离场页及离开守卫仍以当前屏幕实际承接拦截的页面为准。
        next.from = snapshot.top;
        next.leaving = [...snapshot.popups]
          .reverse()
          .filter((route) => !next.popups.some((kept) => kept.id === route.id));
        if (snapshot.current && snapshot.current.id !== next.history.at(-1)?.id)
          next.leaving.push(snapshot.current);
      }
      next.interception = redirected ? origin : undefined;
      next.redirected = redirected;
      if (next.noop) return next;
      let redirect: RouteInput | undefined;
      for (const target of next.entering) {
        const delta = ["back", "closePopup"].includes(job.intent.operation)
          ? snapshot.popups.length - next.popups.length ||
            Math.max(0, snapshot.history.length - next.history.length)
          : 0;
        const context: GuardContext = Object.freeze({
          operation: job.intent.operation,
          info: job.info,
          resumedFromId: job.resumedFromId,
          from: snapshot.top,
          to: target,
          signal: job.abort.signal,
          reason: job.reason,
          delta,
        });
        const chain = [...guards];
        const pageGuard = definitionFor(target.name)!.beforeEnter;
        if (pageGuard) chain.push(pageGuard);
        for (const guard of chain) {
          const value = decision(await callGuard(guard, context, job));
          if (value === "cancel") return "cancel";
          if (value !== "allow") {
            redirect = value;
            break;
          }
        }
        if (redirect) break;
      }
      if (redirect) {
        if (round >= options.maxRedirects)
          throw new PageStackError(
            "REDIRECT_LIMIT",
            `Guard redirects exceeded ${options.maxRedirects} rounds.`,
          );
        intent = redirectIntent(intent, redirect);
        redirected = true;
        continue;
      }
      // 入口检查完成后才检查真正要离开的页面，重定向不会重复弹出离开确认。
      const leaving = next.leaving;
      const seen = new Set<number>();
      for (const route of leaving) {
        if (!route || seen.has(route.id)) continue;
        seen.add(route.id);
        const record = records.get(route.id);
        const chain = [...(record?.leaveGuards ?? [])];
        if (["back", "closePopup"].includes(job.intent.operation))
          chain.push(...(record?.backGuards ?? []));
        for (const guard of chain) {
          const delta = ["back", "closePopup"].includes(job.intent.operation)
            ? snapshot.popups.length - next.popups.length ||
              Math.max(0, snapshot.history.length - next.history.length)
            : 0;
          const value = decision(
            await callGuard(
              guard,
              Object.freeze({
                operation: job.intent.operation,
                info: job.info,
                resumedFromId: job.resumedFromId,
                from: route,
                to: next.to,
                signal: job.abort.signal,
                reason: job.reason,
                delta,
              }),
              job,
            ),
          );
          if (value === "cancel") return "cancel";
          if (value !== "allow")
            throw new PageStackError(
              "GUARD_ERROR",
              "Leave guards cannot redirect; return a boolean or void.",
            );
        }
      }
      return next;
    }
    throw new PageStackError("REDIRECT_LIMIT", "Navigation did not converge.");
  }
  async function animate(job: Job, next: Plan): Promise<TransitionOutcome> {
    const run = renderer;
    if (!run || !options.transitionDurationMs || next.from?.id === next.to?.id) return "skipped";
    const abort = new AbortController();
    transitionAbort = abort;
    const forwardAbort = () => abort.abort(job.abort.signal.reason);
    if (job.abort.signal.aborted) forwardAbort();
    else job.abort.signal.addEventListener("abort", forwardAbort, { once: true });
    try {
      // 默认截止时间覆盖整个编排；宿主显式设置的截止时间仍是硬上限，0 保持可中止。
      const request = {
        operation: next.operation,
        from: next.from,
        to: next.to,
        durationMs: options.transitionDurationMs,
      };
      const durationMs = rendererDuration?.(request) ?? request.durationMs;
      if (!durationMs) return "skipped";
      const timeoutMs = automaticTransitionDeadline
        ? Math.max(options.transitionTimeoutMs, durationMs + 1_000)
        : options.transitionTimeoutMs;
      const ran = await settle(
        () =>
          run({
            ...request,
            durationMs,
            signal: abort.signal,
          }),
        {
          signal: abort.signal,
          timeoutMs,
          timeoutCode: "TRANSITION_TIMEOUT",
          empty: false,
        },
      );
      return ran ? "completed" : "skipped";
    } catch (cause) {
      if (disposed) throw new Interrupted("disposed");
      if (cause instanceof Interrupted) return "interrupted";
      const failure = error(
        "TRANSITION_ERROR",
        "Transition failed; committed navigation will finish without animation.",
        cause,
      );
      report({
        error: failure,
        navigationId: job.id,
        route: next.to,
        severity: "warning",
      });
      return failure.code === "TRANSITION_TIMEOUT" ? "timed-out" : "failed";
    } finally {
      abort.abort("transition-finished");
      job.abort.signal.removeEventListener("abort", forwardAbort);
      if (transitionAbort === abort) transitionAbort = undefined;
    }
  }
  async function execute(job: Job): Promise<Outcome> {
    if (job.intent.operation === "resume" && !validResume(job))
      return { status: "noop", reason: "not-intercepted" };
    if (!(await preprocess(job))) return { status: "cancelled", reason: "guard" };
    const next = await prepare(job);
    if (next === "cancel") return { status: "cancelled", reason: "guard" };
    if (next.noop) return { status: "noop", reason: next.noop };
    if (job.intent.operation === "resume" && !validResume(job))
      return { status: "noop", reason: "not-intercepted" };
    if (job.abort.signal.aborted) throw new Interrupted(disposed ? "disposed" : "aborted");
    const previousTop = popups.at(-1) ?? history.at(-1);
    history = next.history;
    popups = next.popups;
    layers = materialized();
    store.ensure(layers);
    if (next.to && next.interception) records.get(next.to.id)!.interception = next.interception;
    else if (next.to) records.get(next.to.id)!.interception = undefined;
    // 成功提交后消费旧拦截；缓存的承接页也不能继续持有已恢复的业务信息。
    if (job.binding) {
      const owner = records.get(job.binding.pageId);
      if (owner?.interception === job.binding.interception) owner.interception = undefined;
    }
    const from = next.from ?? previousTop;
    transitionVisible.clear();
    if (from) transitionVisible.add(from.id);
    if (next.to) transitionVisible.add(next.to.id);
    if (from && records.has(from.id) && !layers.some((route) => route.id === from.id)) {
      // push 的离场页在目标下方，返回、替换、重置及关闭弹窗的离场页位于上方。
      const index =
        next.operation === "push"
          ? Math.max(
              0,
              layers.findIndex((route) => route.id === next.to?.id),
            )
          : layers.findIndex((route) => route.kind === "popup");
      layers.splice(index < 0 ? layers.length : index, 0, from);
    }
    phase = "transition";
    revision++;
    publish();
    const transition = await animate(job, next);
    if (disposed) throw new Interrupted("disposed");
    layers = materialized();
    transitionVisible.clear();
    // 先发布最终可见性，再释放实例，使清理回调读取到已离场的状态。
    publish();
    store.prune(layers, job.options.clearCache === true, options.maxCachedPages);
    publish();
    return { status: "completed", transition, redirected: next.redirected };
  }
  function result(job: RequestState, outcome: Outcome): NavigationResult {
    if (job.settled) return job.settled;
    if (disposed) outcome = { status: "cancelled", reason: "disposed" };
    const completed = Object.freeze({
      ...outcome,
      id: job.id,
      operation: job.intent.operation,
      info: job.info,
      resumedFromId: job.resumedFromId,
      state: snapshot,
    });
    // 先固定唯一结果，再调用外部观察者；同步销毁或取消不能重复发布终态。
    job.settled = completed;
    requested(job);
    if (job.id !== 0) lifecycle.settled(requestOf(job), completed);
    if (!disposed && outcome.status === "failed")
      report({
        error: outcome.error,
        navigationId: job.id,
        route: completed.state.top,
        severity: "error",
      });
    return completed;
  }
  function requestState(id: number, intent: Intent): RequestState {
    return {
      id,
      intent,
      info: undefined,
      reason: "program",
      resumedFromId: undefined,
      binding: undefined,
      requested: false,
      settled: undefined,
    };
  }
  function collectDefinitions(): void {
    const referenced = new Set<string>();
    const addIntent = (intent: Intent) => {
      if (intent.route) referenced.add(intent.route.name);
      for (const route of intent.routes ?? []) referenced.add(route.name);
    };
    for (const route of [...history, ...popups]) referenced.add(route.name);
    for (const record of records.values()) {
      referenced.add(record.route.name);
      if (record.interception) {
        addIntent(record.interception.intent);
        for (const route of [...record.interception.history, ...record.interception.popups])
          referenced.add(route.name);
      }
    }
    for (const job of queue) addIntent(job.intent);
    if (active) addIntent(active.intent);
    for (const name of dynamicDefinitions.keys())
      if (!referenced.has(name)) dynamicDefinitions.delete(name);
  }
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !disposed) {
        const job = queue.shift()!;
        active = job;
        phase = "guard";
        publish();
        let outcome: Outcome;
        try {
          outcome = await execute(job);
        } catch (cause) {
          if (cause instanceof Interrupted) outcome = { status: "cancelled", reason: cause.reason };
          else {
            const failure = error("GUARD_ERROR", "Navigation failed before completion.", cause);
            outcome = { status: "failed", error: failure };
          }
        }
        job.removeSignal();
        active = undefined;
        phase = disposed ? "disposed" : "idle";
        collectDefinitions();
        publish();
        job.resolve(result(job, outcome));
      }
    } finally {
      draining = false;
    }
  }
  function copyIntent(intent: Intent): Intent {
    return Object.freeze({
      ...intent,
      ...(intent.route ? { route: Object.freeze({ ...intent.route }) } : {}),
      ...(intent.routes
        ? {
            routes: Object.freeze(intent.routes.map((route) => Object.freeze({ ...route }))),
          }
        : {}),
    });
  }
  function enqueue(
    intent: Intent,
    navigationOptions: NavigationOptions = {},
    constraints: { pageId?: number; scopeSignal?: AbortSignal; failure?: PageStackError } = {},
  ): Promise<NavigationResult> {
    const id = ++navigationSeed;
    const stub = requestState(id, intent);
    if (disposed) return Promise.resolve(result(stub, { status: "cancelled", reason: "disposed" }));
    let captured: Intent;
    try {
      if (!navigationOptions || typeof navigationOptions !== "object")
        throw new TypeError("Navigation options must be an object.");
      navigationOptions = { ...navigationOptions };
      captured = copyIntent(intent);
      stub.intent = captured;
      if (intent.operation === "resume") {
        const top = snapshot.top;
        const interception = top ? records.get(top.id)?.interception : undefined;
        if (
          top &&
          interception &&
          !constraints.scopeSignal?.aborted &&
          (constraints.pageId === undefined || constraints.pageId === top.id)
        ) {
          stub.binding = { pageId: top.id, interception, scopeSignal: constraints.scopeSignal };
          stub.resumedFromId = interception.id;
          stub.info = interception.info;
        }
      }
      if (Object.hasOwn(navigationOptions, "info")) stub.info = navigationOptions.info;
      const signal = navigationOptions.signal;
      if (
        signal !== undefined &&
        (!signal ||
          typeof signal.aborted !== "boolean" ||
          typeof signal.addEventListener !== "function" ||
          typeof signal.removeEventListener !== "function")
      )
        throw new TypeError("signal must be an AbortSignal.");
      if (
        navigationOptions.clearCache !== undefined &&
        typeof navigationOptions.clearCache !== "boolean"
      )
        throw new TypeError("clearCache must be boolean.");
      if (
        navigationOptions.reason !== undefined &&
        !["user", "program", "native", "keyboard"].includes(navigationOptions.reason)
      )
        throw new TypeError("Invalid navigation reason.");
      stub.reason = navigationOptions.reason ?? "program";
    } catch (cause) {
      return Promise.resolve(
        result(stub, {
          status: "failed",
          error: error("INVALID_ROUTE", "Invalid navigation input.", cause),
        }),
      );
    }
    if (constraints.failure)
      return Promise.resolve(result(stub, { status: "failed", error: constraints.failure }));
    // 无有效拦截时立即终结，旧页面上下文不会因另一导航忙碌而改变恢复对象或进入队列。
    if (intent.operation === "resume" && !stub.binding)
      return Promise.resolve(result(stub, { status: "noop", reason: "not-intercepted" }));
    if (navigationOptions.signal?.aborted)
      return Promise.resolve(result(stub, { status: "cancelled", reason: "aborted" }));
    if (invokingGuard)
      return Promise.resolve(
        result(stub, {
          status: "failed",
          error: new PageStackError(
            "REENTRANT_NAVIGATION",
            "Return a redirect route from a guard instead of starting nested navigation.",
          ),
        }),
      );
    // 检查期间拒绝新导航，既避免重复点击排队，也避免异步守卫等待自身的嵌套导航形成死锁。
    if (active && phase === "guard")
      return Promise.resolve(result(stub, { status: "cancelled", reason: "busy" }));
    if (queue.length >= options.maxQueue)
      return Promise.resolve(
        result(stub, {
          status: "failed",
          error: new PageStackError(
            "QUEUE_FULL",
            `Navigation queue capacity is ${options.maxQueue}.`,
          ),
        }),
      );
    return new Promise<NavigationResult>((resolve) => {
      const job: Job = {
        ...stub,
        intent: captured,
        options: { ...navigationOptions },
        abort: new AbortController(),
        resolve,
        removeSignal: () => {},
      };
      const signal = navigationOptions.signal;
      const abort = () => {
        job.abort.abort(signal?.reason);
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1);
          job.removeSignal();
          publish();
          resolve(result(job, { status: "cancelled", reason: "aborted" }));
        }
      };
      if (signal) {
        try {
          signal.addEventListener("abort", abort, { once: true });
        } catch (cause) {
          resolve(
            result(job, {
              status: "failed",
              error: error("INVALID_ROUTE", "AbortSignal subscription failed.", cause),
            }),
          );
          return;
        }
        job.removeSignal = () => {
          notify(
            () => signal.removeEventListener("abort", abort),
            () => {},
          );
        };
      }
      queue.push(job);
      requested(job);
      publish();
      queueMicrotask(() => {
        void drain();
      });
    });
  }
  function dynamic(
    operation: "push" | "openPopup",
    definition: PageDefinition,
    params: unknown,
    opts?: NavigationOptions,
  ): Promise<NavigationResult> {
    let name: string;
    do {
      name = `@page-stack/dynamic/${++dynamicSeed}`;
    } while (Object.hasOwn(pages, name));
    try {
      dynamicDefinitions.set(name, definePages({ [name]: definition })[name]!);
    } catch (cause) {
      return enqueue({ operation, route: { name, params } }, opts, {
        failure: error("INVALID_CONFIG", "Invalid dynamic page definition.", cause),
      });
    }
    return enqueue({ operation, route: { name, params } }, opts).then((outcome) => {
      collectDefinitions();
      return outcome;
    });
  }
  const stack: PageStack<C> = Object.freeze<PageStack<C>>({
    get ready() {
      return ready;
    },
    catalog,
    getSnapshot: () => snapshot,
    subscribe(listener: (state: StackSnapshot) => void) {
      if (typeof listener !== "function")
        throw new PageStackError("INVALID_CONFIG", "State listener must be a function.");
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onError(listener: (diagnostic: Diagnostic) => void) {
      if (typeof listener !== "function")
        throw new PageStackError("INVALID_CONFIG", "Diagnostic listener must be a function.");
      if (!disposed) diagnostics.add(listener);
      return () => {
        diagnostics.delete(listener);
      };
    },
    beforeNavigate: lifecycle.beforeNavigate,
    onNavigation: lifecycle.onNavigation,
    beforeEach(guard: NavigationGuard<C>) {
      if (typeof guard !== "function")
        throw new PageStackError("INVALID_CONFIG", "Navigation guard must be a function.");
      if (!disposed) guards.add(guard);
      return () => {
        guards.delete(guard);
      };
    },
    push: (route, opts) => enqueue({ operation: "push", route }, opts),
    replace: (route, opts) => enqueue({ operation: "replace", route }, opts),
    reset: (routes, opts) => enqueue({ operation: "reset", routes }, opts),
    switchTab: (route, opts) => enqueue({ operation: "switchTab", route }, opts),
    openPopup: (route, opts) => enqueue({ operation: "openPopup", route }, opts),
    pushDynamic<P>(definition: PageDefinition<"page", P>, ...args: DynamicArguments<P>) {
      return dynamic("push", definition, args[0], args[1]);
    },
    openDynamicPopup<P>(definition: PageDefinition<"popup", P>, ...args: DynamicArguments<P>) {
      return dynamic("openPopup", definition, args[0], args[1]);
    },
    closePopup: (opts) => enqueue({ operation: "closePopup" }, opts),
    back: (delta = 1, opts) => enqueue({ operation: "back", delta }, opts),
    resume: (opts) => enqueue({ operation: "resume" }, opts),
    clearCache: async () => {
      if (disposed) return 0;
      const count = records.size;
      store.prune(layers, true, options.maxCachedPages);
      collectDefinitions();
      revision++;
      publish();
      return count - records.size;
    },
    cancel: () => active?.abort.abort("aborted"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      active?.abort.abort("disposed");
      transitionAbort?.abort("disposed");
      const running = active;
      const pending = queue.splice(0);
      history = [];
      popups = [];
      layers = [];
      transitionVisible.clear();
      phase = "disposed";
      revision++;
      publish();
      for (const record of [...records.values()]) store.drop(record);
      publish();
      listeners.clear();
      guards.clear();
      dynamicDefinitions.clear();
      renderer = undefined;
      rendererDuration = undefined;
      viewLease = undefined;
      for (const job of pending) {
        job.removeSignal();
        job.resolve(result(job, { status: "cancelled", reason: "disposed" }));
      }
      if (running) {
        running.removeSignal();
        running.resolve(result(running, { status: "cancelled", reason: "disposed" }));
      }
      lifecycle.close();
      diagnostics.clear();
    },
  });
  bindController(stack, {
    resume(id, opts, scopeSignal) {
      return enqueue({ operation: "resume" }, opts, {
        pageId: id,
        ...(scopeSignal ? { scopeSignal } : {}),
      });
    },
    reserveView() {
      if (disposed) throw new PageStackError("DISPOSED", "Cannot bind a view to a disposed stack.");
      if (viewLease || renderer)
        throw new PageStackError("RENDERER_CONFLICT", "A stack supports one active PageStackView.");
      const lease = Symbol("page-stack:view-owner");
      viewLease = lease;
      return () => {
        if (viewLease === lease) viewLease = undefined;
      };
    },
    record: (id) => records.get(id),
    report,
    hook: store.hook,
    guard(id, kind, callback) {
      const set = kind === "leave" ? records.get(id)?.leaveGuards : records.get(id)?.backGuards;
      set?.add(callback);
      return () => {
        set?.delete(callback);
      };
    },
    attachRenderer(run, duration) {
      if (disposed)
        throw new PageStackError("DISPOSED", "Cannot attach a view to a disposed stack.");
      if (renderer)
        throw new PageStackError(
          "RENDERER_CONFLICT",
          "A stack supports one active PageStackView. Use another stack instance for another view.",
        );
      renderer = run;
      rendererDuration = duration;
      return () => {
        if (renderer === run) {
          renderer = undefined;
          rendererDuration = undefined;
          transitionAbort?.abort("renderer-detached");
        }
      };
    },
  });
  publish();
  const ready = input.initial
    ? enqueue({ operation: "reset", routes: input.initial })
    : Promise.resolve(
        result(requestState(0, { operation: "reset" }), { status: "noop", reason: "empty" }),
      );
  return stack;
}
