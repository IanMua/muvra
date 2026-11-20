# 迁移到 Muvra

本指南供旧页面栈使用方和早期实验版使用方参考。接入应作为独立变更评审，并在目标应用中验证；本地回归不代表 Android / iOS 真机验收。

| 当前 API / 选项                               | Muvra API                                                    |
| --------------------------------------------- | ------------------------------------------------------------ |
| registerPages + 全局注册                      | definePages + createPageStack({ pages, initial })            |
| kind: normal / tab / pop                      | page(Component) / tab(Component) / popup(Component)          |
| navigateTo / redirectTo                       | stack.push / stack.replace                                   |
| reLaunch / resetTo                            | stack.reset，接受只读且非空数组                              |
| switchTab / openPopup / navigateBack          | stack.switchTab / stack.openPopup / stack.back               |
| route.config 动态定义                         | stack.pushDynamic / stack.openDynamicPopup                   |
| useParams<T>()                                | usePage(stack, name).params，为 ComputedRef；明确读取 .value |
| onShow / onHide / onUnload / onBeforeBack     | 页面上下文的 onShow / onHide / onUnload / beforeBack         |
| useNavigationIntercept                        | 页面上下文 isIntercepted.value / resume()                    |
| usePageRecord / PageRecordKey                 | 删除对内部记录的依赖，改用 route、params、visible、focused   |
| getCurrentRoute                               | stack.getSnapshot().current                                  |
| useRegistryPages                              | stack.catalog，不包含可写注册表或组件实例                    |
| usePageStackState / usePagePool / destroyPage | 删除公开写入口；用快照、clearCache、reset 或 dispose         |
| alwaysKeepTabRoot                             | keepTabRoot，且实际参与物理层计算                            |
| renderClassicDepth                            | renderDepth                                                  |
| maxNormalDepth                                | maxHistory，仅限制普通历史页，根 Tab 另计                    |
| maxNormalDepthDestroyMethod                   | 固定淘汰最旧普通历史；特殊历史策略显式 reset                 |
| meta.keepAlive                                | PageOptions.cache；遵守缓存预算                              |
| closePopOnNavigate                            | closePopupsOnNavigate                                        |
| installWaapiTransitions / 预设与全局驱动      | 显式配置受管效果或驱动；默认不添加运动效果                   |

## 优先迁移点

1. 应用装配：创建一个明确的 stack，await ready 后处理初始化失败，根 Vue 容器用 prop 绑定；结束会话时 dispose。
2. 页面目录：移除全局 PageRouteMap 增补，页面种类与参数由 helper 推导。元信息只承载业务数据。
3. 登录页：setup 捕获上下文，登录成功后 resume；不读取拦截目标、配置或原操作字段。
4. TabBar：从只读目录筛选 tab，当前选中项从 snapshot.current 读取，删除 PageRecord 注入与 any 转换。
5. 原生 go_back：用 handleNativeBack 的即时接管决定返回布尔值，避免等待慢守卫超出原生桥接应答期限。需要真机验证原生是否把 handled 映射为不退出。
6. 参数错误页面：通过 validate 在提交前拒绝，不在 setup 中调用 destroyPage 后抛异常。
7. 按登录态隔离页面：退出登录时 reset(routes, {clearCache:true})，不要依靠隐藏缓存页自行忘记旧账号数据。

## lab.0 / lab.1 到 lab.2：完整公开 props 推导

- 默认使用 `page(Order)` / `tab(Orders)` / `popup(Confirm)`，参数来自页面公开 props；先补齐页面 defineProps 或 defineComponent 的具体类型。
- 原实验 `page<P>(Component)` 改为 `page(Component)`；没有可用组件类型时用 `page.withParams<P>()(Component)`，tab/popup 同理。这是有意的破坏性类型 API 调整，避免显式参数类型与组件类型泛型混淆。
- 移除实验版的页面字段选择配置，注册统一使用 page(Component)。组件声明的全部公开业务 props 都参与导航输入推导，不能在目录另列名单。JavaScript 中遗留的字段选择配置会明确抛出 INVALID_CONFIG。
- 必填、可选、可空和默认值语义由页面声明决定。pageProps 继续透传共用值，但不会从导航类型中扣除字段，也不会改变必填性。
- lazy 不需要重写参数泛型；它保留被加载页面的公开输入。原始导航参数不会自动写入 Vue 解析后的默认值或仅由 pageProps 提供的值。
- 命令行加入 `pnpm run typecheck:sfc`；不再用统一的 DefineComponent<any> shim 代替真实 .vue 类型检查。

## lab.2 到 lab.3：受管转场和临时图层

- 原始 transition 函数与 false 保持可用；新效果使用 dissolve、fade、glow、overlay，编排使用 compose / sequence，无需全局安装或注册。
- back / closePopup 改由离场页优先选择动画，与其入场配置配套；前进仍优先进入页。曾依赖目标页覆盖弹窗退出效果的配置应重新检查。
- 自定义 Vue 图层通过 overlay(Component) 或 scope.layer(Component, props) 挂在现有组件树中；不需要 createApp，也不加入路由历史。组件定时器/订阅放入 onUnmounted 清理。
- 复杂驱动建议迁移到 defineTransition({duration, run(scope)})，将句柄、帧、临时样式及附加资源交给 scope 管理。原始驱动的私有副作用不会自动获得清理能力。
- 默认动画截止时间覆盖整个编排，显式 transitionTimeoutMs 仍是硬上限。transitionDurationMs=0 与 View.transition=false 保持整容器禁用语义。
- 拟议的字符串或裸 enter/leave 配置没有加入本轮；直接使用效果函数，避免维护两套重复配置。

## lab.3 到 lab.4：图层基础与普通扩展

- dissolve / fade / glow / overlay / waapiTransition 不再从包导出。示例已移到 demo/transitions；业务复制到自身动画目录，或直接编写 defineTransition。compose / sequence 保留。
- 省略 View.transition 不再隐式播放内置动画；true 允许页面声明的效果，没有声明则跳过。原始驱动与 false 保持可用。
- page/tab/popup 的 options.extensions 声明可复用扩展；页面脚本通过 usePage().extend(definition) 追加配置，撤销函数恢复声明配置，组件卸载自动撤销。
- backdrop 从 muvra/extensions/backdrop 引入。它使用公开图层和扩展接口，没有内核专有字段；不要再手动计算遮罩 z-index。
- createLayerStack / LayerStackView 可以独立管理不带导航的图层，资源归属、物理顺序与逻辑历史分别管理。移除图层不等于导航返回。
- 动画临时 Vue 层改为普通图层子树，不再使用单独的 Teleport 宿主；仍保留宿主注入、错误边界和卸载生命周期。
- 页面 props 自动推导、共享 props、守卫、缓存、登录恢复、导航取消和结果语义继续保留。

## 必须注意的行为变化

- 普通页和弹窗默认允许同名多实例；曾依赖“按页面名复用一个实例”的调用，应提供显式 key 或将业务状态放入 Store。
- 导航统一返回结果，守卫 false 是 cancelled，未知路由/守卫异常是 failed；调用者不能再只靠 catch 处理所有错误。
- Observable 的 undefined 首值统一按 void 放行，源错误是 failed；不再使用原分支的 `!!undefined` 拒绝语义。
- 返回目标和 reset 中间目标都执行进入检查，权限依赖过期时可能重新进入登录页。
- 检查期间新导航返回 busy，UI 可绑定 snapshot.busy 禁用重复操作；异步守卫应返回路由，不等待嵌套导航。
- 缓存受预算约束，关键草稿不能只依靠页面局部状态永久保留。
- View 卸载后重新挂载会创建新的 Vue 组件，逻辑历史仍在；onUnload 会释放旧组件资源。
- 原生状态栏等仅由顶部页面控制的行为应观察 `focused`；`onShow` / `visible` 包括弹窗下仍可见的背景页，不能把可见当成正在接收交互。
- 动画已提交后失败仍然完成导航。宿主需要展示技术诊断时使用 onError，不把动画失败当成原生退出许可。

## 接入后的独立验收

实验包/类型/浏览器通过后，业务仓库仍需分别验证：真实页面 props、Vant 弹窗动画与焦点、登录态切换、订单 Tab 恢复、RxJS 返回守卫、Android 原生 go_back、iOS WebView、后台切前台、发布构建和实际设备。此阶段不自动执行这些项目内修改。

## 实验包到 Muvra alpha

所有包导入统一使用 `muvra`，可选遮罩使用 `muvra/extensions/backdrop`。版本重新起步为 `0.1.0-alpha.0`，采用 MIT；这不代表与其他同版本号软件兼容。手动示例服务端口变量改为 `MUVRA_PORT`。业务基线和保护脚本不再属于独立项目的验收流程，旧报告只保留在本地归档。
