import type { TransitionContext } from "muvra";

/** 演示转场只管理自身创建的动画，结束、中止或部分启动失败时都释放 fill 效果。 */
export async function waapiTransition(context: TransitionContext): Promise<void> {
  const { operation, from, to, durationMs, signal } = context;
  if (signal.aborted) throw new DOMException("Transition aborted.", "AbortError");
  if (durationMs <= 0) return;
  const animations: Animation[] = [];
  const completions: Promise<Animation>[] = [];
  const cancel = () => {
    for (const animation of animations) {
      // 某条外部动画句柄清理失败时，仍需清理剩余轨道；最终导航由内核保证收敛。
      try {
        animation.cancel();
      } catch {
        /* 原生 cancel 无异常返回，兼容外部垫片。 */
      }
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  const start = (element: HTMLElement | undefined, keyframes: Keyframe[]) => {
    if (!element || typeof element.animate !== "function") return;
    const animation = element.animate(keyframes, {
      duration: durationMs,
      fill: "both",
      easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    });
    animations.push(animation);
    // 后一条轨道启动可能抛错，因此在创建当下就处理可能迟到的拒绝。
    void animation.finished.catch(() => {});
    completions.push(animation.finished);
  };
  try {
    if (operation === "push") {
      start(from, [{ transform: "translateX(0)" }, { transform: "translateX(-12%)" }]);
      start(to, [{ transform: "translateX(100%)" }, { transform: "translateX(0)" }]);
    } else if (operation === "back") {
      start(from, [{ transform: "translateX(0)" }, { transform: "translateX(100%)" }]);
      start(to, [{ transform: "translateX(-12%)" }, { transform: "translateX(0)" }]);
    } else if (operation === "openPopup") {
      start(from, [{ transform: "scale(1)" }, { transform: "scale(.995)" }]);
      start(to, [
        { transform: "translateY(12%)", opacity: 0 },
        { transform: "translateY(0)", opacity: 1 },
      ]);
    } else if (operation === "closePopup") {
      start(from, [
        { transform: "translateY(0)", opacity: 1 },
        { transform: "translateY(12%)", opacity: 0 },
      ]);
      start(to, [{ transform: "scale(.995)" }, { transform: "scale(1)" }]);
    } else {
      start(from, [{ opacity: 1 }, { opacity: 0 }]);
      start(to, [{ opacity: 0 }, { opacity: 1 }]);
    }
    await Promise.all(completions);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
