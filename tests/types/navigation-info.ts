import { createPageStack, definePages, page, tab, usePage } from "../../dist/index.js";
import type {
  BeforeNavigate,
  NavigationEvent,
  NavigationRequest,
  NavigationResult,
} from "../../dist/index.js";

// info 保持不透明，页面参数仍由组件推导；读取业务字段须由业务自己收窄。
const pages = definePages({
  home: tab({ render: () => null }),
  detail: page.withParams<{ id: string }>()({ render: () => null }),
});
const prepare: BeforeNavigate = async (navigation) => {
  const info: unknown = navigation.info;
  const signal: AbortSignal = navigation.signal;
  const resumedFrom: number | undefined = navigation.resumedFromId;
  void signal;
  void resumedFrom;
  // @ts-expect-error 框架不推测业务附加数据结构。
  navigation.info.source;
  return { info };
};
const stack = createPageStack({
  pages,
  beforeNavigate: prepare,
  onNavigation(event) {
    const request: NavigationRequest = event;
    if (event.type === "settled") {
      const result: NavigationResult = event.result;
      const info: unknown = result.info;
      void info;
    }
    // @ts-expect-error 观察者不能改写框架字段。
    request.info = {};
  },
});
stack.beforeEach(({ info }) => {
  const arbitrary: unknown = info;
  void arbitrary;
});
stack.push({ name: "detail", params: { id: "1" } }, { info: { anything: () => 1 } });
stack.resume({ info: undefined });
stack.beforeNavigate(() => false);
// @ts-expect-error 前置处理不接受路由重定向，重定向由页面守卫负责。
stack.beforeNavigate(() => ({ name: "home" }));
// @ts-expect-error 前置结果只能替换 info，不修改参数。
stack.beforeNavigate(() => ({ params: {} }));
// @ts-expect-error 新选项没有改变必填参数。
stack.push({ name: "detail" }, { info: {} });
const event = {} as NavigationEvent;
if (event.type === "requested") {
  // @ts-expect-error 请求产生时尚无结果。
  event.result;
}
const ctx = () => {
  const value: string = usePage(stack, "detail").params.value.id;
  return value;
};
void ctx;
