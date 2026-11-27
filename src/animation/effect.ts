import { PageStackError } from "../errors.js";
import type { Operation, PageOptions } from "../types.js";
import type { ProgressTransition, TransitionEffect } from "./types.js";

/** 为自动截止时间保留 1000ms 余量，防止浏览器定时器溢出后立即超时。 */
export function milliseconds(value: number, name = "duration"): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_482_647)
    throw new PageStackError(
      "INVALID_CONFIG",
      `${name} must be an integer between 0 and 2147482647.`,
    );
  return value;
}
export function isTransitionEffect(value: unknown): value is TransitionEffect {
  return (
    !!value &&
    typeof value === "object" &&
    "duration" in value &&
    typeof value.duration === "number" &&
    "run" in value &&
    typeof value.run === "function"
  );
}
export function isProgressTransition(value: unknown): value is ProgressTransition {
  return (
    !!value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "progress" &&
    "duration" in value &&
    typeof value.duration === "number" &&
    "prepare" in value &&
    typeof value.prepare === "function"
  );
}
export function validTransition(value: unknown): boolean {
  return (
    value === undefined ||
    value === false ||
    typeof value === "function" ||
    ((isTransitionEffect(value) || isProgressTransition(value)) &&
      Number.isSafeInteger(value.duration) &&
      value.duration >= 0 &&
      value.duration <= 2_147_482_647)
  );
}

/** 预设的声明可共享，DOM、计时器与动画句柄始终留在每次播放的作用域中。 */
export function defineTransition(effect: TransitionEffect): TransitionEffect {
  if (!isTransitionEffect(effect))
    throw new PageStackError("INVALID_CONFIG", "A transition needs a duration and run function.");
  return Object.freeze({ duration: milliseconds(effect.duration), run: effect.run });
}

/** 前进由进入页决定，返回及关闭弹窗由离开页决定，保持进入与退出效果配套。 */
export function selectTransition(
  operation: Operation,
  from: PageOptions["transition"],
  to: PageOptions["transition"],
  fallback: NonNullable<PageOptions["transition"]>,
): NonNullable<PageOptions["transition"]> {
  return operation === "back" || operation === "closePopup"
    ? (from ?? to ?? fallback)
    : (to ?? from ?? fallback);
}

/** compose 同时启动，sequence 按声明顺序等待；嵌套编排继续使用同一个资源作用域。 */
export function compose(...effects: readonly TransitionEffect[]): TransitionEffect {
  const steps = effects.map(defineTransition);
  return defineTransition({
    duration: Math.max(0, ...steps.map((effect) => effect.duration)),
    run: async (scope) => {
      await Promise.all(steps.map((effect) => scope.play(effect)));
    },
  });
}
export function sequence(...effects: readonly TransitionEffect[]): TransitionEffect {
  const steps = effects.map(defineTransition);
  return defineTransition({
    duration: milliseconds(steps.reduce((total, effect) => total + effect.duration, 0)),
    run: async (scope) => {
      for (const effect of steps) await scope.play(effect);
    },
  });
}
