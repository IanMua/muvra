import type { PageCatalog, PageNames, PageStack, ParamsOf, ResolvedRoute } from "./types.js";

/** 在异构快照中识别已知页面，同时为参数提供类型收窄；动态页继续保持 unknown。 */
export function isPage<C extends PageCatalog, N extends PageNames<C>>(
  stack: PageStack<C>,
  route: ResolvedRoute | undefined,
  name: N,
): route is ResolvedRoute & {
  readonly name: N;
  readonly kind: C[N]["kind"];
  readonly params: ParamsOf<C[N]>;
} {
  return (
    route?.name === name &&
    stack.catalog.some((entry) => entry.name === name && entry.kind === route.kind)
  );
}
