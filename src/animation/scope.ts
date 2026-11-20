import { createResourceScope } from "../layers/resources.js";
import { settle } from "../async.js";
import { Interrupted, PageStackError } from "../errors.js";
import type { TransitionContext } from "../types.js";
import { milliseconds } from "./effect.js";
import type {
  EffectTiming,
  TransitionEffect,
  TransitionEnvironment,
  TransitionScope,
} from "./types.js";

/** 一次播放只拥有自己的资源；中止同步清理，迟到的业务 Promise 仍被消费且不能再申请资源。 */
export async function runTransition(
  effect: TransitionEffect,
  context: TransitionContext,
  environment: TransitionEnvironment = {},
): Promise<void> {
  const abort = new AbortController();
  const cleanupErrors: unknown[] = [];
  const resources = createResourceScope((error) => {
    cleanupErrors.push(error);
    // 清理 Promise 可能在播放结束后才拒绝，诊断必须跟随每次失败即时送出。
    environment.onCleanupError?.(error);
  });
  const pending = new Set<Promise<unknown>>();
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
      for (const [property, value] of Object.entries(properties)) {
        const previous = target.style.getPropertyValue(property);
        const priority = target.style.getPropertyPriority(property);
        own(() => {
          if (previous) target.style.setProperty(property, previous, priority);
          else target.style.removeProperty(property);
        });
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
  try {
    await scope.play(effect);
    while (pending.size) await Promise.all([...pending]);
    active();
  } catch (error) {
    throw hasFailure ? failure : error;
  } finally {
    context.signal.removeEventListener("abort", close);
    close();
    if (cleanupErrors.length && !hasFailure && !context.signal.aborted)
      throw new AggregateError(cleanupErrors, "Transition resources could not all be released.");
  }
}
