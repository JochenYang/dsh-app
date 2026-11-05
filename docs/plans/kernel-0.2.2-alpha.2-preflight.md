# 内核线 0.2.2-alpha.2：预适配结论

- Status: superseded
- Plan date: 2026-10-28
- Note: 结论是 2026-10-28 的实测快照；0.2.2 线已在 rc.1 上执行完毕（见 §9 与 `../archive/kernel-line/kernel-0.2.2-rc.1-upgrade.md`），本文件保留作 alpha.2 → rc.1 的差异备查。§9 里仍标 `[待验证]` 的项没有补测

> 执行 2026-10-28。**这不是一次升线**：本仓跟随 RC 线，0.2.2-alpha.2 是 alpha 线的首个版本，
> 本文只记录「正式版发布时需做什么」，供那一轮直接照此执行。
> 流程判据在 [`agents/kernel-line-regression.md`](../agents/kernel-line-regression.md)，
> 上一轮已执行的记录在
> [`kernel-0.2.1-rc.3-upgrade.md`](../archive/kernel-line/kernel-0.2.1-rc.3-upgrade.md)。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读包内容或源码；
> `[待验证]` = 推断，正式版之前必须补测。
>
> 复现材料（gitignore 的 scratch 目录，随时可重跑）：`scratch/kernel-0.2.2/`
> —— `resolved.json`（逐包解析）、`diff.json`（逐包载荷比对）、
> `resolve.mjs` / `diff.mjs` / `shapes.mjs` / `service-surface.mjs` / `decl-diff.mjs`。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh → { alpha: 0.2.2-alpha.2, latest: 0.2.1-rc.2, next: 0.2.1-rc.4 }
0.2.2-alpha.2 发布：2026-10-28T02:50:54Z（rc.4 是 1 分钟前，02:49:58Z）
0.2.2-alpha.2 engines：node >= 24.9.0（rc.4 没有 engines 字段）
0.2.2-alpha.2 依赖：91 个，全部钉精确版本 0.2.2-alpha.2；cordis ~4.0.6-alpha.1；schemastery ~3.18.6-alpha.1
我们的 spec（升线前）：^0.2.1-rc.3，40 个包 / 439 处引用 / 5 个不同 spec 值
```

> 基线已移动（2026-10-30 补记）：`0.2.1-rc.5` 发布后同时占据 `latest` 与 `next`，本仓已跟到
> `^0.2.1-rc.5`（见 [`kernel-0.2.1-rc.5-upgrade.md`](../archive/kernel-line/kernel-0.2.1-rc.5-upgrade.md)）。上表的
> `latest`/`next` 是 2026-10-28 的快照，`alpha` 未变。本文其余结论不受影响 —— 它们针对的是
> `0.2.2-alpha.2` 与 `0.2.1-rc.3` 的差集。

**两条线的关系**：`0.2.1-rc.4` 只修了「ACP 模式下诊断输出混入 stdout」一行，是 0.2.1 线的收尾；
`0.2.2-alpha.2` 是另一条线的开头。从 rc.3 直接到 alpha.2 是**跨线**，不是小补丁。

## 1 逐包载荷比对 `[实测]`

不读 changelog 猜。38 个 `@deepseek-ai/dsh-*` 包各下 rc.3 与 alpha.2 两个 tarball，解包后按文件算
sha256（`package.json` 排除，它的版本与内部指针本来就该变）：

- **38 个包在 alpha.2 全部存在**（无改名、无移除）；cordis 与 schemastery 各自独立的版本线。
- **32 个包有改动，6 个逐字节相同**（含 `dsh-util-values`、`dsh-atomic-write` 等）。
- 去掉 `locale/*.json`（六个新语种）与 README 后，仍有 27 个包动到 `lib/`。

## 2 导出面：我们引用的符号 `[实测]`

对 369 个我们 import 的符号逐一检查「在目标线的入口（含子路径 exports）是否仍可达」，并比对声明：

- **0 个丢失**。
- 21 个声明有变，其中 **1 个是真破坏**，其余是注释措辞、`| undefined`、新增可选属性、
  `import("react").JSX.Element` → `React.JSX.Element` 之类的伪差异。

| 变动 | 目标 | 是否打到我们 |
|---|---|---|
| `ProjectionDefinition<K extends string, S>`（原单泛型，且 `SessionProjectionStateMap` 导出被删） | `plugins/plugin-rewind/src/projection.ts:366` | **是**，见 §3.4 |
| `ToolsService.register(definition, options?)` | 我们只传一个参数 | 否，纯增量 |
| `ToolsService.resolve` / `executable`（新） | 未使用 | 否 |
| `WebFetchProvider.ready?(llmProvider)`（新，可选） | 我们的 fetch provider 未实现 | 否，可选增强 |
| `WebSearchSource.summary`（新，可选） | 我们的 search provider 只回 `snippet` | 否，但影响质量，见 §5 |
| `Tooltip` 新增 `onlyWhenClipped?` | 在用 Tooltip | 否，可选属性 |
| `AgentOptions.reasoningEffort` 加 `| undefined` | plugin-swarm 传 agentOptions | 否 |
| `system-prompt/assemble` 载荷类型改名 `PromptAssembly`→`PromptPresentation` | 我们不监听该事件 | 否 |
| `tools/pre-execute` / `post-execute` / `execute` 三事件 | plugin-hooks 监听 | 否，事件仍在，`this` 从 `Scoped<ToolRuntime>` 换成 `Scoped<ToolsService>`（我们用的是本地结构类型） |
| `defineTool` / `DefineToolOptions` / `ToolDefinition` | 28 个工具 | 否，逐行比对只差注释 |

逐项确认**未变**的还有：`session.append`、`officeToPdf`、`prepareContinuable`、
`assertSubagentMaxDepth`、`createUserMessage` / `createSystemMessage`、`CommandInvocation`、
`SubagentResult`、`SettingsSchemaService`、`SessionId` / `SessionSeq` / `SessionLogOffset`。

**服务方法面**（导出类型比对看不到，单独扫了 `.d.ts` 里的方法签名）：
`ctx.tools.register`、`ctx.systemPrompt.section` / `.context`、`ctx.commands.register`、
`ctx.connection.fetch.register`、`ctx.sessionProjections.register` 都有目标版本可用。

`ctx.fiber.entry`（plugin-swarm 用它取 loader 条目）：cordis 4.0.6-alpha.1 的 Fiber 是**纯增量**
（新增 `rawConfig` / `effectiveConfig` / `resolveConfig`），`entry` 仍由 `cordis-plugin-loader`
1.0.7-alpha.1 写入（该包源码第 56 行 `const entry = ctx.fiber.entry`）`[静态]`。

## 3 必改项

### 3.1 全量换线（20 个 `package.json`）`[实测]`

semver 实测：`^0.2.1-rc.3` **不接受** `0.2.2-alpha.2`（caret 不含其它 tuple 的预发布）。
根 + 19 个插件的 peer/dev 一起改，只改根会让插件继续编译在旧线上。

### 3.2 cordis 与 schemastery 不能用 caret `[实测]`

上游钉 `~4.0.6-alpha.1` / `~3.18.6-alpha.1`。实测 `^4.0.4` 与 `^3.18.4` **都不接受**目标版本
（同样是预发布 tuple 的规则），必须写成 `~` + 预发布字面量。19 处 cordis、11 处 schemastery。

### 3.3 Node ≥ 24.9 是发布阻断项 `[实测]`

`engines.node >= 24.9.0`。更关键的是 `scripts/build-runtime.mjs:394` 用 `process.version`
决定打进 runtime 的 node —— **CI 在 Node 22 上构包就会把 v22 打进产物**。
`.github/workflows/ci.yml`（2 处）与 `release.yml`（3 处）的 `node-version: 22` 必须提到 ≥24.9。
本机是 v24.21，现有产物也是 24.21，所以本地构包看不出这个问题。

### 3.4 一处源码改动：会话投影契约 `[实测]`

新签名 `ProjectionDefinition<K extends string, S>`（两个泛型、无默认值），且
`SessionProjectionStateMap` 已删（只留 `SessionProjectionMap`）。

- `plugins/plugin-rewind/src/projection.ts:366` 现在是 `satisfies ProjectionDefinition<'rewindAnchors'>`
  → 需要补第二个类型参数（`RewindState`）。
- 同文件 `:90` 仍在增强 `SessionProjectionStateMap`；该接口已不存在，这一段应删除
  （`:94` 对 `SessionProjectionMap` 的增强保留）。
- `view` / `viewSchema` 包了一层 `SessionProjectionViewValue<…>`，但它是恒等映射
  （只有带 `SessionProjectionSummaryExcluded` 标记才剥），我们的 wire 类型不受影响 `[静态]`。

## 4 兼容但已被标记弃用

| 位置 | 现状 | 处置 |
|---|---|---|
| `plugins/plugin-swarm/src/orchestrator.ts:341` `ctx.sessionProjections.stateOf(session, key)` | alpha.2 里 `@deprecated`，返回 `unknown`；登记释放函数仍兼容 | 能跑。正式版若移除，改用 `await register()` 拿到的 `handle.stateOf(session)` |
| `plugins/plugin-archives` 读 `sessionProjectionCache` | 两个版本的类型里都没有这个服务名（结构读取），类型比对无信号 | 换线后实机确认归档标题仍在 |

## 5 可选增强（不修不影响运行）

1. **`WebSearchSource.summary`**：上游搜索改成优先给模型长摘要（每来源默认 800 字符封顶），
   卡片仍用短摘录。我们只回 `snippet`，不补就比内核自带 provider 弱一档。
2. **`WebFetchProvider.ready?(llmProvider)`**：凭据就绪探测，上游用它在缺少凭据时不向模型提供工具。
3. **六个新语种**（ja / es / fr / de / ru / pt-BR）：我们插件字典只有 zh/en，用户切到这些语言时
   套件界面会回落到 zh 或 en。

## 6 产品层重叠（要产品决定，不是适配）

1. **上游 Discover 的「自定义插件索引」**（由「自定义插件市场」改名，读用户添加的 index 文件）
   与 `plugin-market` 的边界重叠。社区市场 `dsh-market` 推荐添加的那条 jsDelivr 索引
   （`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）正是喂给这个入口的；
   我们在 v0.17.9 刚把同一份索引做成自己的默认目录源。
2. **实验性 `subagent_oar`**（把独立任务委派给本机 Codex / Claude CLI）与 `plugin-swarm` 的 batch 职责相邻。
3. **实验性「开发者工具-统计」**（轮次/步骤的上下文、缓存、模型与工具耗时）与 `plugin-usage` 部分重叠。
4. **Web Fetch 不再拒绝非公网地址**（代理与内网可用，部署方自行限制）。我们 websearch 的
   fake-IP 安全层与市场的地址策略都是我们自己的实现，不受影响；但按旧契约写的注释与假设要重读一遍。

## 7 正式版发布时的执行顺序

1. `node scripts/kernel-line.mjs --resolve` 先确认目标版本在 `next`/`alpha` 上确实存在。
2. CI 的 Node 提到 ≥24.9（独立一步，避免构出 v22 产物）。
3. 20 个 `package.json` 换 spec + cordis/schemastery 换 `~` 预发布；清根与全部插件的
   `node_modules`/lockfile，按 根 → 插件顺序重装（保留旧 lockfile 会 ERESOLVE）。
4. 源码：plugin-rewind 两处（第二泛型 + 删废弃增强）。
5. `npm run typecheck` → 19 插件 `build` + `test` → 根 `npm test` → `check:graph` →
   `check:suites:gate` → `runtime:build` → `probe-swarm-team-prompt` /
   `probe-team-section-mount` / `probe-routes.cjs` / `probe-workbench.cjs` → `smoke-suite`。
6. 真机 M1–M5 + 渲染面每插件判定表（`agents/kernel-line-regression.md` §6）。

## 8 未验证项与风险

- **没有真的安装、没有启动过 alpha.2**：本地没有该内核树，「能不能起来」是类型与载荷层面的
  推断，`[待验证]`。
- **客户端组件 props 契约没比全**：那些 `.d.ts` 在 `lib/client` 下，不在 `lib/types`，
  是仓库自己记录的「渲染面盲区」。只能靠 `probe-routes.cjs` / `probe-workbench.cjs` 在真实
  换线后确认。
- **office 载荷只比了类型**，没比 LibreOffice 引擎的运行时行为。
- `dsh-tools` 的载荷改动最大（29 个 `lib/` 文件、18 新增 / 12 删除），而「按步骤条件启用工具」
  与「原生 / PTC 执行拆成 Agent 作用域插件」这两条只影响 `tools.mode` / `DSH_TOOLS_MODE` 与
  `resolve`/`executable` 使用者 —— 我们两样都不用，所以判为无影响；这是**按调用点推断**，
  不是按运行时验证的结论。

---

## 9 rc.1 复核与执行（2026-11-04）

> 上面 §0–§8 的结论针对 `0.2.2-alpha.2`。rc.1 是这条线的第一个 RC，本节记录「与 alpha.2 相比要做什么」
> 以及本轮的执行结果。执行记录归档在 [`../archive/kernel-line/kernel-0.2.2-rc.1-upgrade.md`](../archive/kernel-line/kernel-0.2.2-rc.1-upgrade.md)。
> **上游没有 `docs/upgrade-guide/v0.2.2-rc.1/`**（指南是事后补写的，0.2.1 线就补过 14 篇回填），
> 所以本节全部结论来自逐包载荷比对 + 我们 import 的符号的声明比对，不读指南。

### 9.1 事实 `[实测]`

```
dist-tags: next = 0.2.2-rc.1, latest = 0.2.1-rc.5, alpha = 0.2.2-alpha.3
engines:   node >= 24.9.0（与 alpha.2 相同）
vendor:    cordis ~4.1.0、schemastery ~3.19.0、loader ~1.1.0、timer ~1.2.0 —— 从预发布转为稳定 minor
alpha.2 → rc.1：466 个提交（发布提交只改版本号，vendor 转正单独一条）
载荷（rc.5 → rc.1，40 包）：34 改 / 4 相同 / 2 不在该线（cordis、schemastery 各走自己的版本线）
我们 import 的符号：23 个包，0 丢失，15 个声明有变
```

### 9.2 与 §3「必改项」的差异

| §3 的预判（alpha.2） | rc.1 的实际 |
|---|---|
| 全量换线 20 个 manifest | 成立：404 处 `^0.2.1-rc.5` → `^0.2.2-rc.1` |
| cordis / schemastery 必须写 `~` + 预发布字面量 | **不成立**：rc.1 里它们是稳定 minor，`^` 已能覆盖。仍写成 `^4.1.0` / `^3.19.0`，让声明等于我们被测过的组合 |
| Node ≥ 24.9 是发布阻断项，CI 五处要提 | 成立，已改成 `'24.9'`（钉 floor，不只提 major） |
| 唯一源码改动 = 会话投影两处 | 成立，且仍是**唯一**的源码适配——但实际是三处：`ProjectionDefinition` 的第二泛型、删 `SessionProjectionStateMap` 增强、以及 `register` 返回值从 disposer 变成 `ProjectionHandle`（后者只有 type gate 能看见，见 9.5） |
| （未列出） | **新增一类**：内核包把兄弟包声明成 peer，见 9.3 |

### 9.3 rc.1 新出现的一类：内核 peer 不在我们的安装约定里 `[实测]`

`dsh-session` / `dsh-tools` 的运行时代码 import `@deepseek-ai/dsh-scope`，`dsh-subagent` 还 import
`dsh-attachment` / `dsh-util-time`；这三个包在各自 manifest 里都是 **peerDependencies**。
本仓插件的安装约定是 `npm install --legacy-peer-deps`，**不装 peer**，于是：

- 插件的测试 harness 用 esbuild 把内核包一起打包（没有 `external` 列表）→ 9 个插件的套件在建包阶段
  就报 `Could not resolve "@deepseek-ai/dsh-scope"`；
- 另几个在运行期 `ERR_MODULE_NOT_FOUND`（`plugin-pdf` 的六条 e2e 全红）。

处置：在这些插件自己的 `devDependencies` 里显式声明这些内核 peer（`dsh-scope` 12 个插件 + 根，
`plugin-swarm` 另加 `dsh-attachment` / `dsh-util-time`）。这与套件既有约定一致：
**测试期要能解析的内核 peer，也要出现在 devDependencies 里**。

### 9.4 一处测试钉在旧线上 `[实测]`

`plugin-workbench/tests/create-entry.test.ts` 把 primitives 的 peer/dev spec 写成 `'^0.2.1-rc.5'`
再比较。已改成从根 manifest 读当前跟随的线（`@deepseek-ai/dsh-session` 的 spec）并断言相等：
换线不再造成假失败，真正的偏差仍然会红。

### 9.5 本轮执行结果 `[实测]`

- 19 个插件：`npm install --legacy-peer-deps` + `npm run build` 全成功；套件 19/19 PASS。
- **build 全绿不等于适配完成**：`ProjectionHandle` 那一处（§9.2 的第 4 行没有预见到）只有
  `plugin-gates` 的 type gate 能看见，因为 esbuild 不检查类型。换线后必须跑 type gate。
- 另修两条**根测试**：`runtime-kernel-pin` 用路径前缀匹配 `@deepseek-ai/dsh*`，把嵌套的
  vendored 包（cosmokit 1.9.0 / schemastery 3.19.0）读成了第二个内核版本——改成按**包名**匹配，
  并改成直接 import `scripts/kernel-line.mjs` 的共享 resolver（那条规则原来有两份拷贝）；
  `kernel-surface` 拿 `dsh-atomic-write` 当「已安装包」样本，而 rc.1 起它不再是根树的传递依赖，
  换成根 devDependency 里的 `dsh-session`。两条都是**测试自身的口径**问题，不是产品缺陷。
- **同一个前缀匹配 bug 也阻塞了构包**：`npm run runtime:build` 直接拒绝（
  `resolved 3 different @deepseek-ai/dsh* versions`）。它在 `scripts/kernel-line.mjs` 里，
  修法同上（按包名匹配）。这条说明「测试失败」有时是产品代码的真 bug，只是先被测试撞见。
- 根套件、`plugin-gates`（19 个插件）、`check:graph`、`check:suites`：见 `scratch/kernel-0.2.2/verify2.log`。
- `plugin-rewind` 0.1.9 → 0.2.0（单位数规则：9 进位到 minor）。

### 9.6 仍未验证（与 §8 相比没有减少的部分）

- **真内核已验，真窗口未验**：`npm run runtime:build -- win32 x64` 构出 0.2.2-rc.1 的 runtime
  （`runtime-dist/dsh-runtime-win32-x64-0.2.2-rc.1.tgz`，119.2 MB / 23556 文件，node 24.21.0），
  解到 `scratch/kernel-0.2.2-rc.1/runtime` 后 `npm run verify -- --runtime <该树>`
  **`smoke: all checks passed`**——19 个套件插件在真内核里全部激活、路由与打包资源都应答。
  但仍然**没有跑过 `npm run dev` 的窗口**：客户端渲染面（`dsh-client-ui-primitives` 45 个文件改动、
  rc.1 新增 `settings.section.icon` 槽与我们自己注入图标的方式是否冲突）只能真机看设置页。
- **office 载荷**：仍只比了类型；新构的 `office-payload-win32-x64-0.2.2-rc.1.tgz`（70.5 MB，
  引擎 0.1.2）没有在应用里实际装过、也没有跑过一次转换。
- **可选增强**：`WebSearchSource.summary` 未补（比内核自带 provider 弱一档）；`MenuItemButton.disabledReason`
  未用（可把「为什么不能点」说出来）。

### 9.7 下一轮的前置检查（新增，写进流程）

换线前先算一次「内核 peer 差集」：取目标线里我们 devDepend 的内核包，读它们的 `peerDependencies`，
与插件树里实际存在的包求差集；非空就是 9.3 这类失败——它在建包/运行期才出现，类型检查看不见。
