# Muvra

面向 Vue 应用的页面栈导航框架，管理页面状态、叠加显示和转场生命周期；图层也是可独立使用的公开基础能力。当前版本为 `0.1.0-alpha.0`，采用 MIT 许可证，尚未发布。

## 定位

ESM 包，面向 Vue 3 App / WebView 的内存页面容器：普通页、Tab、弹窗、逻辑历史、实例缓存、进入/离开/返回守卫、完整拦截恢复、可中止动画。每个实例独立，不使用全局页面注册、全局可写历史或全局队列。

URL / 浏览器 History、持久化、原生平台桥接和业务权限规则由宿主适配。路由参数可以包含 Ref、响应式对象和函数，因此它们不是可直接序列化到 URL 的数据。应用退出由宿主处理。

## 最小接入

在 OrderDetail.vue 中声明导航输入一次：

```vue
<script setup lang="ts">
// 页面公开 props 是参数契约，目录和导航调用自动复用。
const props = defineProps<{ orderNo: string }>();
</script>
<template>
  <p>{{ props.orderNo }}</p>
</template>
```

```ts
import { createPageStack, definePages, page, tab, popup } from "muvra";
import Home from "./Home.vue";
import OrderDetail from "./OrderDetail.vue";
import Confirm from "./Confirm.vue";

const pages = definePages({
  home: tab(Home),
  orderDetail: page(OrderDetail),
  confirm: popup(Confirm),
});

export const stack = createPageStack({ pages, initial: [{ name: "home" }] });
const initial = await stack.ready;
if (initial.status === "failed") reportError(initial.error);
await stack.push({ name: "orderDetail", params: { orderNo: "42" } });
```

```vue
<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { PageStackView } from "muvra";
import { stack } from "./navigation";
onBeforeUnmount(() => stack.dispose());
</script>

<template>
  <div style="height: 100vh">
    <PageStackView :stack="stack">
      <template #loading>正在加载页面…</template>
      <template #error="{ retry }">
        <p>页面暂时无法显示。</p>
        <button @click="retry">重试</button>
      </template>
    </PageStackView>
  </div>
</template>
```

`initial` 同样执行守卫，初始化结果通过 `ready` 获取。每个实例至多挂载一个 `PageStackView`，多个页面容器应使用多个实例。切换 `stack` prop 会解绑旧实例并建立新绑定。卸载视图保留逻辑历史，但 Vue 组件本身会卸载；重新挂载会创建新的组件生命周期。结束整个导航会话时调用 `dispose()`。

## 页面 props 是导航输入契约

`page(Component)`、`tab(Component)`、`popup(Component)` 直接推导组件声明的全部公开业务 props。参数只在页面声明一次，目录不再选择或重复列出字段。真实 SFC、defineComponent、函数组件、内联运行时 props 和懒加载均保留同一契约。

| 页面声明                | 导航输入                                     |
| ----------------------- | -------------------------------------------- |
| `value: string`         | 必须传 string                                |
| `value?: string`        | 可以省略                                     |
| `value: string \| null` | 必须传字段，可以传 null                      |
| 有默认值的公开 prop     | 遵循 Vue 的公开输入可选性，默认值由 Vue 解析 |

可空不等于可省略：`string | null` 不能缺失或传 undefined。字面量联合、回调和 emits 监听也保留原来的类型。Vue 的 key/ref/class/style 和 VNode 钩子属于框架控制属性，不混入导航业务输入。

`PageStackView.pageProps` 继续透传共用值，路由参数仍优先。它不会改变导航输入的类型或让必填 prop 自动变成可选。页面确实允许省略的字段应在页面声明为可选；必须提供的字段保持必填。

组件 props 是 Vue 解析后的值，`usePage().params` 是原始导航输入；Vue 默认值和仅由 pageProps 提供的值不会被写进原始导航参数。

组件类型已被 any、宽泛 Component 或旧的 \*.vue shim 擦除时，应恢复具体组件类型，或在特殊兼容场景显式声明：

```ts
const legacy = page.withParams<{ orderNo: string }>()(UntypedComponent);
```

三个 helper 均支持 withParams。正常页面使用 `page(Component)` 即可。只有组件内部的 usePage<T>() 不会向目录导出 T；真实 SFC 使用 vue-tsc 检查，不能靠泛化的 \*.vue 声明伪造推导结果。

## 页面中的上下文

```ts
import { usePage } from "muvra";
import { stack } from "./navigation";

const page = usePage(stack, "orderDetail");
// page.params.value.orderNo 自动推断为 string，缓存页面参数更新也会反映到此 Ref。
page.beforeLeave(({ signal }) => confirmLeave(signal));
page.beforeBack(({ reason, delta }) => canGoBack(reason, delta));
page.onShow(() => refreshData());
page.onHide(() => pauseVisibleWork());
page.onUnload(() => stopSubscriptions());
```

`page.signal` 在组件卸载或内核回收时中止，可直接传入 fetch 等异步请求。

生命周期和守卫注册方法必须在 Vue setup / 组件作用域内调用，返回值可手动注销，组件卸载也会自动释放。`onUnload` 在内核回收或实际组件卸载时执行一次，重试组件及卸载视图也包含在内。普通清理回调可以返回 Promise；框架消费其拒绝并上报诊断，但不阻塞导航。需要等待并允许拒绝离开的工作应写在守卫中。

`visible` 与 `focused` 分开：弹窗下面的页面仍可见，但只有顶部页面接收交互。全局业务服务可以用 `stack.subscribe`；Vue 组件或 `effectScope` 内可用自动退订的 `useStackState(stack)`。不需要导入目录实例的组件也可使用 `usePage<Params>()`，此形式的参数类型由调用者声明。

对象参数作为 props 透传，路由参数优先于 `pageProps`。参数不会被 JSON 克隆；业务需要响应性时传入 Ref / reactive 对象。Vue 专用的 `key` / `ref` 不作为组件业务 props 使用，此类业务字段通过 `page.params` 读取。异步组件和异步 setup 有加载占位；页面内部仍须遵守 Vue 对异步 setup 中生命周期注册时机的规则。

## 导航结果

导航命令统一返回 Promise，预期拒绝或运行错误不会变成未处理的 Promise 拒绝：

| status      | 含义                                                                          |
| ----------- | ----------------------------------------------------------------------------- |
| `completed` | 导航已提交且最终状态已同步；`transition` 说明动画完成、跳过、失败、超时或中止 |
| `cancelled` | 未提交；`reason` 为 guard / aborted / disposed / busy                         |
| `noop`      | 没有可执行操作；root / empty / same / not-intercepted                         |
| `failed`    | 带 `PageStackError.code` 和 `cause`，原状态保持完整                           |

创建及回调注册时的非法配置同步抛出 `PageStackError`。动画开始前导航已经提交，之后的动画错误、超时和中止会降级为完成导航，并通过 `onError` 上报警告。整个实例销毁则取消所有任务并清空实例资源。

```ts
const result = await stack.push({ name: "orderDetail", params: { orderNo: "42" } });
if (result.status === "failed") console.error(result.error.code, result.error.cause);
if (result.status === "completed" && result.transition === "timed-out") recordSlowAnimation();
```

## 守卫、并发和中止

入口顺序是每个目标的全局守卫、页面 `beforeEnter`；重定向重新执行完整入口检查。reset 的所有目标都会检查。入口收敛后检查真正离开的页面，最后才提交导航。back / closePopup 也重新检查将被揭示的目标。

- 进入守卫返回 `void / true` 放行、`false` 取消、路由对象重定向；离开/返回守卫只允许 `void / boolean`。
- 支持 PromiseLike 和 ObservableLike。采用首个值；`undefined` 和空完成都放行。源错误是 `failed`，不会悄悄变成允许返回。
- 同步通知、异步通知、空完成、源错误、中止、超时都会释放取得的订阅句柄。句柄可以是函数或 `{ unsubscribe() }`。
- 检查期间的新导航返回 `cancelled: busy`；同步从守卫启动嵌套导航返回 `REENTRANT_NAVIGATION`。重定向应返回路由，不要等待自己的导航队列。
- 同一轮同时提交的命令及动画期间提交的命令按 FIFO 排队，队列有容量上限。
- 命令接受 `AbortSignal`，排队任务可独立中止；`stack.cancel()` 中止当前任务。检查超时会通知其 signal；转场超时会中止驱动并完成最终同步。

## 导航附加信息与全局扩展点

页面输入使用 `params`，页面静态声明使用 `meta`；每次导航的业务附加信息使用 `info`。`info` 类型为 unknown，字段和校验由业务决定；框架按引用传递，不序列化、不深拷贝、不深冻结，也不将它写入页面 props、页面身份、缓存 key 或历史条目。入队时固定该引用，业务自行管理对象内部的修改。

```ts
// 业务先解析外部输入；导航层只接收已确定的页面目标和附加信息。
await stack.push({ name: "orderDetail", params: { orderNo: "123" } }, { info: businessInfo });
```

`beforeNavigate` 在每次实际执行时按注册顺序运行一次，早于所有页面守卫。reset 的多个目标和同次执行内的重定向不会重复执行前置处理；resume 是新执行，会再次处理。支持同步、PromiseLike 和 ObservableLike 首值，复用 guardTimeoutMs、中止及清理规则。返回 void/true 放行，false 取消，`{ info }` 整份替换附加信息；重定向仍通过页面守卫返回路由。不能在处理函数中等待自己发起的嵌套导航。

```ts
const removePreparation = stack.beforeNavigate(async (navigation) => {
  // 业务自行判断是否需要准备，并通过返回值显式替换 info。
  if (!isBusinessInfo(navigation.info)) return;
  return { info: await prepareBusiness(navigation.info, navigation.signal) };
});

stack.beforeEach(({ to, info }) => {
  // 全局、页面进入、离开和返回守卫均可读取本次执行的有效 info。
  return checkBusinessAccess(to, info);
});

const stopObserving = stack.onNavigation((event) => {
  // requested 是请求产生，settled 是唯一结果；埋点的字段和成功口径由业务决定。
  recordBusinessEvent(event);
});
```

注册函数返回撤销函数。也可通过 createPageStack 的 `beforeNavigate`、`onNavigation` 配置在初始化之前安装。需要为首次导航提供 info 时，可以不配置 initial，注册扩展点后使用 `reset(initialRoutes, { info })`；空 ready 不产生导航事件。

NavigationRequest 提供 id、operation、reason、info、resumedFromId 和可选的 route/routes/delta。目标尚未经过页面校验，观察者不能据此假设输入有效；目标描述保持原请求，不随重定向改写。BeforeNavigateContext 额外提供执行开始时的 from 和本次 signal。最终页面从 settled.result.state 读取，不能把跳到承接页算成原目标已展示。

每个存活实例收到的导航请求产生一次 requested 和一次 settled，事件外壳只读。requested.info 是调用时的值，settled.info/result.info 是前置处理后的有效值。busy、非法输入、排队取消、无操作和失败均有终态；未执行的请求不运行前置处理。事件按发生顺序同步通知，但不等待观察者返回的 Promise；同步异常及异步拒绝按原导航 ID 报告 SUBSCRIBER_ERROR，不改变导航结果。

销毁时活动及排队请求先各自产生 disposed 终态，再释放订阅；销毁后的调用仅返回 disposed 结果，不再广播。观察者返回值没有控制语义；info 中的业务对象仍按引用提供，业务不得依赖修改观察事件来控制导航。

普通调用省略 info 时为空，不继承上一导航。恢复调用省略 info 时继承原拦截保存的有效值；显式 `resume({ info: next })` 整份替换，`resume({ info: undefined })` 清空，均不自动合并。恢复使用新的执行 ID，resumedFromId 指向被恢复的那次执行；原信号不复用，守卫重新执行。取消或失败且未提交时保留原拦截；成功提交后消费旧拦截，即使承接页被缓存也解除引用。恢复在调用时绑定拦截及页面作用域，排队期间失效则返回 not-intercepted，不恢复另一份请求。

页面曝光可根据已有的可见性、焦点及状态订阅定义；导航结果不等于业务数据加载成功。业务 URL 解析、分享记录、外部事件投递与重试策略仍由宿主负责。

## 登录拦截恢复

```ts
stack.beforeEach(({ to }) => {
  if (to?.meta.needLogin && !loggedIn.value) return { name: "login" };
});

// 登录页 setup 中取得上下文，异步登录成功后仍可使用。
const login = usePage(stack, "login");
async function afterLogin() {
  if (login.isIntercepted.value) return login.resume();
  return stack.back();
}
```

框架保存原始操作、完整 reset 数组、参数、key 和原历史。恢复会移除承接拦截的页面，再按原始 push / replace / switchTab / reset / popup 意图重新检查和执行。再次拒绝或报错时保留当前登录页。卸载后的旧页面上下文不能恢复其他页面的拦截。

## Tab、动态页面与原生返回

```ts
for (const item of stack.catalog) {
  if (item.kind === "tab") renderTab(item.name, () => stack.switchTab({ name: item.name }));
}
await stack.openDynamicPopup(popup(CustomPopup), { message: "Hello" });
await stack.pushDynamic(page(AdHocPage), { id: 1 });
```

动态定义在历史、实例缓存及拦截意图引用它期间保留，最后一个引用释放后回收。它们也执行校验、守卫和页面级动画，不再通过 route.config 绕过目录解析。普通页和弹窗省略 key 时每次创建独立历史身份；同名页面的显式 key 在同一栈中必须唯一，不同页面名可使用相同 key。Tab 按名称唯一，拒绝自定义 key。

```ts
import { handleNativeBack } from "muvra";
// 适用于要求在很短时间内得到布尔应答的原生桥接；true 代表允许宿主退出。
function onNativeGoBack(): boolean {
  return handleNativeBack(stack) === "exit";
}
```

该适配立即告知宿主网页已接管，再异步执行返回守卫/动画；拒绝返回或等待用户确认不会触发原生超时退出。再次返回可中止尚未提交的检查。根页的退出确认与系统退出仍由宿主管理。这是独立的桥接契约模拟，不能替代 Android / iOS 真机验收。

### 交互式返回

`getSnapshot().back` 可通过现有 `subscribe()` 同步给手势宿主。四种状态描述当前栈能如何处理一次返回。

| `mode`        | 含义                                   |
| ------------- | -------------------------------------- |
| `delegate`    | 没有返回目标，交给宿主的下一层处理     |
| `busy`        | 有正式导航正在处理                     |
| `commit-only` | 有返回目标，确认时执行普通返回         |
| `interactive` | 有返回目标和可用预览，拖动时可更新画面 |

有目标的状态包含 `token`。用它调用 `stack.beginBack(token, options)`，一次会话绑定一组页面实例。当前有弹窗时返回关闭最上层弹窗，否则返回上一页。拖动通过 `update(progress)` 定位到 `0～1`，可以往回拖。取消回到原画面。预览期间目标页不可交互，页面焦点、导航生命周期和历史仍以当前页为准。

`commit()` 才创建一次普通返回请求，复用 `NavigationOptions`、`beforeNavigate`、页面守卫与 `onNavigation`。守卫放行后才改栈，同一目标的预览从当前位置收尾。守卫跨帧等待时先恢复当前页供确认。拒绝时保留原栈，重定向时释放预览并按实际目标转场。重复确认复用结果。新导航、视图解绑、清理缓存或手势信号中止会结束尚未确认的会话，迟到的 `commit()` 返回 `undefined`。

在现有 `transition` 选项声明 `ProgressTransition`。普通导航按时间调用同一帧函数，交互返回按手势进度调用。应用通过 `PageStackView.backPreview` 同步选择预览内容，此回调应保持无副作用。返回 `"mounted"` 复用已挂载目标，返回渲染函数提供只读预览，返回 `undefined` 使用普通返回。应用可以根据业务状态限制哪些内容适合预览。

```ts
import { h } from "vue";
import { PageStackView } from "muvra";
import type { ProgressTransition } from "muvra";

const slide: ProgressTransition = {
  kind: "progress",
  duration: 220,
  prepare(scope) {
    const returning = scope.operation === "back" || scope.operation === "closePopup";
    const page = returning ? scope.from : scope.to;
    return (progress) => {
      // 样式归本次播放，取消或完成时由作用域还原。
      const offset = returning ? progress : 1 - progress;
      scope.style(page, { transform: `translateX(${offset * 100}%)` });
    };
  },
};

h(PageStackView, {
  stack,
  transition: slide,
  backPreview: ({ to }) => (to.name === "catalog" ? "mounted" : undefined),
});
```

### 原生宿主接入示例

以下示例用应用已有的可信 WebView 桥回传 `BackState`。宿主在手势开始前缓存状态，一次手势固定使用同一 ID 和令牌。重新加载 WebView 时用新的文档连接。没有开始事件的返回键可以走 `handleNativeBack()`，已经开始的手势用自己的会话收尾。

```ts
import { handleNativeBack } from "muvra";
import type { BackSession, BackState } from "muvra";

type BackMessage =
  | { type: "ordinary" }
  | { type: "start"; id: number; token: string }
  | { type: "progress"; id: number; value: number }
  | { type: "cancel" | "commit"; id: number };

let latestId = 0;
let active: { id: number; session: BackSession } | undefined;
let lastState: BackState | undefined;
function sendState(back: BackState) {
  if (back === lastState) return;
  lastState = back;
  postBackState(back); // 通过应用的桥调用宿主的 sync(mode, token)。
}

Object.assign(window, {
  muvraBack(message: BackMessage) {
    if (message.type === "ordinary") return handleNativeBack(stack);
    if (message.type === "start") {
      if (message.id <= latestId) return;
      latestId = message.id;
      active?.session.cancel();
      const session = stack.beginBack(message.token, { reason: "native" });
      active = session ? { id: message.id, session } : undefined;
      return;
    }
    // 终止事件先到时，也丢弃随后抵达的同一手势开始事件。
    if (message.type !== "progress" && message.id > latestId) {
      latestId = message.id;
      active?.session.cancel();
      active = undefined;
      return;
    }
    if (active?.id !== message.id) return;
    const { session } = active;
    if (message.type === "progress") return session.update(message.value);
    active = undefined;
    if (message.type === "cancel") session.cancel();
    else void session.commit();
  },
});
const unsubscribeBack = stack.subscribe(({ back }) => sendState(back));
sendState(stack.getSnapshot().back);
```

桥解绑时调用 `unsubscribeBack()`，取消活动会话并移除 `window.muvraBack`。宿主保留自身的动画选择、优先级与根页策略。

#### Android · AndroidX Activity

用 AndroidX Activity 1.8.0+，在宿主 Activity 启用 Predictive Back。通过 `onBackPressedDispatcher.addCallback(this, callback)` 绑定下面的回调。在主线程接收网页状态并调用 `sync`。Android 14+ 的进度事件进入会话，只有完成事件的设备经普通返回处理。根页空闲时提前让出系统回调。 [Android 进度回调](https://developer.android.com/guide/navigation/custom-back/support-animations-views) · [系统返回接管](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture#create-single-responsibility-callbacks)

```kotlin
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import org.json.JSONObject

class MuvraBack(private val webView: WebView) : OnBackPressedCallback(false) {
    private var mode = "delegate"
    private var token: String? = null
    private var nextId = 0
    private var gesture: Int? = null

    fun sync(mode: String, token: String?) {
        this.mode = mode
        this.token = token
        if (gesture == null) isEnabled = mode != "delegate"
    }

    private fun send(message: JSONObject) {
        val json = JSONObject.quote(message.toString())
        webView.evaluateJavascript("window.muvraBack(JSON.parse($json))", null)
    }

    override fun handleOnBackStarted(event: BackEventCompat) {
        val id = ++nextId
        gesture = id
        token?.let {
            send(JSONObject().put("type", "start").put("id", id).put("token", it))
        }
    }

    override fun handleOnBackProgressed(event: BackEventCompat) {
        val id = gesture ?: return
        send(JSONObject().put("type", "progress").put("id", id)
            .put("value", event.progress.toDouble()))
    }

    private fun finish(type: String) {
        val id = gesture ?: return
        gesture = null
        send(JSONObject().put("type", type).put("id", id))
        isEnabled = mode != "delegate"
    }

    override fun handleOnBackCancelled() = finish("cancel")

    override fun handleOnBackPressed() {
        if (gesture != null) finish("commit")
        else send(JSONObject().put("type", "ordinary"))
    }
}
```

#### iOS · UIKit 与 WKWebView

在承载单个 `WKWebView` 的控制器中持有下列对象，在主线程调用 `sync`。这个示例配置左边缘，距离和速度阈值由宿主决定。空闲根页让出 UIKit 的返回手势。 [边缘手势](https://developer.apple.com/documentation/uikit/uiscreenedgepangesturerecognizer) · [UIKit 返回手势](https://developer.apple.com/documentation/uikit/uinavigationcontroller/interactivepopgesturerecognizer)

```swift
import UIKit
import WebKit

@MainActor
final class MuvraEdgeBack: NSObject, UIGestureRecognizerDelegate {
    private let pan = UIScreenEdgePanGestureRecognizer()
    private let send: ([String: Any]) -> Void
    private var mode = "delegate"
    private var token: String?
    private var nextID = 0
    private var gesture: Int?

    init(webView: WKWebView, nativePop: UIGestureRecognizer?, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        super.init()
        pan.edges = .left
        pan.delegate = self
        pan.addTarget(self, action: #selector(handle(_:)))
        webView.allowsBackForwardNavigationGestures = false
        webView.addGestureRecognizer(pan)
        nativePop?.require(toFail: pan)
    }

    func sync(mode: String, token: String?) {
        self.mode = mode
        self.token = token
    }

    func detach() {
        finish("cancel")
        pan.view?.removeGestureRecognizer(pan)
    }

    func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        mode != "delegate"
    }

    @objc private func handle(_ pan: UIScreenEdgePanGestureRecognizer) {
        guard let view = pan.view else { return }
        let progress = min(1, max(0, pan.translation(in: view).x / max(1, view.bounds.width)))
        switch pan.state {
        case .began:
            nextID += 1
            gesture = nextID
            if let token { send(["type": "start", "id": nextID, "token": token]) }
        case .changed:
            if let gesture { send(["type": "progress", "id": gesture, "value": Double(progress)]) }
        case .ended:
            finish(progress >= 0.35 || pan.velocity(in: view).x >= 700 ? "commit" : "cancel")
        case .cancelled, .failed:
            finish("cancel")
        default:
            break
        }
    }

    private func finish(_ type: String) {
        guard let id = gesture else { return }
        gesture = nil
        send(["type": type, "id": id])
    }
}

// 宿主自身持有 edgeBack，并在控制器解除绑定时调用 detach()。
edgeBack = MuvraEdgeBack(webView: webView, nativePop: navigationController?.interactivePopGestureRecognizer) { [weak webView] message in
    webView?.callAsyncJavaScript(
        "window.muvraBack(message)", arguments: ["message": message], in: nil, in: .page,
        completionHandler: nil
    )
}
```

示例使用 `WKWebView.callAsyncJavaScript` 传递消息对象。应用如果还使用 WebKit 网页历史或额外的 UIKit 返回手势，应协调同一区域的识别优先级。 [WebKit JavaScript 调用](<https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript(_:arguments:in:in:completionhandler:)>) · [WebKit 历史手势](https://developer.apple.com/documentation/webkit/wkwebview/allowsbackforwardnavigationgestures)

## 缓存及选项

| 选项                  | 默认                       | 契约                                                     |
| --------------------- | -------------------------- | -------------------------------------------------------- |
| renderDepth           | 2                          | 实际保留的经典页尾部深度，或 all                         |
| keepTabRoot           | true                       | 另将逻辑根 Tab 保留在物理层中                            |
| maxHistory            | 32                         | 最多保留的普通历史页，根 Tab 另计                        |
| maxCachedPages        | 16                         | 物理层以外的缓存实例预算，按近期使用淘汰                 |
| maxPopups             | 32                         | 覆盖层深度预算，超限拒绝新弹窗                           |
| closePopupsOnNavigate | true                       | 经典导航完成检查后关闭弹窗；false 保留完整弹窗显示与交互 |
| guardTimeoutMs        | 30000                      | 单个守卫的最长等待；0 显式关闭计时，仍可中止             |
| transitionTimeoutMs   | max(2000, duration + 1000) | 动画最长等待；0 显式关闭计时，仍可中止                   |
| transitionDurationMs  | 280                        | 默认动画时长，0 跳过                                     |
| maxRedirects          | 8                          | 最大重定向次数，超限失败                                 |
| maxQueue              | 32                         | 最多排队任务数，不含当前任务                             |

Tab 默认缓存；普通页需 `page(Component, { cache: true })`。弹窗关闭即回收。缓存不是持久化：预算淘汰或 `clearCache()` 都会卸载不在物理层中的实例，历史仍可在返回时重新物化。退出账号可用 `reset([...], { clearCache: true })`，最终根页面也会重新创建。

时长与截止时间必须是非负安全整数；截止时间最多 2,147,483,647 毫秒，自动截止时间会随显式长动画时长增加。容量必须是整数，具体允许零值的选项由公开类型注释说明。未知选项和非法值在创建时同步报错。

## 按需加载和重试

```ts
import { lazy, page } from "muvra";
const order = page(lazy(() => import("./OrderDetail.vue")));
```

`lazy` 的 loader 接收 AbortSignal，错误边界 Retry 会重新执行失败的 loader，成功后的组件定义可复用。Vue 自身的 defineAsyncComponent 也受支持，但其请求缓存及重试策略由该 Vue 包装器管理。异步 setup 使用 Vue Suspense 边界；此 Vue API 仍标记为实验性，当前已对锁定版本及另一个 3.5 补丁版本验证，升级 Vue 时必须重跑集成检查。宿主服务器请求终止时也应 dispose 实例。

框架 lazy 保留 loader 返回组件或 default 模块的公开输入，完整输入契约与直接导入相同；包装器不会声称转发原组件自定义实例方法。

loader 即使忽略 signal，中止也会结束框架自身的等待，并处理其迟到拒绝；底层网络请求能否真正停止仍取决于 loader。销毁 SSR 实例后不会继续等待一个不响应中止的 loader。

## 通用图层与页面导航

`createLayerStack()` / `LayerStackView` 是不依赖导航的基础。它负责创建、隐藏、相对排序、样式绑定、动画和资源回收，不管理页面名、参数、历史或守卫。`PageStackView` 把导航快照映射为这套基础上的页面图层；装饰层和临时动画层使用同一个渲染器。删除普通图层不会产生返回操作，历史里也可以保留没有挂载图层的页面。

```ts
import { h } from "vue";
import { createLayerStack, LayerStackView } from "muvra";

const layers = createLayerStack();
const background = layers.create({ content: () => h(HomeContent) });
const foreground = layers.create({ content: () => h(DialogContent), interactive: true });
layers.order([background.anchor, foreground.anchor]);
// 业务直接创建中间层，不需要注册一个假页面。
const shade = layers.create({
  placement: { above: background.anchor, below: foreground.anchor },
  style: { background: "#000", opacity: 0.3 },
});
// 在 Vue 渲染函数中：h(LayerStackView, { stack: layers })。
shade.place({ below: foreground.anchor });
shade.dispose();
// 整个显示会话结束时：layers.dispose()。
```

`order()` 约束基础层的相对顺序，`placement` 约束附加层位于谁上面或下面。渲染器统一分配实际 z-index；扩展不能依赖导航快照里的序号等于最终 DOM z-index。循环约束、伪造锚点、跨实例锚点会在提交前拒绝。引用层被删除时，位置依赖层暂时隐藏，直到重新放置或清理。

`owner` 表达资源所有权，与放置位置分开：拥有者隐藏会隐藏附属层，拥有者销毁会级联回收附属层。`group` 允许布局订阅只关注某组基础内容；`onLayout(callback)` 返回全部可见层，指定 symbol 选择对应组，null 只选择未分组层。`batch` 只合并发布，不提供任意业务修改的事务回滚。

`layer.styles.bind(objectOrGetter)` 支持响应式样式贡献，返回撤销函数；撤销会重算剩余贡献，不会用旧值覆盖其他扩展。`layer.whenMounted(signal?)` 等待 DOM，`layer.animate(frames, timing?)` 管理自己的 WAAPI 句柄并在图层销毁时取消。没有 WAAPI 时对应轨道直接完成。position、inset、display、zIndex、pointerEvents 是渲染器保留的结构样式；布局边距写在内容组件中。`getSnapshot()` 只读，`has(anchor)` 查询当前身份，`getElement(anchor)` 提供 DOM；一个图层栈同一时间只接受一个视图。

## 声明与页面脚本中的扩展

遮罩位于可选子入口，没有内核专用字段或特殊分支：

```ts
import { definePages, page, popup } from "muvra";
import { backdrop } from "muvra/extensions/backdrop";

const pages = definePages({
  order: page(OrderDetail, {
    extensions: [backdrop({ color: "#17314f", opacity: 0.3 })],
  }),
  confirm: popup(Confirm, {
    extensions: [backdrop({ opacity: 0.25 })],
  }),
});
```

页面脚本中可以结合状态，或在事件处理函数中追加、撤销贡献：

```ts
import { ref } from "vue";
import { defineExtension, usePage } from "muvra";
import { backdrop } from "muvra/extensions/backdrop";

const context = usePage();
const expanded = ref(false);
// 只覆盖透明度；backdrop 自己合并字段，声明中的颜色仍然保留。
const remove = context.extend(
  backdrop({
    opacity: () => (expanded.value ? 0.5 : 0.2),
  }),
);
context.extend(
  defineExtension({
    key: "order-appearance",
    setup({ styles }) {
      styles.bind(() => ({ borderRadius: expanded.value ? "0px" : "16px" }));
    },
  }),
);
// 需要恢复声明配置时调用 remove()；组件卸载也会自动撤销脚本贡献。
```

同 key 只有一个安装实例，脚本贡献覆盖声明贡献，较晚的脚本贡献优先。相同 setup 函数只更新实时只读 options，不重新挂载；更换 setup 则先清理旧实现。没有 mergeOptions 时替换配置，有 mergeOptions 时按扩展自己的规则合并，内核不做通用深合并。backdrop 采用字段合并；其 color 和 opacity 接受值、Ref 或 getter，默认黑色和 0.3。

`defineExtension({ key, options?, mergeOptions?, setup })` 的 setup 必须同步登记资源，可以返回清理函数。上下文提供只读 owner 锚点、signal、styles.bind、layers.create/getElement、onLayout 和 onCleanup。通过该上下文创建的层自动归扩展与页面拥有，默认布局只观察拥有者所在的基础组，排除扩展装饰层，避免遮罩把自身作为下一次的背景。独立图层也可用 `createExtensionHost(layers, owner, definitions, { group?, onError? })` 安装同一扩展，结束时 dispose。

backdrop 根据实际可见页面顺序，只由最上面的页面在自己和后方页面之间创建一层；不根据逻辑 focused 判断。普通页转场完成后只有一个可见页面，遮罩释放；弹窗完成后背景仍可见，遮罩保留。关闭 B 时虽然焦点已经回到 A，B 的离场动画仍在前景，因此遮罩继续位于 A 与 B 之间；结束后才恢复 A 的遮罩。同名页面、缓存页面、不同导航实例分别持有资源。

## 动画、可访问性和诊断

框架只提供 `defineTransition`、`compose`、`sequence` 和受管资源接口，不内置 dissolve/fade/glow/overlay，也不默认添加运动效果。这些示例位于 demo/transitions，业务可以复制修改。`View.transition=true` 默认允许页面声明的效果；没有声明则跳过。false 禁用整个视图动画；受管效果或原始驱动作为视图回退。前进优先进入页的 transition，back / closePopup 优先离开页。关闭动画不会关闭持续的页面扩展或弹窗遮罩。

```ts
import { compose, defineTransition, sequence } from "muvra";

const reveal = defineTransition({
  duration: 400,
  async run(scope) {
    await scope.animate(scope.to, [{ opacity: 0 }, { opacity: 1 }]);
  },
});
const light = defineTransition({
  duration: 500,
  async run(scope) {
    const layer = await scope.layer(MyEffect, { accent: "cyan" });
    scope.onCleanup(() => releasePrivateResource());
    await scope.animate(layer, [{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }]);
  },
});
const together = compose(reveal, light);
const staged = sequence(reveal, together);
```

compose 同时播放并取最长时长，sequence 顺序播放并累加时长，可以嵌套。零时长步骤不播放，transitionDurationMs=0 禁用所有导航动画。默认截止时间为整个效果时长加 1000ms，至少 2000ms；显式 transitionTimeoutMs 是硬上限，0 只关闭计时。减少动态效果偏好直接跳过动画，不创建临时效果层，持续遮罩仍正常存在。

scope 提供 from/to、路由、operation、durationMs、signal、document，以及 animate、frame、wait、layer、style、onCleanup、play。临时层也使用公共图层基础，保留 Vue 注入、错误边界及真实卸载，不进入导航历史。所有登记资源归整次编排所有，结束或取消后逆序释放；未 await 的受管轨道仍被跟踪，迟到拒绝被消费，关闭后不能再申请资源。动画、图层及扩展共用 createResourceScope；异步清理拒绝被诊断，不阻止后续回收。

stack.cancel、调用者 signal、实例 dispose 和视图卸载都触发清理。提交后的动画中止仍完成已提交导航，transition=interrupted；异常为 failed，超时为 timed-out，均最终同步页面并允许后续导航。原始驱动自行释放未登记的第三方资源。

视图禁用背景交互，管理顶部弹窗的 Tab / Escape 和焦点恢复；宿主 UI 自行管理时可设置 keyboard=false / restoreFocus=false。onError 提供错误码、原始 cause、导航 ID、页面和严重程度。validate 同步检查参数，异步检查放入 beforeEnter；任意业务同步死循环不能被超时抢占。

## 本地开发与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run typecheck
pnpm run typecheck:sfc
pnpm test
pnpm run test:mutations
pnpm run test:consumer
node scripts/install-chromium.mjs
node scripts/install-webkit.mjs
pnpm run test:browser
pnpm run demo:build
pnpm run demo
# 所有验收关卡按同一份输入摘要执行，并保留日志。
pnpm verify
```

浏览器套件使用本地 browsers/ 目录内、与 Playwright 驱动版本匹配的 Chromium 桌面/移动视口和 WebKit。当前依赖版本锁定于 pnpm-lock.yaml。安装脚本使用 curl 和 unzip，按锁定 Playwright 版本下载本机对应的浏览器；Linux 还需按 Playwright 要求安装系统依赖。当前实际验收环境为 macOS，其他系统尚未验证。页面容器也有 SSR smoke；SSR 按请求创建独立实例，不提供 URL 恢复或跨请求共享状态。

真实 SFC 的目录、页面和宿主位于 tests/sfc；启动 demo 后访问 /demo/props.html。SFC 类型关卡包含独立通过的正例项目和逐项必须被编译器拒绝的反例项目；同一份页面还用于 Node 挂载、真实浏览器和独立打包消费者验证。

动画真实页面位于 tests/sfc/animation；启动 demo 后访问 /demo/effects.html，可操作溶解、光效、顺序编排、多层弹窗、取消和异常路径。实现依据为 [W3C Filter Effects](https://www.w3.org/TR/filter-effects/)；目标 Android/iOS WebView 的性能和兼容性仍需真机验证。

图层与扩展的真实页面位于 tests/sfc/layers；访问 /demo/layers.html，可以操作声明/脚本覆盖、同名弹窗、关闭动画、守卫取消和不带导航的独立图层。

开发要求 Node.js >=22、pnpm 10.32.1、Vue ^3.5.25。示例默认地址为 http://127.0.0.1:4187，可通过 MUVRA_PORT 调整手动服务端口。自动浏览器测试固定使用 4187。

完整验证运行 `pnpm verify`，新报告生成于 reports/，并记录验证前后的输入摘要。历史实验材料仅在本地归档，不进入公开仓库或 npm 产物。Android/iOS 真机、生产 WebView、长时间运行和性能仍需独立验收；alpha 阶段 API 可能调整。贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。
