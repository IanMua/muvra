import type { Component } from "vue";
import type { TransitionContext } from "../types.js";

/** 编排只声明时长和播放逻辑；每次导航都会创建独立资源作用域，预设可以安全复用。 */
export interface TransitionEffect {
  readonly duration: number;
  readonly run: (scope: TransitionScope) => void | PromiseLike<void>;
}
/** 同一组画面既可以按时间播放，也可以由外部进度定位。prepare 每次转场只调用一次。 */
export interface ProgressTransition {
  readonly kind: "progress";
  readonly duration: number;
  readonly prepare: (scope: ProgressTransitionScope) => (progress: number) => void;
}
export interface EffectTiming {
  readonly duration?: number;
  readonly delay?: number;
  readonly easing?: string;
}
export interface TransitionScope extends TransitionContext {
  readonly document: Document | undefined;
  /** 所有动画句柄均归本次转场所有，完成或中止时只取消这些句柄。 */
  animate(target: Element | undefined, frames: Keyframe[], timing?: EffectTiming): Promise<void>;
  /** 帧回调用于噪声阈值等无法直接由关键帧表达的效果；进度包含 0 和 1。 */
  frame(update: (progress: number) => void, timing?: Omit<EffectTiming, "easing">): Promise<void>;
  wait(duration: number): Promise<void>;
  /** 临时层继承当前 Vue 宿主的依赖注入，不创建路由，也不加入页面历史。 */
  layer(component?: Component, props?: Readonly<Record<string, unknown>>): Promise<HTMLElement>;
  style(target: HTMLElement | undefined, properties: Readonly<Record<string, string>>): void;
  onCleanup(cleanup: () => void): void;
  play(effect: TransitionEffect): Promise<void>;
}
/** 进度的推进由框架管理，定义只获得画面和本次转场的资源。 */
export type ProgressTransitionScope = Pick<
  TransitionScope,
  keyof TransitionContext | "document" | "style" | "layer" | "onCleanup"
>;
/** 渲染器提供图层租约，动画模块不依赖 Vue 的组件树或导航内核。 */
export interface TransitionEnvironment {
  readonly document?: Document | undefined;
  createLayer?(
    component: Component | undefined,
    props: Readonly<Record<string, unknown>> | undefined,
    fail: (error: unknown) => void,
  ): { element: HTMLElement; ready: Promise<void>; dispose(): void };
  onCleanupError?(error: unknown): void;
}
