import type { InjectionKey, Ref } from "vue";
import type { ExtensionHost } from "./layers/extensions.js";
import type { InternalPage } from "./internal.js";
import type { PageStack, ResolvedRoute, StackSnapshot } from "./types.js";

/** 上下文只在渲染器和加载边界之间共享，公共页面只获得只读 Ref 和生命周期能力。 */
export interface PageInjection {
  stack: PageStack<any>;
  id: number;
  state: Readonly<Ref<StackSnapshot>>;
  initial: ResolvedRoute;
  record: InternalPage;
  extensions: ExtensionHost;
}
export const PageKey: InjectionKey<PageInjection> = Symbol("page-stack:page");
