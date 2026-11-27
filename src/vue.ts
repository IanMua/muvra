import {
  computed,
  defineComponent,
  getCurrentInstance,
  getCurrentScope,
  h,
  inject,
  nextTick,
  onBeforeUnmount,
  onErrorCaptured,
  onMounted,
  onScopeDispose,
  provide,
  ref,
  shallowRef,
  Suspense,
  watch,
  watchPostEffect,
} from "vue";
import type { ComputedRef, PropType, Ref, VNodeChild } from "vue";
import { isFocusable, tabbable } from "tabbable";
import { controllerFor } from "./internal.js";
import type { HookKind } from "./internal.js";
import { PageKey } from "./context.js";
import { PageStackError } from "./errors.js";
import { createLayerStack } from "./layers/stack.js";
import { LayerStackView } from "./layers/vue.js";
import { createExtensionHost } from "./layers/extensions.js";
import type { ExtensionHost } from "./layers/extensions.js";
import type { LayerHandle } from "./layers/types.js";
import {
  isProgressTransition,
  isTransitionEffect,
  selectTransition,
  validTransition,
} from "./animation/effect.js";
import { createProgressPlayback, runTransition } from "./animation/scope.js";
import type { TransitionEnvironment } from "./animation/types.js";
import type { RenderRequest } from "./internal.js";
import { notify } from "./notifications.js";
import { createBackPreviewRenderer } from "./vue-back-preview.js";
import type {
  BackPreviewProvider,
  PageCatalog,
  PageContext,
  PageNames,
  PageOptions,
  PageStack,
  ParamsOf,
  ResolvedRoute,
  StackSnapshot,
} from "./types.js";

/** 在组件或 effectScope 内订阅状态，作用域结束后自动退订。普通服务使用 stack.subscribe。 */
export function useStackState<C extends PageCatalog>(
  stack: PageStack<C>,
): ComputedRef<StackSnapshot> {
  if (!getCurrentScope())
    throw new PageStackError(
      "INVALID_CONFIG",
      "useStackState must run inside a Vue setup or effectScope.",
    );
  const state = shallowRef(stack.getSnapshot());
  const unsubscribe = stack.subscribe((value) => {
    state.value = value;
  });
  onScopeDispose(unsubscribe);
  return computed(() => state.value);
}

/** 指定实例与页面名时自动推导参数，并在运行时检查组件是否挂在对应实例和页面下。 */
export function usePage<C extends PageCatalog, N extends PageNames<C>>(
  stack: PageStack<C>,
  name: N,
): PageContext<ParamsOf<C[N]>>;
export function usePage<P = unknown>(): PageContext<P>;
export function usePage(stack?: PageStack<any>, name?: string): PageContext<unknown> {
  if (!getCurrentInstance())
    throw new PageStackError("INVALID_CONFIG", "usePage must run during component setup.");
  const injection = inject(PageKey);
  if (!injection)
    throw new PageStackError(
      "INVALID_CONFIG",
      "usePage must run under PageStackView during component setup.",
    );
  if (stack && stack !== injection.stack)
    throw new PageStackError("INVALID_CONFIG", "The page belongs to a different stack instance.");
  if (name && name !== injection.initial.name)
    throw new PageStackError(
      "INVALID_ROUTE",
      `Expected page "${name}", received "${injection.initial.name}".`,
    );
  const { id, state } = injection;
  const controller = controllerFor(injection.stack);
  const scopeAlive = shallowRef(true);
  const lifetime = new AbortController();
  const extensionRemovers = new Set<() => void>();
  const recordSignal = injection.record.abort.signal;
  const forwardAbort = () => {
    scopeAlive.value = false;
    lifetime.abort(recordSignal.reason);
  };
  if (recordSignal.aborted) forwardAbort();
  else recordSignal.addEventListener("abort", forwardAbort, { once: true });
  onScopeDispose(() => {
    scopeAlive.value = false;
    lifetime.abort("page-unmounted");
    recordSignal.removeEventListener("abort", forwardAbort);
    for (const remove of extensionRemovers) remove();
    extensionRemovers.clear();
  });
  const route = computed(() => {
    void state.value;
    return injection.record.route;
  });
  const info = computed(() => state.value.rendered.find((entry) => entry.route.id === id));
  function lifecycle(kind: HookKind, callback: () => void): () => void {
    if (typeof callback !== "function")
      throw new PageStackError("INVALID_CONFIG", "Page lifecycle callback must be a function.");
    if (!getCurrentScope())
      throw new PageStackError("INVALID_CONFIG", "Register page lifecycle callbacks during setup.");
    let registered = true,
      unloaded = false,
      mounted = false;
    const invoke = () => {
      if (!registered || (kind === "unload" && unloaded)) return;
      if (kind === "unload") unloaded = true;
      notify(callback, (cause) =>
        controller.report({
          error: new PageStackError(
            "HOOK_ERROR",
            `Page "${route.value.name}" ${kind} hook failed.`,
            cause,
          ),
          navigationId: state.value.pending?.id,
          route: route.value,
          severity: "error",
        }),
      );
    };
    const binding = controller.hook(id, kind, invoke);
    const remove = () => {
      registered = false;
      binding.remove();
    };
    onMounted(() => {
      mounted = true;
      binding.activate();
    });
    onScopeDispose(() => {
      // 视图卸载或错误重试也会销毁组件，不能仅依靠内核回收实例时触发资源清理。
      if (kind === "unload" || (kind === "hide" && mounted && controller.record(id)?.visible))
        invoke();
      remove();
    });
    return remove;
  }
  return Object.freeze({
    extend(definition) {
      if (!scopeAlive.value) throw new PageStackError("DISPOSED", "Page component is unmounted.");
      const unregister = injection.extensions.extend(definition);
      const remove = () => {
        extensionRemovers.delete(remove);
        unregister();
      };
      extensionRemovers.add(remove);
      return remove;
    },
    signal: lifetime.signal,
    route,
    params: computed(() => route.value.params),
    visible: computed(() => scopeAlive.value && (info.value?.visible ?? false)),
    focused: computed(() => scopeAlive.value && (info.value?.focused ?? false)),
    isIntercepted: computed(() => {
      void state.value;
      return scopeAlive.value && Boolean(controller.record(id)?.interception);
    }),
    // 同时绑定页面身份和本次组件作用域，排队期间重挂后旧上下文不能恢复新拦截。
    resume: (options) => controller.resume(id, options, lifetime.signal),
    onShow: (callback) => lifecycle("show", callback),
    onHide: (callback) => lifecycle("hide", callback),
    onUnload: (callback) => lifecycle("unload", callback),
    beforeLeave: (guard) => {
      if (!getCurrentScope() || typeof guard !== "function")
        throw new PageStackError("INVALID_CONFIG", "Register a leave guard function during setup.");
      const remove = controller.guard(id, "leave", guard);
      onScopeDispose(remove);
      return remove;
    },
    beforeBack: (guard) => {
      if (!getCurrentScope() || typeof guard !== "function")
        throw new PageStackError("INVALID_CONFIG", "Register a back guard function during setup.");
      const remove = controller.guard(id, "back", guard);
      onScopeDispose(remove);
      return remove;
    },
  } satisfies PageContext<unknown>);
}

type SharedProps = Record<string, unknown> | ((route: ResolvedRoute) => Record<string, unknown>);

function deepActive(): Element | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}
function containsFocus(root: HTMLElement, element: Element | null): boolean {
  let current = element;
  while (current) {
    if (root.contains(current)) return true;
    const owner = current.getRootNode();
    current = "host" in owner ? (owner as ShadowRoot).host : null;
  }
  return false;
}

/** 每个页面独立提供上下文和错误边界，组件失败不会破坏其他页面或导航队列。 */
const PageHost = defineComponent({
  name: "PageStackHost",
  props: {
    stack: { type: Object as PropType<PageStack<any>>, required: true },
    id: { type: Number, required: true },
    extensions: { type: Object as PropType<ExtensionHost>, required: true },
    state: { type: Object as PropType<Readonly<Ref<StackSnapshot>>>, required: true },
    pageProps: {
      type: [Object, Function] as PropType<SharedProps>,
      required: true,
    },
  },
  emits: ["ready"],
  setup(props, { slots, emit }) {
    const controller = controllerFor(props.stack);
    const initial = controller.record(props.id)!.route;
    provide(PageKey, {
      stack: props.stack,
      id: props.id,
      state: props.state,
      initial,
      record: controller.record(props.id)!,
      extensions: props.extensions,
    });
    const failure = shallowRef<{ cause: unknown }>();
    const generation = ref(0);
    const capture = (cause: unknown) => {
      failure.value = { cause };
      controller.report({
        error: new PageStackError(
          "COMPONENT_ERROR",
          `Page "${initial.name}" could not render.`,
          cause,
        ),
        navigationId: props.state.value.pending?.id,
        route: controller.record(props.id)?.route ?? initial,
        severity: "error",
      });
      void nextTick().then(() => emit("ready"));
    };
    onErrorCaptured((cause) => {
      capture(cause);
      return false;
    });
    const retry = () => {
      failure.value = undefined;
      generation.value++;
    };
    const fallback = (): VNodeChild => {
      if (slots.error) {
        try {
          return slots.error({
            error: failure.value?.cause,
            route: controller.record(props.id)?.route ?? initial,
            retry,
          });
        } catch (cause) {
          controller.report({
            error: new PageStackError("COMPONENT_ERROR", "Page error slot failed.", cause),
            navigationId: props.state.value.pending?.id,
            route: initial,
            severity: "error",
          });
        }
      }
      return h("div", { role: "alert", "data-page-error": initial.name }, [
        h("p", "This page could not be displayed."),
        h("button", { type: "button", onClick: retry }, "Retry"),
        h(
          "button",
          {
            type: "button",
            onClick: () => {
              void props.stack.back();
            },
          },
          "Back",
        ),
      ]);
    };
    return () => {
      // 共享 Ref 在内核发布时立即更新；生命周期回调不必等待 Vue 下一次 props patch。
      void props.state.value;
      if (failure.value !== undefined) return fallback();
      const record = controller.record(props.id);
      if (!record) return null;
      try {
        const shared =
          typeof props.pageProps === "function" ? props.pageProps(record.route) : props.pageProps;
        if (!shared || typeof shared !== "object" || Array.isArray(shared))
          throw new PageStackError("INVALID_CONFIG", "pageProps must return a plain props object.");
        const params = record.route.params;
        const componentProps = {
          ...shared,
          ...(params !== null && typeof params === "object" ? params : {}),
          key: generation.value,
        };
        // Vue 的 ref 是 VNode 控制参数；业务数据仍可完整通过 usePage().params 读取。
        delete (componentProps as Record<string, unknown>).ref;
        return h(
          Suspense,
          { onResolve: () => emit("ready") },
          {
            default: () => h(record.definition.component, componentProps),
            fallback: () =>
              slots.loading?.({ route: record.route }) ??
              h("div", { role: "status", "data-page-loading": record.route.name }, "Loading…"),
          },
        );
      } catch (cause) {
        capture(cause);
        return fallback();
      }
    };
  },
});

const viewProps = {
  stack: { type: Object as PropType<PageStack<any>>, required: true },
  pageProps: {
    type: [Object, Function] as PropType<SharedProps>,
    default: () => ({}),
  },
  // true 允许声明的动画播放；框架不隐式添加视觉效果。
  transition: {
    type: [Function, Boolean, Object] as PropType<NonNullable<PageOptions["transition"]> | true>,
    default: true,
  },
  backPreview: Function as PropType<BackPreviewProvider>,
  keyboard: { type: Boolean, default: true },
  restoreFocus: { type: Boolean, default: true },
} as const;

/** 页面容器只渲染实例快照并消费转场请求；历史及缓存始终由实例内核管理。 */
const BoundPageStackView = defineComponent({
  name: "BoundPageStackView",
  inheritAttrs: false,
  props: viewProps,
  setup(props, { attrs, slots }) {
    const container = ref<HTMLElement>();
    const state = shallowRef(props.stack.getSnapshot());
    const controller = controllerFor(props.stack);
    const release = controller.reserveView();
    onScopeDispose(release);
    const reportLayer = (cause: unknown) =>
      controller.report({
        error: new PageStackError("COMPONENT_ERROR", "Page layer extension failed.", cause),
        navigationId: state.value.pending?.id,
        route: state.value.top,
        severity: "error",
      });
    const layers = createLayerStack({ onError: reportLayer });
    const pageGroup = Symbol("navigation-pages");
    const bindings = new Map<number, { layer: LayerHandle; extensions: ExtensionHost }>();
    let revealed: { id: number } | undefined;
    function reconcile(value: StackSnapshot) {
      layers.batch(() => {
        const alive = new Set(value.rendered.map((entry) => entry.route.id));
        for (const [id, binding] of bindings)
          if (!alive.has(id)) {
            bindings.delete(id);
            binding.extensions.dispose();
            binding.layer.dispose();
          }
        for (const entry of value.rendered) {
          let binding = bindings.get(entry.route.id);
          if (!binding) {
            const layer = layers.create({
              group: pageGroup,
              visible: entry.visible,
              style: { overflow: "auto" },
            });
            const extensions = createExtensionHost(
              layers,
              layer,
              controller.record(entry.route.id)!.definition.extensions,
              {
                group: pageGroup,
                onError: reportLayer,
              },
            );
            binding = { layer, extensions };
            bindings.set(entry.route.id, binding);
            layer.update({
              content: () =>
                h(
                  PageHost,
                  {
                    stack: props.stack,
                    id: entry.route.id,
                    state,
                    extensions,
                    pageProps: props.pageProps,
                    onReady: () => {
                      void nextTick().then(() => {
                        maybeFocus();
                        controller.refreshBack();
                      });
                    },
                  },
                  {
                    ...(slots.error ? { error: slots.error } : {}),
                    ...(slots.loading ? { loading: slots.loading } : {}),
                  },
                ),
            });
          }
          binding.layer.update({
            visible: entry.visible || revealed?.id === entry.route.id,
            interactive: entry.focused && value.phase !== "transition",
            attrs: {
              "data-page-id": entry.route.id,
              "data-page-name": entry.route.name,
              "data-page-focused": String(entry.focused),
              tabindex: -1,
              role: entry.route.kind === "popup" ? "dialog" : undefined,
              "aria-label":
                entry.route.kind === "popup"
                  ? String(entry.route.meta.title ?? entry.route.name)
                  : undefined,
              "aria-modal": entry.route.kind === "popup" && entry.focused ? "true" : undefined,
              "aria-hidden": entry.focused ? undefined : "true",
              inert: !entry.focused || value.phase === "transition",
            },
          });
        }
        layers.order(
          [...value.rendered]
            .sort((a, b) => a.zIndex - b.zIndex)
            .map((entry) => bindings.get(entry.route.id)!.layer.anchor),
        );
      });
    }
    onScopeDispose(() => {
      for (const binding of bindings.values()) binding.extensions.dispose();
      bindings.clear();
      layers.dispose();
    });
    const lastFocus = new Map<number, HTMLElement>();
    const unsubscribe = props.stack.subscribe((value) => {
      if (
        typeof document !== "undefined" &&
        (value.top?.id !== state.value.top?.id || (!state.value.busy && value.busy))
      ) {
        const element = deepActive();
        if (
          element instanceof HTMLElement &&
          container.value &&
          containsFocus(container.value, element) &&
          state.value.top
        ) {
          lastFocus.set(state.value.top.id, element);
          if (value.top?.id !== state.value.top?.id) element.blur();
        }
      }
      const alive = new Set(value.rendered.map((entry) => entry.route.id));
      for (const id of lastFocus.keys()) if (!alive.has(id)) lastFocus.delete(id);
      state.value = value;
      reconcile(value);
    });
    onScopeDispose(unsubscribe);
    const elementFor = (id: number | undefined) =>
      id === undefined ? undefined : bindings.get(id)?.layer.element;
    // 统一处理禁用 fieldset、radio 分组、正 tabindex 及开放 Shadow DOM 的焦点顺序。
    const focusables = (element: HTMLElement) => tabbable(element, { getShadowRoot: true });
    const focusTop = () => {
      if (!props.restoreFocus || typeof document === "undefined" || state.value.phase !== "idle")
        return;
      const top = state.value.top;
      const element = elementFor(top?.id);
      if (!top || !element || (deepActive() !== element && containsFocus(element, deepActive())))
        return;
      const previous = lastFocus.get(top.id);
      const target =
        previous?.isConnected && containsFocus(element, previous) && isFocusable(previous)
          ? previous
          : (focusables(element)[0] ?? element);
      target.focus({ preventScroll: true });
    };
    const maybeFocus = () => {
      if (
        typeof document === "undefined" ||
        document.activeElement === document.body ||
        container.value?.contains(document.activeElement)
      )
        focusTop();
    };
    let detach: (() => void) | undefined;
    const transitionFor = (request: Omit<RenderRequest, "signal">) => {
      if (!props.transition) return false;
      const fallback = props.transition === true ? false : props.transition;
      if (!validTransition(fallback))
        throw new PageStackError("INVALID_CONFIG", "Invalid view transition.");
      return selectTransition(
        request.operation,
        request.from ? controller.record(request.from.id)?.definition.transition : undefined,
        request.to ? controller.record(request.to.id)?.definition.transition : undefined,
        fallback,
      );
    };
    const reducedMotion = ref(false);
    let stopMotion: (() => void) | undefined;
    function transitionEnvironment(
      route: ResolvedRoute | undefined,
      navigationId: number | undefined,
    ): TransitionEnvironment {
      return {
        document: container.value?.ownerDocument,
        createLayer(component, componentProps, fail) {
          const foreground = layers
            .getSnapshot()
            .layers.filter((entry) => entry.visible)
            .at(-1)?.anchor;
          const layer = layers.create({
            ...(foreground ? { placement: { above: foreground } } : {}),
            attrs: { "data-page-stack-effect-layer": "", "aria-hidden": "true", inert: true },
            ...(component ? { content: () => h(component, componentProps) } : {}),
            onError: fail,
          });
          // 延迟申请挂载 Promise，避免申请期间同步取消后出现未被消费的拒绝。
          return {
            get element() {
              return layer.element!;
            },
            get ready() {
              return layer.whenMounted().then(() => {});
            },
            dispose: layer.dispose,
          };
        },
        onCleanupError: (cause) =>
          controller.report({
            error: new PageStackError("TRANSITION_ERROR", "Transition cleanup failed.", cause),
            navigationId,
            route,
            severity: "warning",
          }),
      };
    }
    const backPreview = createBackPreviewRenderer({
      layers,
      layerFor: (id) => bindings.get(id)?.layer,
      reveal(id) {
        const lease = { id };
        revealed = lease;
        bindings.get(id)?.layer.update({ visible: true });
        return () => {
          if (revealed !== lease) return;
          revealed = undefined;
          const entry = state.value.rendered.find((page) => page.route.id === id);
          if (entry) bindings.get(id)?.layer.update({ visible: entry.visible });
        };
      },
      transition: transitionFor,
      provider: () => props.backPreview,
      environment: (route) => transitionEnvironment(route, undefined),
      reducedMotion: () => reducedMotion.value,
      report: (cause, route) =>
        controller.report({
          error: new PageStackError("TRANSITION_ERROR", "Back preview failed.", cause),
          navigationId: undefined,
          route,
          severity: "warning",
        }),
    });
    watchPostEffect(() => {
      // 模板更新后 DOM 才就绪。只在能力变化时发布快照，进度留在预览渲染器。
      if (!state.value.busy && !state.value.disposed) controller.refreshBack();
    });
    onMounted(() => {
      const motion = container.value?.ownerDocument?.defaultView?.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      );
      if (motion) {
        const update = () => {
          reducedMotion.value = motion.matches;
        };
        update();
        motion.addEventListener?.("change", update);
        stopMotion = () => motion.removeEventListener?.("change", update);
      }
      detach = controller.attachRenderer(
        async (request) => {
          // 异步清理可能晚于下一次导航，上报时必须保留本次播放的导航标识。
          const navigationId = state.value.pending?.id;
          await nextTick();
          if (!props.transition || request.signal.aborted) return false;
          const driver = transitionFor(request);
          if (!driver) return false;
          const from = elementFor(request.from?.id);
          const to = elementFor(request.to?.id);
          if (!from && !to) return false;
          if (reducedMotion.value) return false;
          const context = {
            operation: request.operation,
            from,
            to,
            fromRoute: request.from,
            toRoute: request.to,
            durationMs: request.durationMs,
            signal: request.signal,
          };
          const environment = transitionEnvironment(request.to, navigationId);
          if (isProgressTransition(driver))
            await createProgressPlayback(driver, context, environment).settle(1);
          else if (isTransitionEffect(driver)) await runTransition(driver, context, environment);
          else await driver(context);
          return true;
        },
        (request) => {
          const driver = transitionFor(request);
          return !driver ? 0 : typeof driver === "object" ? driver.duration : request.durationMs;
        },
        backPreview,
      );
      maybeFocus();
    });
    onBeforeUnmount(() => {
      stopMotion?.();
      detach?.();
      lastFocus.clear();
    });
    watch(
      () => [state.value.top?.id, state.value.phase],
      async () => {
        await nextTick();
        focusTop();
      },
      { flush: "post" },
    );
    const keydown = (event: KeyboardEvent) => {
      if (!props.keyboard || event.defaultPrevented || state.value.top?.kind !== "popup") return;
      const top = elementFor(state.value.top.id);
      if (!top) return;
      if (event.key === "Escape" && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        void props.stack.back(1, { reason: "keyboard" });
      } else if (event.key === "Tab") {
        const candidates = focusables(top);
        const first = candidates[0];
        const last = candidates.at(-1);
        if (!first || !last) {
          event.preventDefault();
          top.focus();
        } else if (event.shiftKey && (deepActive() === first || deepActive() === top)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && deepActive() === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      const target = event.target;
      const top = elementFor(state.value.top?.id);
      if (
        target instanceof HTMLElement &&
        top &&
        (!top.contains(target) || state.value.phase === "transition")
      ) {
        // 不支持 inert 的宿主仍需阻止背景获得焦点；焦点恢复关闭时交由宿主 UI 管理。
        target.blur();
        focusTop();
      }
    };
    // 初次渲染也通过同一桥接；导航历史始终留在上层内核。
    reconcile(state.value);
    return () =>
      h(LayerStackView, {
        ...attrs,
        stack: layers,
        "data-page-stack": "",
        onRoot: (element: HTMLElement | undefined) => {
          container.value = element;
        },
        onKeydown: keydown,
        onFocusin: focusin,
      });
  },
});

/** 实例 prop 改变时重建内部绑定，防止同名记录 ID 导致旧上下文被复用于新实例。 */
export const PageStackView = defineComponent({
  name: "PageStackView",
  inheritAttrs: false,
  props: viewProps,
  setup(props, { attrs, slots }) {
    const binding = shallowRef(Symbol("page-stack:view"));
    watch(
      () => props.stack,
      () => {
        binding.value = Symbol("page-stack:view");
      },
      { flush: "sync" },
    );
    return () => {
      const { backPreview, ...rest } = props;
      return h(
        BoundPageStackView,
        { ...attrs, ...rest, ...(backPreview ? { backPreview } : {}), key: binding.value },
        slots,
      );
    };
  },
});
