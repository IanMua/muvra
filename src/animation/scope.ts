import { createResourceScope } from "../layers/resources.js";
import { settle } from "../async.js";
import { Interrupted, PageStackError } from "../errors.js";
import type { TransitionContext } from "../types.js";
import { milliseconds } from "./effect.js";
import type {
  EffectTiming,
  ProgressTransition,
  TransitionEffect,
  TransitionEnvironment,
  TransitionScope,
} from "./types.js";

/** 同一作用域供编排和进度转场使用，关闭后迟到的任务不能重新申请资源。 */
function createTransitionScope(
  context: TransitionContext,
  environment: TransitionEnvironment,
  coalesceStyles = false,
) {
  const abort = new AbortController();
  const cleanupErrors: unknown[] = [];
  const resources = createResourceScope((error) => {
    cleanupErrors.push(error);
    // 清理 Promise 可能在播放结束后才拒绝，诊断必须跟随每次失败即时送出。
    environment.onCleanupError?.(error);
  });
  const pending = new Set<Promise<unknown>>();
  const originalStyles = coalesceStyles ? new WeakMap<HTMLElement, Set<string>>() : undefined;
  let closed = false;
  let hasFailure = false;
  let failure: unknown;
  const active = () => {
    if (closed || abort.signal.aborted) throw new Interrupted("aborted");
  };
  const own = (cleanup: () => void) => {
    // 资源申请同步触发取消时，公共作用域会立即释放迟到的句柄。
    resources.own(cleanup);
    active();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    context.signal.removeEventListener("abort", close);
    abort.abort(context.signal.reason ?? "transition-finished");
    resources.dispose();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    hasFailure = true;
    failure = error;
    close();
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    // 在创建当下接住拒绝；即使调用者忘记 await，也由整个转场等待并传播错误。
    void promise.then(
      () => pending.delete(promise),
      (error) => {
        pending.delete(promise);
        fail(error);
      },
    );
    return promise;
  };
  const timing = (input: EffectTiming = {}) => ({
    duration: milliseconds(input.duration ?? context.durationMs),
    delay: milliseconds(input.delay ?? 0, "delay"),
    easing: input.easing ?? "cubic-bezier(0.2, 0.8, 0.2, 1)",
  });
  const window = environment.document?.defaultView;
  const scope: TransitionScope = {
    ...context,
    signal: abort.signal,
    document: environment.document,
    onCleanup: own,
    animate(target, frames, input) {
      active();
      const options = timing(input);
      if (!target || typeof target.animate !== "function" || !options.duration)
        return Promise.resolve();
      const animation = target.animate(frames, { ...options, fill: "both" });
      const completion = track(Promise.resolve(animation.finished).then(() => {}));
      own(() => animation.cancel());
      return completion;
    },
    frame(update, input) {
      active();
      const options = timing(input);
      if (!window?.requestAnimationFrame) {
        update(1);
        return Promise.resolve();
      }
      return track(
        new Promise<void>((resolve, reject) => {
          let frame = 0;
          const started = window.performance.now() + options.delay;
          own(() => {
            window.cancelAnimationFrame(frame);
            reject(new Interrupted("aborted"));
          });
          update(0);
          const tick = (now: number) => {
            if (closed) return;
            try {
              const progress = options.duration
                ? Math.min(1, Math.max(0, (now - started) / options.duration))
                : 1;
              update(progress);
              if (closed) return;
              if (progress === 1) resolve();
              else frame = window.requestAnimationFrame(tick);
            } catch (error) {
              reject(error);
            }
          };
          if (!closed) frame = window.requestAnimationFrame(tick);
        }),
      );
    },
    wait(duration) {
      active();
      milliseconds(duration);
      return track(
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, duration);
          own(() => {
            clearTimeout(timer);
            reject(new Interrupted("aborted"));
          });
        }),
      );
    },
    layer(component, props) {
      return track(
        (async () => {
          active();
          if (!environment.createLayer)
            throw new PageStackError(
              "INVALID_CONFIG",
              "This renderer does not provide transition layers.",
            );
          const lease = environment.createLayer(component, props, fail);
          own(() => lease.dispose());
          await settle(() => lease.ready, { signal: abort.signal, timeoutMs: 0, empty: undefined });
          active();
          return lease.element;
        })(),
      );
    },
    style(target, properties) {
      active();
      if (!target) return;
      let saved = originalStyles?.get(target);
      if (originalStyles && !saved) {
        saved = new Set();
        originalStyles.set(target, saved);
      }
      for (const [property, value] of Object.entries(properties)) {
        // 每个属性记一次基线，长手势逐帧写样式也只持有一份回收记录。
        if (!saved?.has(property)) {
          const previous = target.style.getPropertyValue(property);
          const priority = target.style.getPropertyPriority(property);
          own(() => {
            if (previous) target.style.setProperty(property, previous, priority);
            else target.style.removeProperty(property);
          });
          saved?.add(property);
        }
        target.style.setProperty(property, value);
      }
    },
    play(step) {
      active();
      if (!step.duration) return Promise.resolve();
      // 子步骤使用自己的默认时长，资源仍归整次编排所有，避免组合后被最长步骤拉长。
      const child: TransitionScope = {
        ...scope,
        durationMs: step.duration,
        animate: (target, frames, input) =>
          scope.animate(target, frames, { duration: step.duration, ...input }),
        frame: (update, input) => scope.frame(update, { duration: step.duration, ...input }),
      };
      return track(
        settle(() => step.run(child), {
          signal: abort.signal,
          timeoutMs: 0,
          empty: undefined,
        }).then(() => {
          active();
        }),
      );
    },
  };
  context.signal.addEventListener("abort", close, { once: true });
  if (context.signal.aborted) close();
  async function run(play: () => void | PromiseLike<void>): Promise<void> {
    try {
      await play();
      while (pending.size) await Promise.all([...pending]);
      active();
    } catch (error) {
      throw hasFailure ? failure : error;
    } finally {
      close();
      if (cleanupErrors.length && !hasFailure && !context.signal.aborted)
        throw new AggregateError(cleanupErrors, "Transition resources could not all be released.");
    }
  }
  return { scope, active, run, dispose: close };
}

export function runTransition(
  effect: TransitionEffect,
  context: TransitionContext,
  environment: TransitionEnvironment = {},
): Promise<void> {
  const lifetime = createTransitionScope(context, environment);
  return lifetime.run(() => lifetime.scope.play(effect));
}

/** 手势确认从最后一帧继续，普通导航从零播放，清理逻辑都由同一作用域承担。 */
export function createProgressPlayback(
  effect: ProgressTransition,
  context: TransitionContext,
  environment: TransitionEnvironment,
) {
  const lifetime = createTransitionScope(context, environment, true);
  const { scope } = lifetime;
  try {
    lifetime.active();
    const draw = effect.prepare({
      ...context,
      signal: scope.signal,
      document: scope.document,
      style: scope.style,
      layer: scope.layer,
      onCleanup: scope.onCleanup,
    });
    if (typeof draw !== "function")
      throw new PageStackError(
        "INVALID_CONFIG",
        "A progress transition must return a frame function.",
      );
    let position = 0;
    function seek(progress: number): void {
      lifetime.active();
      position = progress;
      draw(progress);
    }
    return {
      seek,
      settle(target: 0 | 1) {
        const start = position;
        const duration = Math.round(effect.duration * Math.abs(target - start));
        return lifetime.run(() =>
          duration
            ? scope.frame((progress) => seek(start + (target - start) * progress), { duration })
            : seek(target),
        );
      },
      dispose: lifetime.dispose,
    };
  } catch (cause) {
    lifetime.dispose();
    throw cause;
  }
}
