import { nextTick } from "vue";
import { isProgressTransition } from "./animation/effect.js";
import { createProgressPlayback } from "./animation/scope.js";
import type { TransitionEnvironment } from "./animation/types.js";
import type { BackPreview, BackRenderer, BackTarget } from "./internal.js";
import { createResourceScope } from "./layers/resources.js";
import type { LayerHandle, LayerStack } from "./layers/types.js";
import type { BackPreviewProvider, PageOptions, ResolvedRoute } from "./types.js";

/** 预览临时借用视图图层，逻辑可见性和焦点仍由导航快照控制。 */
export function createBackPreviewRenderer(view: {
  layers: LayerStack;
  layerFor(id: number): LayerHandle | undefined;
  reveal(id: number): () => void;
  transition(target: BackTarget): PageOptions["transition"];
  provider(): BackPreviewProvider | undefined;
  environment(route: ResolvedRoute): TransitionEnvironment;
  reducedMotion(): boolean;
  report(cause: unknown, route: ResolvedRoute): void;
}): BackRenderer {
  let failedTarget: number | undefined;
  function select(target: BackTarget) {
    try {
      const provider = view.provider();
      if (!provider || !target.durationMs || view.reducedMotion()) return;
      const effect = view.transition(target);
      if (!isProgressTransition(effect) || !effect.duration) return;
      const owner = view.layerFor(target.from.id);
      const from = owner?.element;
      if (!owner || !from?.isConnected) return;
      const window = from.ownerDocument.defaultView;
      if (!window) return;
      const source = provider({ operation: target.operation, from: target.from, to: target.to });
      const mounted = source === "mounted" ? view.layerFor(target.to.id) : undefined;
      if (typeof source !== "function" && !(source === "mounted" && mounted?.element?.isConnected))
        return;
      failedTarget = undefined;
      return { effect, owner, from, window, source, mounted };
    } catch (cause) {
      // 能力计算也会随导航发布。延后上报，避免诊断观察者重入尚未发布的状态。
      if (failedTarget !== target.to.id) {
        failedTarget = target.to.id;
        queueMicrotask(() => view.report(cause, target.to));
      }
      return;
    }
  }

  function start(target: BackTarget): BackPreview | undefined {
    const selected = select(target);
    if (!selected) return;
    const { window, from, owner, effect, source, mounted } = selected;
    const lifetime = createResourceScope((cause) => view.report(cause, target.to));
    let playback: ReturnType<typeof createProgressPlayback> | undefined;
    let progress = 0;
    let frame: number | undefined;
    let guardFrame: number | undefined;
    function stopFrames(): void {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (guardFrame !== undefined) window.cancelAnimationFrame(guardFrame);
      frame = guardFrame = undefined;
    }
    function dispose(): void {
      stopFrames();
      lifetime.dispose();
    }
    function fail(cause: unknown): void {
      if (lifetime.signal.aborted) return;
      dispose();
      view.report(cause, target.to);
    }
    function follow(signal: AbortSignal): void {
      signal.addEventListener("abort", dispose, { once: true });
      lifetime.own(() => signal.removeEventListener("abort", dispose));
      if (signal.aborted) dispose();
    }
    function prepare(to: HTMLElement): void {
      if (lifetime.signal.aborted) return;
      playback = createProgressPlayback(
        effect,
        {
          operation: target.operation,
          from,
          to,
          fromRoute: target.from,
          toRoute: target.to,
          durationMs: effect.duration,
          signal: lifetime.signal,
        },
        view.environment(target.to),
      );
      lifetime.own(playback.dispose);
      playback.seek(progress);
    }
    function draw(): void {
      frame = undefined;
      try {
        playback?.seek(progress);
      } catch (cause) {
        fail(cause);
      }
    }

    let ready = Promise.resolve();
    try {
      follow(owner.signal);
      const retained = mounted?.element;
      if (retained && mounted) {
        follow(mounted.signal);
        lifetime.own(view.reveal(target.to.id));
        // 先让 Vue 将目标的临时可见性写入 DOM，动效准备时才能测量它的布局。
        ready = nextTick()
          .then(() => prepare(retained))
          .catch(fail);
      } else if (typeof source === "function") {
        const layer = view.layers.create({
          placement: { below: owner.anchor },
          content: source,
          interactive: false,
          attrs: { inert: true, "aria-hidden": "true", "data-page-stack-back-preview": "" },
          onError: fail,
        });
        lifetime.own(layer.dispose);
        ready = layer.whenMounted(lifetime.signal).then(prepare).catch(fail);
      }
    } catch (cause) {
      fail(cause);
      return;
    }

    return {
      update(value) {
        if (lifetime.signal.aborted) return;
        progress = value;
        if (frame === undefined) frame = window.requestAnimationFrame(draw);
      },
      async rewind() {
        stopFrames();
        try {
          if (!lifetime.signal.aborted && playback) await playback.settle(0);
        } catch (cause) {
          fail(cause);
        } finally {
          dispose();
        }
      },
      waitForCommit() {
        stopFrames();
        // 守卫跨帧等待时把完整画面交回当前页，确认 UI 可以立即显示。
        if (!lifetime.signal.aborted) guardFrame = window.requestAnimationFrame(dispose);
      },
      async complete(request) {
        stopFrames();
        try {
          if (
            lifetime.signal.aborted ||
            request.from !== target.from ||
            request.to !== target.to ||
            request.operation !== target.operation
          )
            return false;
          follow(request.signal);
          await ready;
          if (lifetime.signal.aborted || !playback) return false;
          await nextTick();
          if (lifetime.signal.aborted) return false;
          if (typeof source === "function") {
            // 只读预览保留到最后一帧，真实目标已交给视图挂载，交接时不会露出双层画面。
            const destination = view.layerFor(target.to.id);
            if (destination) lifetime.own(destination.styles.bind({ visibility: "hidden" }));
          }
          playback.seek(progress);
          await playback.settle(1);
          return true;
        } finally {
          dispose();
        }
      },
      dispose,
    };
  }
  return { available: (target) => select(target) !== undefined, start };
}
