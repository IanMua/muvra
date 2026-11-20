import { of } from "rxjs";
import { h } from "vue";
import {
  createPageStack,
  definePages,
  page,
  tab,
  popup,
  usePage,
  isPage,
  lazy,
  PageStackView,
} from "../../dist/index.js";
const Component = { render: () => null };
const pages = definePages({
  home: tab(Component),
  order: page.withParams<{ orderId: string }>()(Component),
  optional: page.withParams<{ filter?: string }>()(Component),
  confirm: popup.withParams<{ onConfirm: () => void }>()(Component),
});
const stack = createPageStack({ pages, initial: [{ name: "home" }] });
h(PageStackView, { stack, transition: true });
page(lazy(async () => ({ default: Component })));
stack.push({ name: "order", params: { orderId: "1" } });
stack.push({ name: "optional" });
stack.openPopup({ name: "confirm", params: { onConfirm: () => {} } });
stack.switchTab({ name: "home" });
const readonlyRoutes = [{ name: "home" }, { name: "order", params: { orderId: "2" } }] as const;
stack.reset(readonlyRoutes);
for (const item of stack.catalog) {
  if (item.kind === "tab") stack.switchTab({ name: item.name });
}
const dynamic = page.withParams<{ id: number }>()(Component);
stack.pushDynamic(dynamic, { id: 7 });
stack.openDynamicPopup(popup.withParams<{ message: string }>()(Component), {
  message: "hello",
});
// @ts-expect-error 动态页面也必须提供必填参数。
stack.pushDynamic(dynamic);
// @ts-expect-error 动态页面参数类型需要匹配。
stack.pushDynamic(dynamic, { id: "bad" });
// @ts-expect-error 普通动态导航不能打开 popup 定义。
stack.pushDynamic(popup(Component));
// @ts-expect-error 全局守卫重定向名称也受本实例目录约束。
stack.beforeEach(() => ({ name: "typo" }));
const context = () => {
  const ctx = usePage(stack, "order");
  ctx.beforeBack(() => of(true));
  const signal: AbortSignal = ctx.signal;
  void signal;
  const id: string = ctx.params.value.orderId;
  // @ts-expect-error 参数由目录推断，不能将字符串当作数字。
  const invalid: number = ctx.params.value.orderId;
  return id;
};
// @ts-expect-error 页面名拼写错误。
stack.push({ name: "missing" });
// @ts-expect-error 订单页需要必填参数。
stack.push({ name: "order" });
// @ts-expect-error 参数类型错误。
stack.push({ name: "order", params: { orderId: 1 } });
// @ts-expect-error 普通导航不能打开弹窗。
stack.push({ name: "confirm", params: { onConfirm: () => {} } });
// @ts-expect-error Tab 只能由 switchTab 或 reset 使用。
stack.push({ name: "home" });
// @ts-expect-error switchTab 不能切换普通页。
stack.switchTab({ name: "order", params: { orderId: "1" } });
// @ts-expect-error openPopup 不能打开普通页。
stack.openPopup({ name: "order", params: { orderId: "1" } });
// @ts-expect-error reset 必须提供至少一个页面。
stack.reset([]);
// @ts-expect-error Tab 按名称唯一，不接受会被忽略的自定义 key。
stack.switchTab({ name: "home", key: "different" });
// @ts-expect-error popup 不能请求保留关闭后的实例。
popup(Component, { cache: true });
// @ts-expect-error 对外快照不可改写。
stack.getSnapshot().history.push({ name: "home" });
// @ts-expect-error 对外目录不可改写。
stack.catalog[0]!.name = "bad";
void context;
const current = stack.getSnapshot().current;
if (isPage(stack, current, "order")) {
  const id: string = current.params.orderId;
  void id;
}
