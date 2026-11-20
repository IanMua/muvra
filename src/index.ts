// 只导出受支持的契约，内部队列、记录和可写集合不进入公共 API。
export { createPageStack } from "./engine.js";
export { definePages, page, tab, popup } from "./definitions.js";
export { PageStackError } from "./errors.js";
export { PageStackView, usePage, useStackState } from "./vue.js";
export { handleNativeBack } from "./native-back.js";
export { isPage } from "./selectors.js";
export { lazy } from "./lazy.js";
export { defineTransition, compose, sequence } from "./animation/effect.js";
export type { TransitionEffect, TransitionScope, EffectTiming } from "./animation/types.js";
export type { ErrorCode } from "./errors.js";
export type { ComponentInputs, LazyPageComponent, PageDefiner } from "./component-inputs.js";
export type {
  CatalogEntry,
  Diagnostic,
  DynamicArguments,
  GuardContext,
  GuardDecision,
  GuardReturn,
  LeaveGuard,
  NativeBackDecision,
  NavigationGuard,
  NavigationOptions,
  NavigationResult,
  ObservableLike,
  Operation,
  PageCatalog,
  PageContext,
  PageDefinition,
  PageKind,
  PageNames,
  PageOptions,
  PageStack,
  ParamsOf,
  RenderedPage,
  ResolvedRoute,
  Route,
  RouteInput,
  StackOptions,
  StackSnapshot,
  TransitionContext,
  TransitionDriver,
  TransitionOutcome,
} from "./types.js";

// 图层和扩展是独立公开基础，导航及可选视觉扩展都使用这些能力。
export { createLayerStack, LayerError } from "./layers/stack.js";
export { LayerStackView } from "./layers/vue.js";
export { createResourceScope } from "./layers/resources.js";
export type { Cleanup } from "./layers/resources.js";
export { defineExtension, createExtensionHost } from "./layers/extensions.js";
export type { ExtensionContext, ExtensionDefinition, ExtensionHost } from "./layers/extensions.js";
export type {
  LayerAnchor,
  LayerContent,
  LayerEntry,
  LayerHandle,
  LayerLayout,
  LayerOptions,
  LayerPlacement,
  LayerSnapshot,
  LayerStack,
  LayerStyle,
  LayerStyleSource,
  LayerStyles,
} from "./layers/types.js";
