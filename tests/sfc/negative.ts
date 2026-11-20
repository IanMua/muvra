import { page } from "muvra";
import OrderDetail from "./pages/OrderDetail.vue";
import { stack } from "./catalog";

// 每项反例必须产生真实诊断，包含可空与可省略的区别以及被移除的旧配置。
// EXPECT_ERROR: required-order-no
stack.push({ name: "orderDetail" });
// EXPECT_ERROR: order-no-type
stack.push({ name: "orderDetail", params: { orderNo: 42 } });
// EXPECT_ERROR: lazy-required-note
stack.push({ name: "lazy", params: { orderNo: "1" } });
// EXPECT_ERROR: literal-union
stack.push({ name: "lazy", params: { orderNo: "1", note: null, section: "unknown" } });
// EXPECT_ERROR: nullable-still-required
stack.push({ name: "contract", params: { orderNo: "1" } });
// EXPECT_ERROR: builtin-attributes
stack.push({ name: "orderDetail", params: { orderNo: "1", class: "root" } });
// EXPECT_ERROR: callback-payload
stack.openPopup({
  name: "dialog",
  params: { message: "Confirm", onConfirm: (value: string) => value.toUpperCase() },
});
// EXPECT_ERROR: removed-selection
page(OrderDetail, { params: ["orderNo"] });
// EXPECT_ERROR: tab-required
stack.switchTab({ name: "orders" });
// EXPECT_ERROR: nullable-wrong-type
stack.push({ name: "contract", params: { orderNo: "1", note: 42 } });
// EXPECT_ERROR: nullable-is-not-undefined
stack.push({ name: "contract", params: { orderNo: "1", note: undefined } });
// EXPECT_ERROR: extra-order-property
stack.push({ name: "orderDetail", params: { orderNo: "1", tenantId: "unneeded" } });
