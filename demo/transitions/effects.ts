import type { Component } from "vue";
import { PageStackError, defineTransition } from "muvra";
import type { EffectTiming, TransitionEffect, TransitionScope } from "muvra";
export interface DissolveOptions extends Omit<EffectTiming, "easing"> {
  /** 噪声颗粒的频率，默认 0.035；保持纹理不变，仅改变阈值以避免闪烁。 */
  readonly frequency?: number;
  readonly seed?: number;
}
export interface GlowOptions extends EffectTiming {
  readonly color?: string;
}
export interface OverlayOptions extends EffectTiming {
  readonly props?: Readonly<Record<string, unknown>>;
}

// 演示自行验证时长，效果不依赖框架私有模块，也不进入框架导出。
function milliseconds(value: number, label = "duration") {
  if (!Number.isFinite(value) || value < 0 || value > 2_147_482_647)
    throw new PageStackError("INVALID_CONFIG", `Invalid ${label}.`);
  return value;
}

function settings(options: EffectTiming, duration: number) {
  const timing = {
    duration: milliseconds(options.duration ?? duration),
    delay: milliseconds(options.delay ?? 0, "delay"),
    easing: options.easing ?? "ease-in-out",
  };
  return { timing, total: timing.duration ? milliseconds(timing.duration + timing.delay) : 0 };
}
function returning(scope: TransitionScope): boolean {
  return scope.operation === "back" || scope.operation === "closePopup";
}
export function fade(options: EffectTiming = {}): TransitionEffect {
  const { timing, total } = settings(options, 280);
  return defineTransition({
    duration: total,
    run: async (scope) => {
      // 弹窗保留后面的页面；只淡入或淡出弹窗，避免背景在动画中短暂消失。
      const popup = scope.operation === "openPopup" || scope.operation === "closePopup";
      await Promise.all([
        scope.animate(
          popup && !returning(scope) ? undefined : scope.from,
          [{ opacity: 1 }, { opacity: 0 }],
          timing,
        ),
        scope.animate(
          popup && returning(scope) ? undefined : scope.to,
          [{ opacity: 0 }, { opacity: 1 }],
          timing,
        ),
      ]);
    },
  });
}

/** 噪声固定、阈值移动，真实 DOM 逐片出现或消失；无需截图页面，也不会冻结表单状态。 */
export function dissolve(options: DissolveOptions = {}): TransitionEffect {
  const { timing, total } = settings(options, 650);
  const frequency = options.frequency ?? 0.035;
  const seed = options.seed ?? 7;
  if (
    !Number.isFinite(frequency) ||
    frequency <= 0 ||
    frequency > 1 ||
    !Number.isSafeInteger(seed) ||
    seed < 0
  )
    throw new PageStackError(
      "INVALID_CONFIG",
      "Dissolve frequency must be in (0, 1] and seed a non-negative integer.",
    );
  return defineTransition({
    duration: total,
    run: async (scope) => {
      const target = returning(scope) ? scope.from : scope.to;
      const document = scope.document;
      if (!target || !document || !document.defaultView?.CSS?.supports("filter", "url(#effect)")) {
        await scope.play(fade(timing));
        return;
      }
      const layer = await scope.layer();
      layer.dataset.transitionEffect = "dissolve";
      const namespace = "http://www.w3.org/2000/svg";
      const node = (tag: string, attrs: Record<string, string> = {}) => {
        const element = document.createElementNS(namespace, tag);
        for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
        return element;
      };
      const id = `page-stack-dissolve-${document.defaultView.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
      const svg = node("svg", { width: "0", height: "0", "aria-hidden": "true" });
      const filter = node("filter", {
        id,
        x: "0%",
        y: "0%",
        width: "100%",
        height: "100%",
        "color-interpolation-filters": "sRGB",
      });
      filter.appendChild(
        node("feTurbulence", {
          type: "fractalNoise",
          baseFrequency: String(frequency),
          numOctaves: "2",
          seed: String(seed),
          result: "noise",
        }),
      );
      filter.appendChild(
        node("feColorMatrix", {
          in: "noise",
          type: "matrix",
          values: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .333 .333 .334 0 0",
          result: "alpha",
        }),
      );
      const transfer = node("feComponentTransfer", { in: "alpha", result: "cut" });
      const threshold = node("feFuncA", { type: "linear", slope: "12", intercept: "-12" });
      transfer.appendChild(threshold);
      filter.appendChild(transfer);
      filter.appendChild(node("feComposite", { in: "SourceGraphic", in2: "cut", operator: "in" }));
      svg.appendChild(filter);
      layer.appendChild(svg);
      const oldFilter = target.style.getPropertyValue("filter");
      // replace/reset 的旧页可能在上方；揭幕期间抬高目标容器，结束后恢复内核分配的层级。
      if (!returning(scope) && scope.from) {
        const fromZ = Number(scope.from.style.zIndex) || 0;
        const toZ = Number(target.style.zIndex) || 0;
        if (fromZ >= toZ) scope.style(target, { "z-index": String(fromZ + 1) });
      }
      scope.style(target, {
        filter: `${oldFilter && oldFilter !== "none" ? oldFilter + " " : ""}url("#${id}")`,
      });
      await scope.frame((progress) => {
        const reveal = returning(scope) ? 1 - progress : progress;
        threshold.setAttribute("intercept", String(reveal * 13 - 12));
      }, timing);
    },
  });
}

/** 光效是独立临时层，不改变页面不透明度，可与任何页面转场同时播放。 */
export function glow(options: GlowOptions = {}): TransitionEffect {
  const { timing, total } = settings(options, 600);
  const color = options.color ?? "#a5f3fc";
  return defineTransition({
    duration: total,
    run: async (scope) => {
      const layer = await scope.layer();
      layer.dataset.transitionEffect = "glow";
      scope.style(layer, {
        background: `radial-gradient(ellipse at 45% 50%, white 0%, ${color} 22%, transparent 68%)`,
        "mix-blend-mode": "screen",
      });
      await scope.animate(
        layer,
        [
          { opacity: 0, transform: "scale(.55) rotate(-12deg)", offset: 0 },
          { opacity: 0.9, transform: "scale(1.1) rotate(0deg)", offset: 0.45 },
          { opacity: 0, transform: "scale(1.55) rotate(12deg)", offset: 1 },
        ],
        timing,
      );
    },
  });
}

/** 自定义 Vue 特效层共享宿主上下文；动画结束、抛错或取消均自动卸载组件。 */
export function overlay(component: Component, options: OverlayOptions = {}): TransitionEffect {
  const { timing, total } = settings(options, 600);
  if (!component || !["object", "function"].includes(typeof component))
    throw new PageStackError("INVALID_CONFIG", "An overlay needs a Vue component.");
  const props = options.props ? Object.freeze({ ...options.props }) : undefined;
  return defineTransition({
    duration: total,
    run: async (scope) => {
      const layer = await scope.layer(component, props);
      layer.dataset.transitionEffect = "overlay";
      await scope.animate(
        layer,
        [
          { opacity: 0, offset: 0 },
          { opacity: 1, offset: 0.4 },
          { opacity: 0, offset: 1 },
        ],
        timing,
      );
    },
  });
}
