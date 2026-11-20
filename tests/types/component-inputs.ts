import { defineAsyncComponent, defineComponent, h } from "vue";
import type { Component, FunctionalComponent, PropType } from "vue";
import { createPageStack, definePages, page, popup, tab, lazy, usePage } from "../../dist/index.js";

const Order = defineComponent({ props: { orderNo: { type: String, required: true } } });
const Contract = defineComponent({
  props: {
    orderNo: { type: String, required: true },
    note: { type: [String, null] as PropType<string | null>, required: true },
    section: { type: String as PropType<"detail" | "refund">, default: "detail" },
    compact: Boolean,
    caption: String,
    onConfirm: Function as PropType<(orderNo: string) => void>,
  },
  emits: { close: (_orderNo: string) => true },
});
const Optional = defineComponent({ props: { filter: String } });
const CallbackOnly = defineComponent({
  props: { onConfirm: { type: Function as PropType<() => void>, required: true } },
});
const LazyCallbackOnly = lazy(async () => CallbackOnly);
h(LazyCallbackOnly, { onConfirm: () => {} });
const callbackInput: InstanceType<typeof LazyCallbackOnly>["$props"]["onConfirm"] = () => {};
const callbackFunction: () => void = callbackInput;
void callbackFunction;
const FunctionPage: FunctionalComponent<{ id: number; optional?: boolean }> = () => h("p");
const UnionPage: FunctionalComponent<
  { kind: "id"; id: string } | { kind: "slug"; slug: string }
> = () => h("p");
const pages = definePages({
  root: tab({ render: () => null }),
  orderDetail: page(Order),
  contract: page(Contract),
  optional: page(Optional),
  functional: page(FunctionPage),
  union: page(UnionPage),
  inline: page({ props: { id: { type: String, required: true } }, render: () => null }),
  lazy: page(lazy(async () => ({ default: Contract }))),
  nativeAsync: page(defineAsyncComponent(async () => Order)),
  dialog: popup(Order),
  orderTab: tab(Order),
});
const stack = createPageStack({ pages, initial: [{ name: "root" }] });
// 页面公开 props 是唯一输入契约，目录不再维护字段名单。
stack.push({ name: "orderDetail", params: { orderNo: "1" } });
stack.push({ name: "contract", params: { orderNo: "1", note: null } });
stack.push({
  name: "contract",
  params: {
    orderNo: "1",
    note: "text",
    caption: "route",
    onConfirm: (orderNo) => orderNo.toUpperCase(),
    onClose: (orderNo) => orderNo.toUpperCase(),
  },
});
stack.push({ name: "optional" });
stack.push({ name: "functional", params: { id: 1 } });
stack.push({ name: "union", params: { kind: "id", id: "1" } });
stack.push({ name: "union", params: { kind: "slug", slug: "order" } });
stack.push({ name: "inline", params: { id: "1" } });
stack.push({ name: "lazy", params: { orderNo: "1", note: null } });
stack.push({ name: "nativeAsync", params: { orderNo: "1" } });
stack.switchTab({ name: "orderTab", params: { orderNo: "1" } });
stack.openPopup({ name: "dialog", params: { orderNo: "1" } });
stack.pushDynamic(page(Order), { orderNo: "1" });
stack.openDynamicPopup(popup(lazy(async () => Order)), { orderNo: "1" });
// @ts-expect-error 判别联合仍保留当前分支的必填项。
stack.push({ name: "union", params: { kind: "id" } });
// @ts-expect-error 另一分支的字段不能替代当前分支必填项。
stack.push({ name: "union", params: { kind: "id", slug: "order" } });
// @ts-expect-error 订单详情必填 orderNo。
stack.push({ name: "orderDetail" });
// @ts-expect-error 参数类型来自页面声明。
stack.push({ name: "orderDetail", params: { orderNo: 1 } });
// @ts-expect-error 可空不代表可以省略字段。
stack.push({ name: "contract", params: { orderNo: "1" } });
// @ts-expect-error 允许 null 不等于允许 undefined。
stack.push({ name: "contract", params: { orderNo: "1", note: undefined } });
// @ts-expect-error 可空字段仍然检查非空值类型。
stack.push({ name: "contract", params: { orderNo: "1", note: 1 } });
// @ts-expect-error 字面量联合不接受其他值。
stack.push({ name: "lazy", params: { orderNo: "1", note: null, section: "missing" } });
// @ts-expect-error Vue 内置 class 不属于页面业务输入。
stack.push({ name: "orderDetail", params: { orderNo: "1", class: "root" } });
// @ts-expect-error Vue ref 不属于页面业务输入。
stack.push({ name: "orderDetail", params: { orderNo: "1", ref: "node" } });
// @ts-expect-error key 是路由身份，不混入业务 props。
stack.push({ name: "orderDetail", params: { orderNo: "1", key: "node" } });
// @ts-expect-error 字段选择配置已移除。
page(Order, { params: ["orderNo"] });
// @ts-expect-error popup 不接受缓存配置。
popup(Order, { cache: true });
// @ts-expect-error 函数页面的参数仍有类型约束。
stack.push({ name: "functional", params: { id: "wrong" } });
// @ts-expect-error 内联组件仍保留 required。
stack.push({ name: "inline" });
// @ts-expect-error 懒加载不能省略必填可空字段。
stack.push({ name: "lazy", params: { orderNo: "1" } });
// @ts-expect-error Vue 原生异步包装器保留必填参数。
stack.push({ name: "nativeAsync" });
// @ts-expect-error 旧泛型入口只用于迁移到 withParams。
page<{ id: string }>({ render: () => null });
const erased = Order as Component;
// @ts-expect-error 类型已擦除时要求显式声明，不能悄悄退化为 any。
page(erased);
const explicit = page.withParams<{ id: string }>()(erased);
stack.pushDynamic(explicit, { id: "1" });
// @ts-expect-error 显式入口保留必填约束。
stack.pushDynamic(explicit);
function context() {
  const current = usePage(stack, "contract");
  const orderNo: string = current.params.value.orderNo;
  const note: string | null = current.params.value.note;
  const section: "detail" | "refund" | undefined = current.params.value.section;
  const caption: string | undefined = current.params.value.caption;
  // @ts-expect-error Vue 默认值不会让原始导航输入变成已解析值。
  const resolved: "detail" | "refund" = current.params.value.section;
  return { orderNo, note, section, caption, resolved };
}
void context;
