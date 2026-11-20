import { resolveLayerOrder } from "./order.js";
import { LayerError } from "./errors.js";
export { LayerError } from "./errors.js";
import { bindLayerStyle } from "./styles.js";
import { notify } from "../notifications.js";
import { createResourceScope } from "./resources.js";
import type {
  LayerAnchor,
  LayerEntry,
  LayerHandle,
  LayerLayout,
  LayerOptions,
  LayerPlacement,
  LayerSnapshot,
  LayerStack,
  LayerStyle,
  LayerStyleSource,
} from "./types.js";

interface RecordEntry {
  readonly anchor: LayerAnchor;
  readonly scope: ReturnType<typeof createResourceScope>;
  readonly owner: LayerAnchor | undefined;
  readonly group: symbol | undefined;
  readonly styles: Map<symbol, LayerStyle>;
  readonly waiters: Set<{ resolve(element: HTMLElement): void; reject(error: unknown): void }>;
  options: LayerOptions;
  placement: LayerPlacement;
  baseStyle: LayerStyle;
  stopStyle: (() => void) | undefined;
  element: HTMLElement | undefined;
}

/** 图层内核只维护显示关系和资源所有权，不认识路由、返回、守卫或页面缓存。 */
export function createLayerStack(options: { onError?: (error: unknown) => void } = {}): LayerStack {
  const report = (error: unknown) =>
    notify(
      () => options.onError?.(error),
      () => {},
    );
  const scope = createResourceScope(report);
  const records = new Map<LayerAnchor, RecordEntry>();
  const subscribers = new Set<(snapshot: LayerSnapshot) => void>();
  let order: readonly LayerAnchor[] = [];
  let revision = 0,
    serial = 0,
    depth = 0,
    dirty = false,
    publishing = false;
  let renderer = false;
  let snapshot: LayerSnapshot = Object.freeze({
    revision,
    disposed: false,
    layers: Object.freeze([]),
  });
  const active = () => {
    if (scope.signal.aborted) throw new LayerError("Layer stack is disposed.");
  };
  const recordFor = (anchor: LayerAnchor) => {
    const record = records.get(anchor);
    if (!record) throw new LayerError("Unknown, foreign or disposed layer anchor.");
    return record;
  };
  const validate = (placement: LayerPlacement) => {
    if (placement.above) recordFor(placement.above);
    if (placement.below) recordFor(placement.below);
  };
  const sorted = () => resolveLayerOrder(records, order);
  const visible = (record: RecordEntry): boolean =>
    record.options.visible !== false &&
    (!record.owner || (records.has(record.owner) && visible(records.get(record.owner)!))) &&
    (!record.placement.above || records.has(record.placement.above)) &&
    (!record.placement.below || records.has(record.placement.below));
  function publish() {
    dirty = true;
    if (depth || publishing) return;
    publishing = true;
    try {
      while (dirty) {
        dirty = false;
        const layers: LayerEntry[] = sorted().map((record, zIndex) =>
          Object.freeze({
            anchor: record.anchor,
            visible: visible(record),
            interactive: record.options.interactive ?? false,
            zIndex,
            style: Object.freeze(Object.assign({}, record.baseStyle, ...record.styles.values())),
            attrs: Object.freeze({ ...record.options.attrs }),
            content: record.options.content,
            group: record.group,
            onError: record.options.onError,
          }),
        );
        snapshot = Object.freeze({
          revision: ++revision,
          disposed: scope.signal.aborted,
          layers: Object.freeze(layers),
        });
        for (const listener of [...subscribers]) {
          notify(() => listener(snapshot), report);
        }
      }
    } finally {
      publishing = false;
    }
  }
  function disposeRecord(record: RecordEntry) {
    if (!records.delete(record.anchor)) return;
    for (const child of [...records.values()])
      if (child.owner === record.anchor) disposeRecord(child);
    record.stopStyle?.();
    record.scope.dispose("layer-disposed");
    for (const waiter of record.waiters)
      waiter.reject(new LayerError("Layer disposed before mounting."));
    record.waiters.clear();
    record.element = undefined;
    publish();
  }
  const stack: LayerStack = {
    signal: scope.signal,
    create(input = {}) {
      return stack.batch(() => create(input));
    },
    order(anchors) {
      active();
      for (const anchor of anchors) recordFor(anchor);
      if (new Set(anchors).size !== anchors.length)
        throw new LayerError("Layer order contains duplicates.");
      const previous = order;
      order = [...anchors];
      try {
        sorted();
      } catch (error) {
        order = previous;
        throw error;
      }
      publish();
    },
    batch(run) {
      depth++;
      try {
        return run();
      } finally {
        if (!--depth && dirty) publish();
      }
    },
    getSnapshot: () => snapshot,
    has: (anchor) => records.has(anchor),
    subscribe(listener) {
      active();
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    onLayout(listener, group) {
      active();
      let previous: readonly LayerAnchor[] | undefined;
      const update = (value: LayerSnapshot) => {
        const anchors = value.layers
          .filter(
            (entry) =>
              entry.visible && (group === undefined || entry.group === (group ?? undefined)),
          )
          .map((entry) => entry.anchor);
        if (
          previous &&
          anchors.length === previous.length &&
          anchors.every((anchor, i) => anchor === previous![i])
        )
          return;
        previous = anchors;
        // 先保存当前布局再通知，允许回调创建附属层而不递归重复触发同一布局。
        notify(
          () => listener(Object.freeze({ visible: Object.freeze(anchors) }) satisfies LayerLayout),
          report,
        );
      };
      const remove = stack.subscribe(update);
      try {
        update(snapshot);
      } catch (error) {
        remove();
        throw error;
      }
      return remove;
    },
    getElement: (anchor) => records.get(anchor)?.element,
    attachRenderer() {
      active();
      if (renderer) throw new LayerError("Layer stack already has a renderer.");
      renderer = true;
      let attached = true;
      return {
        bind(anchor, element) {
          const record = records.get(anchor);
          if (!attached || !record) return;
          record.element = element;
          if (element) for (const waiter of [...record.waiters]) waiter.resolve(element);
        },
        dispose() {
          if (!attached) return;
          attached = false;
          renderer = false;
          for (const record of records.values()) {
            record.element = undefined;
            for (const waiter of [...record.waiters])
              waiter.reject(new LayerError("Layer renderer detached."));
          }
        },
      };
    },
    dispose() {
      if (scope.signal.aborted) return;
      stack.batch(() => {
        scope.dispose();
        for (const record of [...records.values()]) disposeRecord(record);
        publish();
      });
      subscribers.clear();
      order = [];
    },
  };
  function create(input: LayerOptions): LayerHandle {
    active();
    validate(input.placement ?? {});
    if (input.owner) recordFor(input.owner);
    const record: RecordEntry = {
      anchor: Object.freeze({ id: ++serial }),
      scope: createResourceScope(report),
      owner: input.owner,
      group: input.group,
      styles: new Map(),
      waiters: new Set(),
      options: { ...input },
      placement: Object.freeze({ ...input.placement }),
      baseStyle: {},
      stopStyle: undefined,
      element: undefined,
    };
    records.set(record.anchor, record);
    const ensure = () => {
      active();
      recordFor(record.anchor);
    };
    try {
      if (input.style)
        record.stopStyle = bindLayerStyle(
          input.style,
          (value) => {
            record.baseStyle = value;
            publish();
          },
          report,
        );
      if (record.scope.signal.aborted) {
        record.stopStyle?.();
        throw new LayerError("Layer disposed during style initialization.");
      }
    } catch (error) {
      records.delete(record.anchor);
      record.scope.dispose();
      publish();
      throw error;
    }
    const handle: LayerHandle = Object.freeze({
      anchor: record.anchor,
      group: record.group,
      signal: record.scope.signal,
      styles: Object.freeze({
        bind(source: LayerStyleSource) {
          ensure();
          const slot = Symbol("style-contribution");
          const stop = bindLayerStyle(
            source,
            (value) => {
              record.styles.set(slot, value);
              publish();
            },
            report,
          );
          return record.scope.own(() => {
            stop();
            record.styles.delete(slot);
            publish();
          });
        },
      }),
      get element() {
        return record.element;
      },
      place(placement: LayerPlacement) {
        ensure();
        validate(placement);
        const previous = record.placement;
        record.placement = Object.freeze({ ...placement });
        try {
          sorted();
        } catch (error) {
          record.placement = previous;
          throw error;
        }
        publish();
      },
      update(value: Omit<LayerOptions, "placement" | "owner" | "group">) {
        stack.batch(() => {
          ensure();
          if (Object.hasOwn(value, "style")) {
            let next: LayerStyle = {};
            let ready = false;
            const stop = value.style
              ? bindLayerStyle(
                  value.style,
                  (style) => {
                    next = style;
                    if (ready) {
                      record.baseStyle = style;
                      publish();
                    }
                  },
                  report,
                )
              : undefined;
            // 新绑定先成功建立，再替换旧绑定；同步回收期间返回的 watcher 立即停止。
            if (record.scope.signal.aborted) {
              stop?.();
              throw new LayerError("Layer disposed during style update.");
            }
            record.stopStyle?.();
            record.stopStyle = stop;
            record.baseStyle = next;
            ready = true;
          }
          record.options = { ...record.options, ...value };
          publish();
        });
      },
      whenMounted(signal?: AbortSignal) {
        if (record.scope.signal.aborted || signal?.aborted)
          return Promise.reject(new LayerError("Layer mount was aborted."));
        if (record.element) return Promise.resolve(record.element);
        return new Promise<HTMLElement>((resolve, reject) => {
          const cleanup = () => {
            record.waiters.delete(waiter);
            signal?.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            reject(new LayerError("Layer mount was aborted."));
          };
          const waiter = {
            resolve(element: HTMLElement) {
              cleanup();
              resolve(element);
            },
            reject(error: unknown) {
              cleanup();
              reject(error);
            },
          };
          record.waiters.add(waiter);
          signal?.addEventListener("abort", abort, { once: true });
        });
      },
      async animate(frames: Keyframe[], timing: KeyframeAnimationOptions = { duration: 300 }) {
        const element = await handle.whenMounted(record.scope.signal);
        ensure();
        if (typeof element.animate !== "function") return;
        const animation = element.animate(frames, { fill: "both", ...timing });
        await new Promise<void>((resolve, reject) => {
          // 立即接住 finished，申请动画同步触发销毁时也不会留下未处理拒绝。
          const completion = Promise.resolve(animation.finished);
          let release = () => {};
          void completion.then(
            () => {
              resolve();
              release();
            },
            (error) => {
              reject(error);
              release();
            },
          );
          release = record.scope.own(() => {
            try {
              animation.cancel();
            } finally {
              reject(new LayerError("Layer animation released."));
            }
          });
        });
      },
      dispose: () => stack.batch(() => disposeRecord(record)),
    });
    publish();
    return handle;
  }
  return Object.freeze(stack);
}
