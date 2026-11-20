import { h } from "vue";
import { lazy, page, popup, usePage } from "muvra";
import OrderDetail from "./pages/OrderDetail.vue";
import ConfirmPopup from "./pages/ConfirmPopup.vue";
import { stack } from "./catalog";

// 所有公开 props 自动成为导航输入；可选、默认值与可空语义都来自真实页面。
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
stack.push({ name: "lazy", params: { orderNo: "1", note: null, section: "refund" } });
stack.switchTab({ name: "orders", params: { customerId: "customer" } });
stack.openPopup({
  name: "dialog",
  params: { message: "Confirm", onConfirm: (value) => value.valueOf() },
});
stack.pushDynamic(page(OrderDetail), { orderNo: "2" });
stack.openDynamicPopup(popup(lazy(() => import("./pages/ConfirmPopup.vue"))), {
  message: "Lazy popup",
  onConfirm: (value) => value.valueOf(),
});
h(
  lazy(() => import("./pages/OrderDetail.vue")),
  { orderNo: "1" },
);
function context() {
  const current = usePage(stack, "lazy");
  const orderNo: string = current.params.value.orderNo;
  const note: string | null = current.params.value.note;
  const section: "detail" | "refund" | undefined = current.params.value.section;
  const caption: string | undefined = current.params.value.caption;
  return { orderNo, note, section, caption };
}
// @ts-expect-error 字段选择配置已移除，目录不能重复声明页面输入。
page(OrderDetail, { params: ["orderNo"] });
// @ts-expect-error popup 的真实 SFC 回调必填。
stack.openDynamicPopup(popup(ConfirmPopup), { message: "missing callback" });
void context;
