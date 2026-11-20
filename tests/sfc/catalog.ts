import { createPageStack, definePages, lazy, page, popup, tab } from "muvra";
import Home from "./pages/Home.vue";
import OrderDetail from "./pages/OrderDetail.vue";
import InputContract from "./pages/InputContract.vue";
import OrdersTab from "./pages/OrdersTab.vue";
import ConfirmPopup from "./pages/ConfirmPopup.vue";
import ScopedPage from "./pages/ScopedPage.vue";

// 公开 props 是唯一参数声明；同一目录用于类型检查、实际挂载和独立消费者验证。
export const pages = definePages({
  home: tab(Home),
  orderDetail: page(OrderDetail),
  contract: page(InputContract),
  lazy: page(lazy(() => import("./pages/LazyOrder.vue"))),
  orders: tab(OrdersTab),
  dialog: popup(ConfirmPopup),
  scoped: page(ScopedPage),
});
export const stack = createPageStack({
  pages,
  initial: [{ name: "home" }],
  transitionDurationMs: 0,
});
