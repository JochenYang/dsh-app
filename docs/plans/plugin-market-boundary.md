# 插件市场的边界：与上游 Discover 的共存与退役判据

- Status: active
- 决策日期: 2026-10-17
- 背景：内核 0.2.1 新增可选 bundle `plugin-market-bundle`（`packages/experimental/plugin-market-bundle`）：
  它挂载 Host 的 `pluginMarket` 服务、插件页的 **Discover** 标签，以及一个 `plugin_market` 模型工具。
  README 明确 "Shipped profiles leave it disabled"，所以今天两者不会同时出现——这份文档定的是**同时出现时各管什么**，
  以及**我们什么时候退场**。

## 1 定位：我们的市场是主入口

用户绝大多数从侧栏抽屉安装插件，这条路径不因为上游 Discover 存在而隐藏、降级或改道。
我们不做“检测到上游就切走”的自动行为——那会让主入口随上游开关漂移。

## 2 所有权边界

| 能力 | 归属 | 依据 |
|---|---|---|
| 技能目录与安装/卸载（`market_search` / `market_install_skill` / `market_uninstall_skill`） | 我们的市场 | 上游 Discover 只装 bundle |
| 一次性安装意图：绑定目录行、拒绝重放、拒绝跨 profile 复用（`src/install-intent.ts`） | 我们的市场 | 上游 `plugin_market` 工具没有这层约束 |
| 本地/Git 开发副本的拒绝规则（同名已装即拒绝并指名，不静默替换） | 我们的市场 | 替换是面板自己的确认动作 |
| 已发布 bundle 的**发现**（索引源、Discover 列表） | **让给上游** | 我们不再新增官方索引源、不追 Discover 的 UI |
| 已声明 bundle 的启停与版本更新 | 内核插件页（上游） | 那是 profile 的组成，不是安装 |

## 3 共存规则

1. **不接管上游的 id 与工具名**：我们不注册 `plugin_market`、不往插件页注入 Discover 标签。
   我们的面只有 `sidebar.footer.action` 与 `/api/plugins/dsh-app/plugin-market/*` 路由。
2. **安装串行化交给内核的 profile 写锁**：两条路径最终都落到内核的包操作上——
   我们的执行器 spawn `dsh plugin --profile <p> add <target>`（`src/installer.ts`），
   与上游同一条 `runPluginCommand`，由 `withFileLock(<profile>/package.json)` 串起来
   （`packages/boot/plugin-manager/src/operations.ts:545-557`）。因此同时启用不会互相踩 profile。
3. **两套源互不写入**：我们的目录源（HTTP JSON 目录）与上游的索引源是两份数据，
   用户的官方源不会出现在我们的面板，我们的源也不会进上游的索引。
4. **行为不随开关变化**：上游 bundle 启用时，我们的面板照旧工作。
   若将来两者同时开启确实造成用户困惑，再加一行指向官方 Discover 的提示；
   现在不写这条分支（观察项，不是待办）。

## 4 退役判据（三条同时成立才退）

1. 上游 Discover 能安装**技能**，而不只是 bundle；
2. 上游的安装路径具备**一次性意图**或等价的防重放约束（令牌绑定目录行、一次性使用、跨 profile 拒绝）；
3. 上游面板覆盖**本地与 Git 开发副本的拒绝规则**——已有同名安装时拒绝并指名，而不是静默替换。

三条同时成立之前，我们的市场不删、不降级。只满足 1 或只满足 3 都不够：
缺 2 意味着“同一行可以装两次、换 profile 还能复用”，缺 3 意味着用户的开发副本会被覆盖。

## 5 不做

- 不把我们的目录并入上游索引源，也不反向读取它；
- 不 fork `plugin-market-bundle`；
- 不为“两个市场同时开”写特殊分支（第 3 节第 4 条除外）。

## 相关

- 上游包：`packages/experimental/plugin-market-bundle`、`packages/boot/plugin-market`、`packages/client/ui-plugin-market`
- 我们：`plugins/plugin-market/`（`src/install-intent.ts`、`src/installer.ts`、`src/bridge*.ts`）
- 这一轮的重复项盘点：`docs/kernel-0.2.1-rc.1-upgrade.md` §2.2
