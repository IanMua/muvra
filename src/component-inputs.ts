import type { Component, ComponentPublicInstance, ExtractPublicPropTypes, PublicProps } from "vue";
import type { PageDefinition, PageKind, PageOptions } from "./types.js";

declare const lazyInputs: unique symbol;
interface UnknownInputs {
  readonly __pageStackUntypedComponent: "Use a typed component or withParams<P>()";
}
type IsAny<T> = 0 extends 1 & T ? true : false;
type PublicInputs<P> =
  IsAny<P> extends true
    ? UnknownInputs
    : string extends keyof P
      ? UnknownInputs
      : P extends unknown
        ? Omit<P, keyof PublicProps>
        : never;

/** 提取父级可传入的公开 props，保留默认值和 Boolean 的外部可选性，不读取组件内部解析值。 */
export type ComponentInputs<C> =
  IsAny<C> extends true
    ? UnknownInputs
    : Component extends C
      ? UnknownInputs
      : C extends { readonly [lazyInputs]: infer P }
        ? P
        : C extends abstract new (...args: any[]) => { $props: infer P }
          ? PublicInputs<P>
          : C extends (props: infer P, ...args: any[]) => any
            ? PublicInputs<P>
            : C extends { props: infer O }
              ? O extends readonly string[]
                ? { readonly [K in O[number]]?: unknown }
                : ExtractPublicPropTypes<O>
              : {};

/** 包装器仅承诺公开输入，避免冒充原实例方法，也避免把纯函数字段误当成运行时 props 构造器。 */
export type LazyPageComponent<C extends Component> = (new () => ComponentPublicInstance<
  ComponentInputs<C> & PublicProps
>) & {
  readonly [lazyInputs]: ComponentInputs<C>;
};
type TypedComponent<C> =
  ComponentInputs<C> extends UnknownInputs
    ? { readonly "PageStack: component props are erased; use withParams<P>()": never }
    : unknown;
// 完整保留公开输入的联合分支，不另设一份导航字段名单。
type RouteInputs<P> = P extends unknown
  ? keyof P extends never
    ? void
    : { [K in keyof P]: P[K] }
  : never;
type BaseOptions<K extends PageKind> = Omit<PageOptions, "cache"> &
  (K extends "popup" ? { readonly cache?: never } : Pick<PageOptions, "cache">);

/** 页面声明的全部公开 props 就是导航输入，保留原有必填、可选、可空和默认值语义。 */
export interface PageDefiner<K extends PageKind> {
  <const C extends Component>(
    component: C & TypedComponent<C>,
    options?: BaseOptions<K>,
  ): PageDefinition<K, RouteInputs<ComponentInputs<C>>>;
  /** 仅在没有可用组件类型或导航输入需要单独声明时使用，避免宽泛类型悄悄退化为 any。 */
  withParams<P = void>(): (component: Component, options?: BaseOptions<K>) => PageDefinition<K, P>;
}
