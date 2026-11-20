import type { VNodeChild } from "vue";

export type LayerStyle = Readonly<Record<string, string | number | undefined>>;
export type LayerStyleSource = LayerStyle | (() => LayerStyle);
export type LayerContent = () => VNodeChild;
/** 锚点只表达身份；扩展获得锚点后不能据此销毁页面。 */
export interface LayerAnchor {
  readonly id: number;
}
export interface LayerPlacement {
  readonly above?: LayerAnchor;
  readonly below?: LayerAnchor;
}
export interface LayerOptions {
  readonly content?: LayerContent;
  readonly style?: LayerStyleSource;
  readonly visible?: boolean;
  readonly interactive?: boolean;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly placement?: LayerPlacement;
  /** 所有权与显示顺序独立；拥有者隐藏或销毁时，附属层同步隐藏或销毁。 */
  readonly owner?: LayerAnchor;
  readonly group?: symbol;
  readonly onError?: (error: unknown) => void;
}
export interface LayerEntry {
  readonly anchor: LayerAnchor;
  readonly visible: boolean;
  readonly interactive: boolean;
  readonly zIndex: number;
  readonly style: LayerStyle;
  readonly attrs: Readonly<Record<string, unknown>>;
  readonly content: LayerContent | undefined;
  readonly group: symbol | undefined;
  readonly onError: ((error: unknown) => void) | undefined;
}
export interface LayerSnapshot {
  readonly revision: number;
  readonly disposed: boolean;
  readonly layers: readonly LayerEntry[];
}
export interface LayerStyles {
  /** 每份绑定占一个样式槽；移除时重算剩余样式，避免旧值覆盖其他扩展。 */
  bind(source: LayerStyleSource): () => void;
}
export interface LayerHandle {
  readonly anchor: LayerAnchor;
  readonly group: symbol | undefined;
  readonly signal: AbortSignal;
  readonly styles: LayerStyles;
  readonly element: HTMLElement | undefined;
  place(placement: LayerPlacement): void;
  update(options: Omit<LayerOptions, "placement" | "owner" | "group">): void;
  whenMounted(signal?: AbortSignal): Promise<HTMLElement>;
  /** 只拥有本图层创建的轨道；图层销毁时同步取消，迟到的 finished 拒绝会被消费。 */
  animate(frames: Keyframe[], timing?: KeyframeAnimationOptions): Promise<void>;
  dispose(): void;
}
export interface LayerLayout {
  /** 按实际显示顺序从下到上排列；可以按业务分组订阅基础层，排除装饰层。 */
  readonly visible: readonly LayerAnchor[];
}
export interface LayerStack {
  readonly signal: AbortSignal;
  create(options?: LayerOptions): LayerHandle;
  order(anchors: readonly LayerAnchor[]): void;
  batch<T>(run: () => T): T;
  getSnapshot(): LayerSnapshot;
  has(anchor: LayerAnchor): boolean;
  subscribe(listener: (snapshot: LayerSnapshot) => void): () => void;
  onLayout(listener: (layout: LayerLayout) => void, group?: symbol | null): () => void;
  getElement(anchor: LayerAnchor): HTMLElement | undefined;
  /** 渲染适配器通过同一公开租约登记 DOM；一个图层栈同时只接受一个视图。 */
  attachRenderer(): {
    bind(anchor: LayerAnchor, element: HTMLElement | undefined): void;
    dispose(): void;
  };
  dispose(): void;
}
