# 贡献指南

Muvra 当前处于 alpha 阶段。提交前先明确问题、涉及的公开契约和验证方式；独立变更保持单一职责。提交信息使用英文 Conventional Commits。

## 架构边界

- src/engine.ts、planner.ts、record-store.ts 分别管理导航执行、纯规划及页面实例和缓存。
- src/component-inputs.ts 与 definitions.ts 保留页面公开 props 自动推导。
- src/layers/ 独立管理图层、排序、扩展和资源，不依赖导航历史。
- src/vue.ts 将导航桥接到图层；src/animation/ 负责转场编排和单次资源作用域。
- src/extensions/backdrop.ts 仅使用公开接口。视觉预设属于 demo/transitions/，不进入根导出。

代码注释使用中文，按需要解释做什么、为什么、何时和如何执行。保持每实例隔离、逆序幂等清理及迟到异步结果的处理。

## 验证

使用 Node.js >=22 和 package.json 指定的 pnpm。运行 README 中的安装步骤，再执行 pnpm verify。它覆盖构建、类型、真实 SFC 正反例、Node、格式、可执行变体、独立安装消费者和浏览器。报告生成在 reports/，不纳入公开源码。

浏览器脚本需要 curl 和 unzip。浏览器安装入口顺序执行，不能并发覆盖本地清单。Linux 系统依赖需另行准备；当前验证平台为 macOS。

## 发布边界

npm 仅包含 dist/、src/、README.md、MIGRATION.md、LICENSE 和包元数据；打包前重新构建。实验业务基线、交接资料、历史报告、浏览器和缓存只保存在 .local-archive/ 或本地忽略目录。不要添加个人绝对路径、业务源码或凭据。

本地 npm pack 和消费者验证不等于发布。Git 初始化、提交、远程建仓、推送与 npm 发布分别由维护者明确授权。发布前重新核对包名可用性、版本、许可证及 tarball 内容，并确认真机和生产环境验证范围。
