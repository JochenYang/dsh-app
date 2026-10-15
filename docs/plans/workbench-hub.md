# 工作台容器：可扩展的领域工作台入口

- Status: active
- Plan date: 2026-10-14

**证据标记**：`[实测]` = 命令真跑过；`[静态]` = 源码阅读。运行时证据都来自真实内核
（dsh 0.2.0-rc.2 的 runtime tarball + 原样 overlay），临时 harness 在
`scratch/probe-panellist/run.cjs` 与 `scratch/probe-workbench-page/run.cjs`。

## Goal

在 dsh-app 内建一个「工作台」：侧边栏顶部一个入口 + 一个整页容器，**领域工作台通过座位注册进来**
即可出现，新增一个领域不需要改容器的代码。

成功标准：

1. 侧边栏顶部出现「工作台」，排在「插件」之上，点击进入容器页；
2. 域卡片能从工作台进入对应的工作台——面板型在容器内换视图，会话型一步进入工作区并回到 Conversation；
3. 新增领域只改域插件，容器代码不动；
4. 本轮的回归闸门全绿，且有一条可复跑的运行探针守住第 1、2 条。

## Scope

- Must-have：容器插件（侧边栏座位、容器页、**两个**扩展座位、两种入口形态）、空态、键盘可用性、
  五处 roster 同步、版本号与 changeset、插件自带测试、一条永久运行探针。
- Out of scope（本轮不做）：任何真实领域工作台的业务实现与其源码移植；域插件的宿主路由改造；
  游戏类预览的来源隔离；不经 npm 包的热加载式域发现；修改内核源码。

**座位数从三个收敛到两个**（原 W4 还声明 `workbench.item.status`）。理由不是省事，是它在座位模型里
不可实现：只有声明者可以渲染一个座位（`boundRenderSlot` 对不在自己 `children` 里的 key 抛
`SlotOwnershipError`），所以「卡片自己渲染 status 座位」这条路不存在；而容器**无法把节点插进卡片内部**
（`renderSlot` 返回 Fragment，没有逐条目包装点），所以容器声明的 status 座位只能渲染成宫格之外的一排，
不是「卡片上的徽标」。卡片自己的状态文案属于卡片自己的内容。

## 事实基线 `[实测]`

- 侧边栏顶部那几行是 root 作用域的 `sidebar.panellist` list 座位：每项给 `id`、可选 `order`
  （缺省 0，升序排）、`label`（字符串或随语言变化）。**同一个 `id` 指定布局 root 作用域 `main`
  keyed 座位的页面组件**；该 key 未注册时 `ctx.layout.selectPanel(id)` 抛错并保留当前选中态。
  证据：`@deepseek-ai/dsh-client-ui-sidebar/README.zh.md:38`、
  `.../dsh-client-ui-sidebar/lib/client.js:454-469`、`@deepseek-ai/dsh-client-ui-layout/README.zh.md:32`。
- 内核自带两个占位者：「插件」`order: 0`（`dsh-client-ui-plugin-manager/lib/client.js:3769-3775`）、
  「自动化任务」`order: 10`（`dsh-client-ui-schedule/lib/client.js:6805-6810`）。
- 本插件取 `order: -1`。实测按钮顺序 `["工作台","插件","自动化任务"]`，工作台 `rowIndex: 0`。
  `-1` 而不是更小的负数：任何负值都排在 0 之前，而平手会退回注册顺序，本插件注册在内核之后。
- **行的定位只能靠 `aria-label`。** 侧边栏那一行**没有 `data-slot` 属性**（实测属性名只有
  `["type","class","aria-label"]`），行是 `nav[aria-label="全局面板"] > button[aria-label=<label>]`。
  折叠状态下可见文字不渲染但 `aria-label` 还在。→ 注册时的 `label` 是稳定接口。
- **`main` 是 keyed 座位，且只渲染选中的那个 key**：帧用
  `renderSlot("main", {}, { entryKey: panelInfo.activePanelId ?? "conversation" })`
  （`dsh-client-ui-layout/lib/client.js:118`）。所以离开工作台即**卸载**容器页，页面内的
  `useState` 天然归零。实测（在已挂载的页元素上打 expando token）：面板内三次状态切换 token 不变；
  `selectPanel(null)` 后页面从 DOM 移除；再回来是全新元素且显示宫格。
- **`renderSlot` 会把每次调用包进一个 `display: contents` 的锚点**，锚点带 `data-slot=<座位名>`。
  `display: contents` 的元素不生成盒子，所以**在锚点上设边框/内边距/背景会被丢弃**——实测锚点承载了
  这些值而它的盒子是 0×0，卡片身上全是 0。因此卡框必须落在锚点的子元素上，且该属性是渲染器的实现细节
  （全仓库只有本插件读它），不是文档化约定。一个条目渲染多个根元素会画出多个带框的盒子。
- **套件插件里 `ctx.get(name)` 的服务必须按调用时解析。** 实测：`inject` 里没声明的服务在 apply
  阶段是 `undefined`，到页面渲染时才就位。仓库已有同款写法：
  `plugins/plugin-client-ui/src/client/workspace-launch.ts:74-84`。
- 会话形态的导航已跑通：`ctx.get('workspaces').create({path}) → ctx.get('uiWorkspace').openWorkspace(id)`
  返回成功，侧边栏工作区列表新增该目录并把当前工作区切过去。
- 反向对照也跑通：把 `main` 注册去掉后点击，得到
  `layout.selectPanel: main panel "..." is not registered`，中栏不变、没有任何行被标为
  `aria-current="page"`。抛出点在 `dsh-client-ui-layout/lib/client.js:463`。
- **`sidebar.panellist` 的 `id` 只被类型化成开放 `string`**，而它同时是 `main` keyed 座位的 key：
  两者不匹配时没有任何静态检查会响（类型门跳过未安装的 layout 包；`check:slots` 只比对座位名）。
  → `PANEL_ID` 导出并被两处共用。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | 新建 `plugins/plugin-workbench/`：`package.json`（`dsh.client.inject` + `platform: web`、`main`/`exports`/`files`）、`build.mjs`、`tsconfig.json`、`icon.svg`、`locale/{zh,en}.json`、`src/index.ts`、`src/client.ts`。同时改五处 roster：`plugins/dsh-app.patch.yml`、`scripts/kernel-line.mjs` 的 `SUITE_PLUGINS`、`src/main/brand-suite.ts` 的 `SUITE_PLUGIN_DIRS`、`scripts/smoke-suite.mjs` 的 `SUITE_DIRS`、`.github/workflows/release.yml` 的预构建循环。外加快照表 `test/type-escape-ratchet.test.mjs` 的 `BASELINE` | [x] |
| W2 | P0 | 侧边栏入口：`sidebar.panellist`，`id: PANEL_ID`、`order: PANEL_ORDER`（-1）、`label` 走本插件字典，外加一个自绘的 16 单位方块图标 | [x] |
| W3 | P0 | 容器页：`main` keyed 座位 `key: PANEL_ID`（导入 W2 导出的常量）。页头按内核入口页范式——居中 `max-width: 960px`、两侧 `clamp(24px,4vw,48px)`、底部 48px、darwin 下 `padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px))`；只用 `--dsw-alias-*` token。正文是域卡片宫格 | [x] |
| W4 | P0 | 两个扩展座位：`workbench.item`（list，root，owner props `{ openView }`）、`workbench.view`（keyed，root）。第三座位 `workbench.item.status` 按 Scope 的理由放弃 | [x] |
| W5 | P0 | `panel` 形态：点卡片后在同一面板内渲染 `workbench.view` 里该 key 的组件；**重置靠卸载**（事实基线两条）而不是订阅 `panelInfo`，返回按钮也回到宫格 | [x] |
| W6 | P0 | `session` 形态：`src/client/entry.ts` 的 `createWorkspaceEntry(ctx)` 按**调用时**解析 `ctx.get('workspaces')` / `ctx.get('uiWorkspace')`，空路径 → `error:invalid-argument`，服务缺失 → `pending`，失败取 `code` 或 `rpcError.code`，**永不 reject**；`entryMessage` 把问题 token 翻成容器文案（`invalid-argument` 与宿主的 `workspace/invalid-path` 各有专门句子，其余保留 code 作诊断）。计划里「已在册就直接打开」由宿主满足——它的 `create` 是 create-or-resolve，实现无须自己查 | [x] |
| W7 | P1 | 空态：没有域卡片注册时显示空态文案，由座位的 `fallback` 承担（随 W5 落地）。后半句「会话形态没有可用工作区时给出添加工作区的路径」**不适用**：容器不掌握任何目录，目录是卡片自己的选择，容器只在失败时给句子 | [x] |
| W8 | P1 | 键盘可达：容器自己的控件全是真 `<button>`（实测 `tagName: BUTTON`、`tabIndex: 0`、`:focus-visible` 有显式样式）；进入域视图时焦点落到视图区域（否则卡片卸载后焦点掉到 `body`）；Escape 回宫格，用 document 级监听（套件弹窗同款写法），真内核实测通过。宫格内的委托式导航见 W18 | [x] |
| W9 | P0 | 字典：本插件自带 zh/en 两张表；Han 字符只出现在该表内（仓库规则：只有 `src/shared/locale.ts` 与各插件自己的字典可以放 Han 字符） | [x] |
| W10 | P0 | 测试分两层说清了：插件单测（`tests/*.test.ts`，22 条）守**注册面与入口 seam** —— 两条注册项的 id/order/label/locale/组件/子座位、`viewIds` 的实时读取与跳过不可寻址条目、样式注入恰好一次、字典键集、`createWorkspaceEntry` 的 8 个分支；**页面渲染那一层**（宫格、空态、离开面板重置、会话入口三事实、卡框落点）由内核探针 `scripts/probe-workbench.cjs` 的 A2/A5/B1–B3/A3b 断言 —— 那是更强的证据层（真内核、真座位注册表、真 DOM），不重复写一遍 jsdom 单测 | [x] |
| W11 | P1 | 永久探针：`scripts/probe-workbench.cjs`（Electron 型，自己解 `runtime-dist/` 的产物、把容器与走查插件链进被启动 profile 的两个 `@dsh-app` scope、跑 **49 条断言**并按失败数设退出码）。走查插件落 `scripts/fixtures/probe-workbench/`（先例 `scripts/fixtures/minimal-mcp-server.mjs`）。重跑时机登记在 `AGENTS.md:124-128` 与 `docs/agents/kernel-line-regression.md:309-314`。搬运时修掉三个真缺陷：崩溃会退 0（`finally` 先于 catch）、固定 sleep 在被验证的时序上、内核首次运行弹窗期间整页 `inert` 导致焦点断言假红 | [x] |
| W12 | P0 | 版本号（`0.1.0`）与 changeset（`changesets/workbench-hub.md`，`shell: patch` / `plugins: plugin-workbench`，正文含容器页与会话形态） | [x] |
| W17 | P2 | 描述性名单与当下计数的收尾同步：`plugins/AGENTS.md`（含插件名单本身）、`docs/agents/testing.md`、`docs/agents/build-and-release.md`、`README{,.en}.md`（能力表补工作台一行）、`scripts/lib/plugin-gates.mjs`、`scripts/plugin-gates.mjs`、`scripts/kernel-line.mjs` 头注释、`docs/agents/kernel-line-regression.md:12`、`docs/desktop-optimization-plan.md:575`、`scripts/main/suite-layer.ts` 的当下计数。**当下测量值改成不写死数字**（例如「476 个 import」），**历史计数一律保留**（`CHANGELOG.md`、带日期的轮次记录、`suite-layer.ts` 里描述旧迁移残留的 SEVENTEEN） | [x] |
| W18 | [–] | 宫格内的**委托式**方向键导航（`Home`/`End`/Enter）。本轮不做：眼下没有任何域卡片可导航，而卡片契约的漂移测试也要随第一张真实卡片落地——两者一起做才有东西可测。容器**可以**做（套件自己的维护设置容器就在别人注册的贡献上做了完整 roving focus：`{ only }` 逐条渲染 + 订阅式账本 + 委托 keydown），这是「可做而未做」，不是「做不到」 | [–] |
| W19 | [ ] | **开放工作台给用户自建**（产品方向，你提出）：把「用户自己设计一个工作台并导入使用」做成插拔式。**架构已经支持** —— 容器只认两个座位，任何插件注册一张卡就出现；先例是 `dsh-context`（第三方插件加侧边栏行）与 `plugin-market`（走内核 CLI 把第三方插件装进被启动的 profile）。**缺三件**：① 一份**可 import 的契约包**（types-only，导出 owner props 接口 + 两个 SlotMap 合并）—— 现在卡片作者必须**逐字手抄**那块 `declare module`，抄错一个字段两边都能编译、卡片会在 outlet 的错误边界里静默消失（Risks 10）；② **发现面** —— 用户无法知道有哪些工作台可装，容器的空态正是它的落点（市场目录加一个 tag/分类，空态里列「可安装的工作台」）；③ **能力与信任的诚实说明** —— 卡片/视图跑在 app 的文档里、**同源、同一棵 React 树，不是沙箱**；而容器交给每张卡两个能力，其中 `enterWorkspace(path)` 会**不经用户确认**地把任意目录登记为工作区（内核自己的选择器要求用户挑目录）。建议把 `enterWorkspace` 改成走用户选择而不是卡片传路径，但那是已建好的东西的设计改动，要单独定。**明确不做**：工作台的声明式 DSL / JSON 卡片格式 —— 座位就是 React 组件，声明层表达不了真工作台（那个插件的客户端半边 6k 行），那会是第二个更弱的契约。**现成的样例已经存在**：`scripts/fixtures/probe-workbench/` 就是一张能跑的真卡片，可以直接当参考实现 | [ ] |
| W13 | [x] | 后续弧 2：路由层能力探针（`scratch/probe-routes/probe.cjs`，**18 项断言 / exit 0**，从页面里发请求以满足载体的浏览器认证）。**三问的结果，附组合限定**：探针启的是 **CLI/`dsh web` 形态**（`dsh/lib/bin.js --profile … --patch …`），而 shell 真机启的是 `dsh-desktop-host/lib/index.js` 的**位置参数**形态、且不传 `--patch`（`src/main/desktop-host.ts:387-389,641-661`；`--patch` 在 `src/` 里零命中）——**两套组合不同，所以第三问只在该组合下成立**。① Connection 载体 **exact-only** —— 注册 `/…/tree` 后 `/tree` 200、`/tree/a/b/c.js` **404**（实现同此：`fetchRoutes.get(url.pathname)`，运行树 `dsh-client-connection/lib/index.js:611,616`）；② **载体不剥 `Range`、不改写响应、不缓冲** —— `Range: bytes=0-3` → **206** + `content-range: bytes 0-3/10` + body `ABCD`（这三个头是 fixture 自己设的，载体只是原样送出，别读成载体自带 Range）；流式也在（三块 402/837/1236 ms，自定义头存活）；③ **`webServer` 存在**且 `kind:'prefix'` 服务深层子路径（`/probe-tree/a/b/c.js` → **200**），`ctx.get('webServer')` = `{ctor:'WebServer', port:5858, register:fn}`，`inject:['connection','webServer']` 的插件正常激活。**结论（措辞已收紧）**：该插件的路由层**技术上**不必重写；但「可以照做」不成立 —— 套件约定要求宿主路由走 Connection 载体（`plugins/AGENTS.md` 第 6 节），改用 `webServer` 是**破例**，属 W14 的待决策项 + 安全评审，不是 W13 的结论。**未测（决定了下一步）**：真机 `dsh-desktop-host` 组合下的同一批请求；以及「`webServer` 路由在 Connection 栅栏之外」这条 —— 探针的请求**全部同源且带页面 cookie**，从未发过无 cookie / 异源请求，所以那句是**断言不是测量**，测出来之前不能拿它改写安全不变式。**这两项已由后续探针补上，见下** | [x] |
| W13b | [x] | **真机组合实测**（`scratch/probe-desktop-routes/probe.cjs`，**21 项断言 / exit 0**）：走的是 shell 那一套 —— 入口 `dsh-desktop-host/lib/index.js`、`webShapeArgs` 同组位置参数（`--expose-internals <entry> <app> <profileDir> <runtime> <pnpm> <node>`，**无 `--patch`**）、`stdio` 含 `ipc`、URL 从 `ready` 消息拿、cookie 用 shell 自己的 `authenticateHostWeb` 换；组合由 shell 自己的代码铺（`prepareBrandSuite({layer:true})` + `installSuiteLayer`，层内容与真机 profile 里那份**逐字节相同**）。**四问的答案**：① `inject:['connection','webServer']` 的插件**激活**（`serviceCtor: 'WebServer'`, `port: 19387`, `register: fn`）；② `ctx.get('webServer')` 有值；③ `kind:'prefix'` 服务深层子路径（`/probe-tree/a/b/c.js` → 200，且 handler 自己的记录证明是它跑的，不是静态回落）；④ **栅栏问题测出来了**：同一条 prefix 路由，**无 cookie → 200**、带 `Origin: https://evil.example` → **200**；对照 `/api/…` 的 Connection 路由：无 cookie → **401**、带 cookie + 异源 Origin → **403**、带 cookie + 同源 → 200。即**栅栏不在服务器上，而由路由的拥有者各自施加**（`dsh-host-webserver` 的 `handle()` 零鉴权直派；`/api` 的 401/403 来自 Connection 的 `admit()`）。**结论**：W14 若要为资源树破例用 `webServer`，代价是那条路由**对回环端口上的任何进程开放、且不校验来源** —— 我的建议因此从「可考虑破例」转为**不破例**，资源树改走 shell 自持的第二个来源（W16 方案 A），那条来源可以带能力令牌。**证据源已转正**：本节与 W13 的观测现在由永久探针 `scripts/probe-routes.cjs`（32 项断言，**本轮新增 S6 段后升到 41 项**）守，前身留在 `scratch/probe-routes/` 与 `scratch/probe-desktop-routes/` 供追溯 | [x] |
| W14 | [ ] | 后续弧 3：域插件宿主半边移植。**已量的规模**：15 个顶层 `.ts`（2,638 行）、24 个 peer 依赖、`inject = ['skills','subagents','tools','typert','webServer']`。**W13 定下的路线**：路由层**原样保留**（一条 `kind:'prefix'` 路由 + 内部 pathname 分派），因为 Connection 载体 exact-only 而它要服务一棵资源树。要做的：① 把 peer 范围对齐到跟随的内核线（`^0.2.0-rc.2`）；② 逐条过四道插件门禁（import / type / presence / freshness）；③ 核对它用到的内核面（`ctx.skills`、`ctx.subagents`、`ctx.tools`、`ctx.typert`、`ctx.webServer`）在跟随线上是否同名同形；④ **已由实测给出建议：不破例** —— 真机 desktop-host 组合实测显示 `webServer` 路由**对回环端口上任何进程开放、且不校验来源**（无 cookie → 200、`Origin: https://evil.example` → 200），而 Connection 的 `/api` 路由是 401 / 403；所以资源树改走 shell 自持的第二个来源（W16 方案 A），那条可以带能力令牌。**最终决定仍归你**（见「W16 决策材料」与收尾项里那条过期不变式）。**已核对（`[静态]`，跟随线运行树）**：五个注入服务都在（`skills`←`dsh-skill`、`typert`←`dsh-typert-registry`、`subagents`←`dsh-subagent`、`tools`←`dsh-tools`、`webServer`←`dsh-host-webserver`），`registerProvider` 在 `dsh-skill`/`dsh-subagent`/`dsh-typert-registry` 都有；它注册的两个客户端座位（`shell.overlay`、`tool.call.toolview`）也都在（前者见 `dsh-client-ui-layout`，后者见 `dsh-client-ui-deliverables`）。**依赖范围已量**：25 个 peer 里 **20 个已经容纳 `0.2.0-rc.2`**（形如 `>=0.2.0-rc.2 <0.2.1-0 \|\| >=0.2.1-alpha.1 <0.2.2-0`），其余 5 个是非内核包（`cordis` / `schemastery` / `react` / `react-dom` / `zod`）。`check:graph` 要求 `@deepseek-ai/dsh*` 的 peer 范围与跟随线一致，所以移植时那 20 个要改成 `^0.2.0-rc.2`，5 个非内核包用套件既有的范围写法。**开工方向已定（走安全一侧）**：不破例 → 6 个固定端点按「W14 路由改写映射」改成 Connection 的 exact 路由，那棵资源树留给 W16-A。这个方向**不削弱任何东西**，所以不需要额外授权；要反过来（改用 `webServer`）才需要。**宿主半边的内核接触面已清点**（按 import 计）：`dsh-tools`(5)、`cordis`(5)、`dsh-subagent`(3)、`dsh-session`(3)、`dsh-skill`(2)、`dsh-llm`(2)、`dsh-fs`(2)、`schemastery`(1)、`dsh-util-values`(1)、`dsh-typert-registry`(1)、`dsh-sandbox-policy`(1)、`dsh-agent`(1) —— **`dsh-host-webserver`(2) 随路由改写消失**，所以移植后少一个内核面。**移植时的一条硬约束（本轮量到）**：`@deepseek-ai/dsh-client-store` **不在 0.2.0-rc.2 的运行时闭包里**（`runtime-dist/runtime-files-win32-x64.json` 与运行树都没有它，另外三个 inject 目标都在）。今天无害 —— 客户端运行时对「没有 graph row」的 inject 名字直接跳过（`dsh-client-modules/lib/client.js:656`）—— 但**移植后的客户端半边不能真去 import 它**，否则 bundle 会 require 不到。要么改成不依赖它，要么那条线把它补进闭包。顺带记一条：**`dsh.client.inject` 里的名字没有任何静态门禁校验**（既不必在闭包里，也不被 `check:graph` 检查），所以这个坑只能靠人记住。**另一条耦合**：名册一变，所有「真运行时产物 + 工作树 overlay」的探针都会红（运行时的 `@dsh-app` 少一个），必须 `npm run runtime:build` 之后再跑 —— 本轮就是如此。**骨架已建**：`plugins/plugin-creative@0.1.0`（暂定名）已入册（20 个插件，`check:suites:gate` 报 `20 distinct names / no drift`），两个半边都是空 `apply`，四道插件门禁 + `check:slots`（56/21/0）+ 根套件（681/679/0/2）全绿。**路由层已改写（本轮）**：源那份 41 KB 的 `workspace-route.ts` 落成 `src/workspace-route.ts`（855 行），**5 条 Connection exact 路由**覆盖 6 个端点（`/file` 的 GET+POST 必须是**同一次 register** —— 载体按 `fetchRoutes.get(pathname)` 分派，同 path 注册两次在装载期抛 `already registered`）。**只换传输层**：`send` 返回 `Response`（响应头照原样、**不设 `content-length`**，由载体算）、`sendMediaBytes` 返回带 `content-range`/`accept-ranges` 的 `Response`、`jsonBody` 改用 `request.text()` + **显式字节上限**（`request.json()` 无法在解析前施加上限），而 `parseByteRange`/`mediaHeaders`/`assertCreativePath`/`mediaMimeTypeForPath`/`listFiles`/`readVersionedFile`/`workspaceRealm*` **原样保留**。**`workspace-request-trust.ts` 判定多余、不搬**（载体的 `isTrustedApiRequest` 与源的检查逐行等价，且 `/api` 在派发前先 `admit()`；实测带 cookie 是插件自己的 400、去掉 cookie 是 401），`Config.trustedHosts` 一并删除。`inject` 加 `connection` 与 `typert`（后者是 `workspaceRealmForSession` 取 agent 的唯一途径）。**三处已登记的偏离**：① 本地文件分支改 `Readable.toWeb(createReadStream(...))`，**流中途 I/O 错误的表现变了**（源 `response.end()` 截断，现在表现为响应体错误 —— Fetch 无法在头写出后改状态）；② `bundledGameExample()` 加了存在性判断（源假设 `examples/` 随包发布，本包刻意不随包，原样搬会让 `/workspace` 每次 ENOENT → 500）；③ `game-preview/**` 整棵树没搬（归 W16），因此 `/workspace` 的 `previewUrl` 现在是**死链**、答 404。`video-project.ts` 与 `game-verification.ts` 因此**真的进了产物**（`lib/index.js` 里 `summarizeVideoProject` ×2、`WorkspaceVerificationTracker` ×2）。版本 0.1.2 → 0.2.0，3 个新 peer+dev，新 changeset（`shell: none`），四处写着「路由层未落地」的文档更正。**测试 30 → 66**（新增 `tests/byte-range.test.ts` 纯函数 149 行，先于传输层改写；`tests/routes.test.ts` 496 行路由级）。**它自己加了一条更硬的端到端证据**：复制探针并追加 S6 段，在真内核 + 桌面宿主形状下请求**插件自己的路由** —— `/workspace` 带 cookie 无 sessionId → 插件自己的 400、无 cookie → 401、`/video-preflight` → 200 带真实能力探测（python 3.14.6 / ffmpeg 带 subtitles）、`/game-preview/...` → 404，6 条断言全过、`RESULT: PASS (38 checks)`。**已转正（本轮）**：S6 段并入永久探针 `scripts/probe-routes.cjs`（副本留 `scratch/`），并补了三条 —— 异源 `Origin` → 403、载体自己的 404/403 体是**纯文本**（`not found` / `forbidden`，正是 P2② 那条变更的实测），探针由 **32 → 41 项断言**、`RESULT: PASS (41 checks)` / exit 0（我裸跑复跑）。**未覆盖**：`drama-preflight` 没有任何测试**调用**它（它会写 `knowledge/drama` 下的适配器配置并 fork Python，单测里跑它既慢又改包），只断言了注册形状。**业务源码一行未移，其余 21 个 peer 与 `export const inject` 等对应源码落地时再加。宿主半边已移植（本轮）**：13 个模块 / **1,921 行**（审查实测；我原先记的 2,158 是错的）；其中 **9 个**除新增模块头外与源逐字相同，**4 个**有正文差异 —— `index.ts`（name/inject/去掉路由层）、`skill-provider.ts` 与 `role-provider.ts`（五个 `default*Root()` 改指插件根下的 `knowledge/`）、`role-tool.ts`（收窄 + 去掉一处 cast）。抽查 `host-python.ts`：39 → 49 行，其余零 diff。`inject` 收敛成 `["skills","subagents","tools"]`（`typert` 与 `webServer` 只被路由层用到）；`role-tool.ts` 里两处 `as unknown as` **去掉一处**（把 `resultText` 收窄成 `readonly JsonValue[]` + 运行时判型），**保留一处并给出了 TS 无法收窄的证明**（`ToolRemovalBlock` 没有字符串索引签名），棘轮基线因此 0 → 1 并附理由。**三处偏差已记**：① `video-project.ts` 与 `game-verification.ts` 只被路由层 import，所以 esbuild 从 `src/index.ts` 出发时它们**不进产物**，要等路由那轮才活；② `video-project.ts` 在**宿主半边**持有创作者可见文案（`原片`/`剪后片`/`最终成片`），违反「宿主半边只发 `HostText` 不发散文」这条 —— 改成发码，**改期到客户端那轮**（本轮只换传输层，未发码；计划原先把它排在「路由那轮」，本轮改期并在此记录）；③ `loadBundledRole` 抛的是裸 `ENOENT`，成因埋在栈里一行深，值得换成「随包资源未打包」这类具名错误。**当时的阻塞**：`apply` 会**急切**读七个随包 Role 的 markdown 与四个 Skill 正文，资产没搬 → 真内核里 `1 entry did not activate`（任何链了本套件的 profile，含用户真实 profile，都会看到这条告警）。修法是搬资产，见下一段。**独立审查（reviewer，2026-10-15）的结论**：4 条 P2 + 若干 P3、**无 P0**，「假性完成」与「冗余引入」均不成立 —— 端点映射无遗漏、`/file` 单次注册的依据被逐行核实（抛出点在载体 `:633`）、纯逻辑确实逐字保留、三处偏离都真实存在，且**偏离①比模块头原先写的更轻**（载体 bridge 不 catch，宿主 webServer 记一条 warn 并 `destroy()` 连接，不是挂死；源是 `response.end()` 截断）。**4 条 P2 已全部在同一提交内闭合**：① `video-project.ts` 发码**改期到客户端那轮**（计划已改并记录，原先排给「路由那轮」）；② 未登记的 **404/403 响应体形状变化**（载体答纯文本，源答 JSON）加进模块头与 changeset；③ 载体**整份缓冲**请求体的峰值代价记进模块头、changeset 与「路由改写映射」表；④ 测试的 `call` 改成**走载体的路径/方法回落**（原先的 game-preview 用例只是读注册表，属推断）。**有意接受的 P3**：不给流挂 `error` 监听把错误打进插件 logger（只把注释措辞改准，理由是收益小于新增代码）；`drama-preflight` 仍无测试**调用**它；`bundledGameExample` 的容忍边界仍是「单文件缺失」而不是「整棵树缺失」。 | [x] |
| W14b | [x] | **知识资产**（已落地，激活阻塞解除）。搬入 `knowledge/` 下的四个域目录：**803 文件 / 8.40 MiB**（写作 366/4.45、短剧 243/2.09、视频解说 160/1.70、小说改游戏 34/0.16 MiB），与 `plugin-ppt` 同量级。**没搬** `novel-to-game/examples/**`（107 文件 / ~19 MiB，那份示例游戏的美术）—— 决定仍在你手上（见「W14 资源体积与取舍」）。**路径解析**：新增 `src/knowledge-root.ts` 的 `new URL("../knowledge/", import.meta.url)` —— `lib/`、`src/`、`.test-dist/` 都是插件根的直接子目录，所以「上一级」对三者是同一个目录；源里写 `../../knowledge/…` 是因为上游 `packages/dsh-plugin` 与 `packages/knowledge` 是兄弟目录，多出来那一跳正是 `lib/<源前缀>/roles/…` 被找出来的原因。**不做构建期拷贝**（照 `plugin-ppt/templates`、`plugin-pdf/assets` 的惯例），`files` 加 `knowledge`，版本 0.1.1 → 0.1.2。**打包后的证据两条**：`npm pack` 报 810 条目 / 803 个 knowledge 条目 / 示例美术不在；再把 tarball 解开、**从解包后的 `lib/index.js` 直接 import** 跑真实读取路径 → `PACKED-LAYOUT OK`。**新测试** `tests/bundled-knowledge.test.ts` 13 条全走真实读取路径（审查逐条核过：每个用例都真的调 `loadBundledRole`、构造那两个工具、走四个 provider 的 `list`/`get`；唯一的 `stat` 是核对 manifest 声明的路径，不是自造 fixture），并做过反例（把 `knowledge/` 改名 → 套件变红，机制是同一个 ENOENT；交付方报的「27 项失败」审查认为与测试结构对不上，我没复跑，按**未核实**处理）。**判据**：真内核探针 `RESULT: FAIL (31 passed, 1 failed)` → **`PASS (32 checks)`**，`did not activate` 归零（我自己复跑确认）。**两处留给下一轮**：① `knowledge/<源前缀>/skills/{story-long-scan,story-short-scan}/scripts/**`（11 文件 / 256 KB，CDP 榜单抓取）被**上游自己的构建排除**、且移植后的 SKILL.md 正文不再点名它们 —— 该丢，与它那 11 行 manifest 一起处理；② `novel-to-game/manifest.json` 的 107 行示例记录现在指向未随包路径（无代码读 manifest，属文档漂移；新测试把那 107 行**钉住**了，正是为了让这个未决项可见）。**一处上游自带的不一致（本移植没引入、也没修）**：删掉那 11 个脚本后，`knowledge/<源前缀>/skills/{story-long-scan,story-short-scan}/SKILL.md` 与它们的 `references/platform-*.md` 仍点名那些脚本并给出抓取命令（8 个文件 / 25 行）。上游本身就是这样 —— 它的构建排除脚本、文本照旧。运行期服务给模型的是 `DSH_NATIVE_SKILLS` 里的**原生正文**（不点名它们），所以走技能接口读不到这些命令，只有直接浏览包目录才会。**判为记录项**：改文本会偏离「逐字移植」的前提，且那是上游自己的不一致 | [x] |
| W15 | [ ] | 后续弧 3：三个非游戏域的领域工作台作为域卡片接入。**已量的规模**：客户端半边 17 个文件 / 5,978 行（含 `plugin.css`），分布是 `index.tsx` 1,961、`plugin.css` 1,242、`drama-production.ts` 411、`file-activity.ts` 386、`production-runtime.ts` 363、`drama-production-view.tsx` 346、`production-canvas.tsx` 326、`video-studio.tsx` 263、`markdown-preview.tsx` 202，其余 8 个都 ≤ 111（`jsonl-preview` 93、`production-prompts` 111、`canvas-viewport` 77、`file-tree` 67、`workbench-presence` 58、`production-intents` 40、`workbench-ui` 28、`raw.d.ts` 4）。**CSS 搬运已预检**：`plugin.css` 里 **0 个反引号、0 个 `${`**，所以可以直接进套件的 `styles.ts` 形态（`const cssText = \`…\`` + `adoptStyles()` 的 id 守卫注入，照 `plugin-presets/src/client/styles.ts`）—— 那条「template-literal CSS 里不许有反引号」的规则不会咬到它。，外加 `packages/knowledge` 的 **910 个文件 / 29 MB**（四个域的技能资产，各有 `manifest.json` 与上游 parity 脚本）—— 后者按插件 `files` 声明进产物，由 `build-runtime` 打包。接入点就是本容器的两个座位：域卡片注册进 `workbench.item`，面板型页面注册进 `workbench.view`；它现有的「会话内分栏」（`shell.overlay` + 会话作用域子座位 + portal 进 `[data-conversation-scroll]`）**保留** —— 那正是它值钱的地方（工作台贴着 Chat）。**接入形态已定**：客户端半边额外往 `workbench.item` 注册**四张卡**，每张是**会话型**：卡片向用户要一个目录（`ctx.get('remote').directoryPicker`，内核自己的工作区 UI 用的就是它），拿到后调容器的 `enterWorkspace(path)`；主区域回到 Conversation，而它自己的会话内分栏在那个会话里自动挂起来。**因此这四张卡不需要 `workbench.view` 条目** —— 域的表面是会话分栏，不是容器里的一页。**唯一待定的**：目录从哪来 —— (i) 让用户挑（便宜，推荐先做）还是 (ii) 列「最近项目」（需要一条宿主路由去扫哪些工作区里有创作文件，而它现有的 `/<源前缀>/workspace` 是会话作用域的）。**一条必须保留的原则**（读它的 `client/workbench-presence.ts:1-27`）：它**只在真的有创作文件的工作区**才占走会话布局 —— `hasCreativeProject` 看 `files` / `videos` / **workspace 来源**的 `games`（随包附带的那份游戏示例不算），且创作者可随时把布局收回（按 cwd 存的偏好，`<写作域>.workbench.<cwd>`）。它的模块头把理由写得很清楚:「DSH 是通用 Harness,一个装进来的插件不该把每个会话都变成写作界面」。**所以卡片打开一个空目录时看到的是引导页而不是工作台 —— 这是设计不是缺陷,卡片文案要说清这一点**。**客户端半边的服务面已清点**：`export const inject = ["slots", "sessions", "conversation"]`（`src/client/index.tsx:67`），三处座位注册（`shell.overlay` 一处 + `tool.call.toolview` 两处）。**唯一那处 `as unknown as` 正落在一个没有类型的 seam 上**：`(context.sessions as unknown as ISessions).binding(sessionId)` 然后 `binding.ctx.get("conversation")` 取 `send/cancel/updateQueue`（`:1933-1934`）。套件对同一件事有**文档化的替代做法**（`plugin-rewind` 的 README 写明：从**物化后的** `uiSession` binding 读，`sessions.binding(id)` 的裸 binding 不带 props、读 `props.inputActions` 会静默失败）—— 移植时**必须实测这条 seam 在跟随线上还在不在**，在就保留并把那处 cast 按结构性类型收窄，不在就改用套件的做法。这条不实测的话，编译会绿而运行时静默失效。**已实测（`[静态]`，跟随线运行树）**：`dsh-api-session-controller/lib/client.js:3480-3486` 构造的 binding 形状是 `{ sessionId, session, eventSource, ctx }` —— **带 `ctx`**；内核自己在 `:3650` 读 `reference.binding.ctx`。所以这条 seam 在跟随线上成立，客户端那轮应当把它**收窄成结构性类型**（`binding(id)` 在会话未被 retain 时返回 `undefined`，源里的 `binding?.ctx.get(...)` 那层可选链要保留）。**另一处要先定的分类问题**：`client/production-prompts.ts` 里是**发给模型的 prompt 字符串**（例如 `authorityBoundary`），它坐在 `client/` 下 —— 而 `client/` 不在汉字豁免内，字典又装不下 prompt。仓库对这类已有先例：`scripts/check-plugin-graph.mjs` 的 `ALLOWLIST` 逐文件列出并写明理由（`plugin-brand/src/routes.ts` 的「用户可见标签、没有字典可放」、`plugin-swarm/src/index.ts` 的「上游原生会话面，已知偏差」）。**建议照它办**（该文件进 `ALLOWLIST` 并写明「客户端为模型组装的 prompt，模型面文本，字典装不下」），而不是把 prompt 挪进宿主半边 —— 后者是一次真正的重构，而豁免是一条有理由的登记。**Han 规则的实际判据已查清（本轮）**：`client/` 与 `client.ts` 都不在豁免内，但 `scripts/check-plugin-graph.mjs:208` 在比对前**剥离注释**（`stripComments`），所以 Han 只在**代码**里算 —— 注释里的中文随便留。这决定移植分工：代码里的 Han 分三类 —— ① **界面文案**进本插件字典 `src/client/locales.ts`；② **领域契约字面量**（文件系统路径段 `制作成果/成片/`、`交付/${episodeName}/`、匹配模型输出的锚点正则 `任务\s*ID\s*[：:]`）**不可翻译**，留在原文件并逐文件进 `ALLOWLIST` 写明理由；③ **模型面 prompt**（`production-prompts.ts`）同上。混合文件的处置：界面文案抽进字典，剩下的契约字面量让该文件有资格进 `ALLOWLIST` —— 不做结构性重构，因为「逐字移植」是前提。**按 Han 量分布**（`grep -c '[一-鿿]'`，含注释行）：`index.tsx` 83、`drama-production.ts` 54、`drama-production-view.tsx` 49、`production-prompts.ts` 40、`video-studio.tsx` 34、`file-activity.ts` 15、`production-runtime.ts` 15、`production-canvas.tsx` 10、`jsonl-preview.tsx` 9、`markdown-preview.tsx` 3，合计 **312**（与原先记的一致）；**5 个文件零 Han**：`canvas-viewport.ts`、`file-tree.ts`、`production-intents.ts`、`workbench-presence.ts`、`workbench-ui.ts`。**切片 1 已落地（本轮）**：`src/client/{file-tree,workbench-presence,workbench-ui}.ts` 逐字移植，`workbench-ui.ts` 只改两处（前缀换成 `WORKSPACE_API_PREFIX`，其值必须等于宿主半边的 `ROUTE_PREFIX`；`endpoint` 不再拼 `/<写作域>`）。**逐字性由 diff 证实**（不是凭印象）：`file-tree.ts` 只多 17 行文件头、`workbench-presence.ts` 只改文件头、`workbench-ui.ts` 只有文件头 + 前缀常量 + 那一行 URL。**新增 24 条单测**（`tests/client-foundation.test.ts`），插件套件 **66 → 90**；`plugin-gates` / `check:graph` / `check:suites:gate` / 根 `npm test` 全绿。**已知的中间状态（写在 `src/client.ts` 的模块头里，不只写在计划里）**：这三个模块**还没有被入口引用**，所以不进 `lib/client.js` —— 座位与四张卡片落地时一起接上，在此之前由它们自己的单测覆盖。**踩到一次真坑（已修）**：测试用 `卷一`/`卷二` 做排序断言，而 `compareNames` 是 `zh-Hans-CN` 排序，拼音序让「卷二」排在「卷一」之前，按索引取值当场断言失败。改成按名字查找 + ASCII 夹具 —— 理由是 **Han 排序测的是 locale 的字典表，不是被测的 `numeric` 选项**。**下一切片**：`canvas-viewport.ts` 依赖 `production-runtime.ts` 的 `CanvasPoint`，两者一起搬（后者需字典 + ALLOWLIST 各一）；再往后 `production-intents.ts`（需新增 `@deepseek-ai/dsh-client-ui-chat` 的 peer+dev）、带字典的视图层，最后 `index.tsx` + `plugin.css` + 三处座位 + 四张卡（`.tsx` 落地时要加 `react` 的 peer+dev，照 `plugin-workbench` 的 `^18.2.0`）。**切片 2 已落地（本轮）**：`src/client/production-runtime.ts`（363 行）与 `src/client/canvas-viewport.ts`（77 行）。**逐字性由 diff 证实**：`canvas-viewport.ts` 只多文件头并把 import 扩展名从 `.js` 改成 `.ts`；`production-runtime.ts` 只有文件头、`CreativeTranslate` 的 import、**两处签名**、**那 6 句话**，其余零 diff。**这一片定下了字典模式**：`src/client/locales.ts`（NS `dsh-app.creative`、`zh` as const、`CreativeKey`、`en: Record<CreativeKey, string>`，以及 `CreativeTranslate` —— 结构上等于套件的 `Translate<CreativeKey>`，在这里声明而不是 import，因为这个模块必须能在没有 `dsh-client-ui-slots` 的情况下被引用）。**唯一的偏离是文案**，**为什么不用「返回 token」那种套件更常见的写法**：`ProductionJob.error` 这个字段同时承载上游自己的错误文本，token 放进去与真实错误串无法区分 —— 这是选参数而非 token 的实际理由，不是偏好。**3 处 Han 按判据留下**（`制作成果/成片/`、`交付/<episode>/`、`任务 ID：<id>` 锚点），该文件进 `scripts/check-plugin-graph.mjs` 的 `ALLOWLIST` 并写明理由，`check:graph` 仍 exit 0。**新增 72 条单测**（`tests/client-production-runtime.test.ts`），套件 **90 → 162**。**测试写错过三处，是测试错、代码对**（按代码的真实行为改正，并在测试里写明这是决策）：`expectedOutputs` 被满足时是 `succeeded` 而不是 `running`；按 job id 关联的 `failed` 作业**会**被它自己的成果完成（`outputPath` 那道护栏只针对共享交付物名，这是源的不对称设计）；`sequenceIssues` 在**没有** `sourceVersionId` 时说「没有选中素材」而不是「选中的没了」。**切片 3 已落地（本轮）**：`src/client/drama-production.ts`（短剧协议解析器）、`src/client/production-prompts.ts`（模型面 prompt）、`src/client/production-intents.ts`（重放已结算的生产意图）。**逐字性由 diff 证实**：`production-prompts.ts` 与 `production-intents.ts` 只有文件头 + 本地 import 扩展名（`.js` → `.ts`）；`drama-production.ts` 只有文件头、**两处签名**、**那 9 句话**。**为什么 `t` 只穿透两处**：9 条诊断全在内部的 `validateProductionProtocol` 里，四个解析器本身不发散文 —— 只有 `parseEpisodeProduction` 与它需要参数，不是我原先估的 5 个签名。**两处新的 Han 允许名单条目**（理由各自写在 `check-plugin-graph.mjs`）：`drama-production.ts`（创作者文档自己的名字、文档里的 bullet 字段名、决定一节是什么的标题词表 —— 翻译它们解析器就读不到 prompt 层让模型写的那些文档）、`production-prompts.ts`（整份是模型面文本，与 `plugin-memory/src/prompt.ts` 同理）。`production-intents.ts` 零中文、无需字典。**新增 peer** `@deepseek-ai/dsh-client-ui-chat`（peer + dev，插件目录内 `npm install --legacy-peer-deps`）。**新增 42 条单测**（`tests/client-drama.test.ts`），套件 **162 → 204**。**测试又写错一处，仍是测试错**：`IMG-*` 的标题是 id 之后的**全部文字**（`角色 · 主角`），`·` 不是 kind/title 分隔符 —— 那是 visual asset 的 `人物 · 主角` 才有的形状；两种格式不同，只有前者由 `用途` 字段定 kind，已在测试里写明。**切片 4 已落地（本轮）**：`src/client/file-activity.ts`（实时文件改动监视器，386 行）。**逐字性由 diff 证实**，只有三处 —— 文件头、`workbenchLabel` 改取字典（4 个 mode 标签 → `production.mode.*`）、`visitRunning` 的回调参数加宽出一个 `PreparingCallArgs`。**typecheck 当场抓到 8 处错，这是本片真正的收获**（我第一遍把 typecheck 挂在管道后面跑，退出码被 `head` 吞了 —— 仓库禁止管道跑门禁正是为了这个）：① 4 处 `toReversed` 不存在于 `readonly number[]/string[]/StepLocation[]`，因为**源的 tsconfig 是 `lib: ES2023`，而套件 20 个插件一律 ES2022**（`源检出/packages/dsh-plugin/tsconfig.json:5`）；② 4 处 `call.args` 不存在于 `PreparingToolCall` —— 源读的是 **alpha 线**才发布的懒参数视图，源自己的注释就写着「rc.2 relies on the Assistant block below」。**两处修法与理由**：`lib` 提到 **ES2023**（`toReversed` 是 ES2023 API，运行时真的支持 —— Node 20+ 与 Electron 的 Chromium；这是**如实声明运行时能力**，而不是把代码改成 `[...x].reverse()` 去迎合一个偏旧的 lib 声明），`target` 保持 ES2022，与套件及 esbuild 的 `target: 'es2022'` 一致（esbuild 不会转译运行时方法，只转译语法，所以两者不冲突）；alpha 那条分支**命名形状而不是转型**（`type VisitedCall = RunningToolCall & { readonly args?: PreparingCallArgs }`），既不改在跟随线上的行为、也不引入新的 `as unknown as`，棘轮基线不变。**新增允许名单条目**（工作区目录名与文档名）。**新增 47 条单测**（`tests/client-file-activity.test.ts`），套件 **204 → 251**；`jsonStringPrefix` 覆盖最厚（流式 JSON 的部分串：未闭合、转义、`\uXXXX`、截断转义、非法转义、键里的正则字符）。这一片**没有未覆盖的导出**。**切片 5 已落地（本轮）**：`src/client/markdown-preview.tsx` 与 `src/client/jsonl-preview.tsx`（本插件第一批 `.tsx`）。**逐字性由 diff 证实**：只有文件头、`t` 的穿透、以及那 13 处文案。**移植后这两个文件一个汉字都不剩，所以不需要允许名单条目** —— 与 `production-prompts.ts` 正好相反，说明判据是按文件里 Han 的**性质**分的（文案 → 字典；契约数据 / 模型面 → 允许名单），不是按目录分的。**新增 peer `react`（peer+dev `^18.2.0`）与 dev 的 `@types/react 18.3.1`**，照 `plugin-workbench` 的写法；这是本插件第一次有 JSX 运行时导入 —— esbuild 的 `jsx: 'automatic'` 会 emit `react/jsx-runtime`，那是**运行时** import，所以 import 门禁要求它被声明，不是可有可无的一行。**新增 22 条单测**（`tests/client-previews.test.ts`），套件 **251 → 273**。**四处测试预期写错，仍是测试错**，其中一处暴露了真实契约：**表格的对齐行至少要三个横线**（源的正则 `^:?-{3,}:?$`），少一个整张表就退化成段落 —— 我的夹具写了 `:--` 与 `-`。另三处：未终止的代码围栏产出的是**没有** `language` 键的对象（不是 `language: undefined`，`deepStrictEqual` 分得清）；一行合法记录也会先要一次 `preview.record` 兜底标题，所以键序断言必须含它。两条都写进了测试注释。**切片 6 已落地（本轮）**：`src/client/production-canvas.tsx`（关系画布，326 行）。**逐字性由 diff 证实**：文件头、3 处本地 import 扩展名、`Props` 加一个 `t`、以及那 11 处文案，其余零 diff；移植后该文件零汉字。**typecheck 又抓到 9 处错，暴露的是一处版本差**：源对着 **`@types/react` 18.3.28** 写（`源检出/packages/dsh-plugin/package.json:128`），而套件 20 个插件一律钉 **18.3.1**，后者的 `useRef` **没有** `useRef<T>(undefined)` 这个重载（18.3.1 的三个重载是 `(T)`、`(T | null)`、`()`）。**修法与理由**：三个 ref 的类型实参显式写成 `T | undefined`，而不是去动 devDependency 的版本 —— 运行时是同一个 React 18，这三个 ref 在首次赋值前**确实是** undefined（下面的代码就往里赋 `undefined`），所以这是**把类型写实**，不是绕开类型；换版本则会让这个插件的类型面与另外 19 个不同，而差异本身与 React 的运行时行为无关。**这一片证明了「版本差」是一类真实的移植风险**，与前面 `lib: ES2023` 那次同类：源的 tsconfig/依赖面与套件的约定不同时，逐字搬过来的代码会在 typecheck 处炸，这正是 type gate 存在的价值。**新增 5 条单测**（`tests/client-canvas.test.ts`，覆盖 `canvasNodes` 的列表与布局 —— 组件本身需要 DOM，套件没有），套件 **273 → 278**。**切片 7 已落地（本轮）**：`src/client/video-studio.tsx`（视频工作台，263 行、19 处文案、**51 个新字典键**）。**逐字性由 diff 证实**：43 行改动全是文案、文件头与 import，其余零 diff；移植后该文件**零汉字**。**三句内嵌 `<code>` 的句子拆成 before/between/after 键** —— 这不是我发明的写法，套件的既有做法就是它（`plugin-sidebar/src/client/git-tab.tsx:949` 的 `t('sidebar.restore.before')<code>…</code>t('sidebar.restore.after')`，`plugin-client-ui` 的 models-advanced 同形），理由是字典字符串装不下 JSX 元素。**顺带发现两处「藏在 JSX 里」的文案**：`<code>video-recaps/&lt;项目&gt;/sources/</code>` 与 `<code>video-recaps/&lt;项目&gt;/</code>` 里的 `<项目>` 是路径占位符，**它本身就是文案**（英文对应 `<project>`），所以一并搬进字典 —— 这类文本最容易漏，因为它看起来像代码而不像句子。**typecheck 抓到 1 处**：`artifactKindLabel` 的键表没有上下文类型，值会宽化成 `string`，加 `as const` 让它们保持字面量类型（不是 `as unknown as`，棘轮不动）。**`workbenchLabel` 的调用点跟着补上 `t`** —— 这是切片 4 那个签名改动第一次真正传播到调用方，说明「先定签名、再改调用方」的顺序是对的。**单测数量不变（278）**：这一片只动文案、行为零变化，所以证据不是新测试，而是 typecheck（每个 `t(...)` 的键都被 `CreativeKey` 检查，写错键是编译错误）+ Han 检查 + 上面那条 diff。**新增的已知缺口（记在这里，不是遗漏）**：`preferredPreview` / `preferredArtifact` / `readableBytes` 三个纯函数模块私有、未导出、无覆盖 —— 这是本片之前就有的缺口，本片既没增加也没消除；导出它们就能测，但那会为一次纯文案改动改动模块的公开面，所以**留作记录而不是顺手改**。**切片 8 已落地（本轮）**：`src/client/drama-production-view.tsx`（短剧生产视图，346 行、**130 个新字典键**、前缀 `drama.`）。**这一片是派给子智能体做的**（体量大、模式已由前 7 片固定），我按规矩只把它的结论当参考，**关键处自己复核了六项**：① 它**改动了我此前逐行验证过的 `drama-production.ts`** —— 这是最该查的点。diff 是纯增量：两个导出常量（`STORYBOARD_DOCUMENT` / `IMAGE_PROMPTS_DOCUMENT`，值不变）加四处调用点改为插值，渲染出的字符串逐一相同。**这个判断我认同**：那些文档名是解析器的契约，视图里再写一遍就是第二份真相（会导致 `documentPaths.includes(document)` 漂移），而放进字典更错（英文环境下会在磁盘上找 `storyboard.md`）。② 允许名单**只加了一条**，理由是 `ASSEMBLED_CUT_PATH`（上游自己的成片路径，翻译它合成任务永远无法完成），注释完整。③ 我自己裸跑了全部门禁：typecheck / build / test（278）/ `check-plugin-graph` / `plugin-gates` 全 exit 0。④ 我自己算了字典对称：zh 226 / en 226、零悬空键、零重复、`drama.` 130 个。⑤ 我用 node 列出「源文件里无 Han 但移植件没有」的 23 行，逐行对上 —— 8 行 import、13 行是加 `t` 的签名/调用点，唯一需要看清楚的是 `SECTION_ORDER`：它仍是 `Object.keys(SECTION_LABEL_KEYS)`，键序与源一致。⑥ 我抽查了 130 条英文，全部是真实翻译（`drama.env.note` 用 `{none}` 参数复刻了源的 `<>{…}</>` 条件句，`referenceAria` 的重组也正确）。**它自报的两点**：内嵌 `<small>` 的那句只拆了 before/between（分隔符放在两个 `<code>` 之间，用 `Fragment`，所以不被 code 样式污染）；以及它自查出一个真实的插值 bug（诊断 pill 把 `{count}` 字面量渲染出来了）并修掉。**未覆盖**：这一片与前面几片一样**没有任何运行时证据** —— `src/client.ts` 仍是空 `apply`，视图进不了 `lib/client.js`，没有渲染测试；验证是静态的（typecheck、插件套件、Han 检查、四道门禁）。**新增的偏差（已记）**：`drama-production.ts` 多了两处导出；`drama.prompt.compose`（"按成片顺序合成"）进了字典而不是允许名单 —— 它是作业记录里给创作者看的 prompt，不是发给模型的那份（后者在 `production-prompts.ts`）。**切片 9 已落地（本轮）**：`src/client/styles.ts` + `src/client/styles.css`（样式表，1,242 行）。**做法改了计划原先的打算**（计划写的是「`plugin.css` 可直接进 `styles.ts` 的 template literal」）：样式表**保持独立 `.css` 文件、构建期读成字符串**，理由是 —— ① 这本来就是**源的形状**（源 `index.tsx:64` 就是 `import styles from "./plugin.css?inline"`，`raw.d.ts` 为它声明模块）；② 共享配方 `build-lib.mjs` 明确支持（`css: true` → esbuild 的 `.css → text` 加载器），`plugin-client-ui` 也传了这个选项；③ **`cp` 是字节精确、可用 `cmp` 验证的，手抄 1,242 行 CSS 两者都不是** —— 套件那种 template literal 形状适合几十行的样式表，不适合这个量级。**注入方式改用套件的 `adoptStyles()`**（id 守卫、一次注入 `document.head`）：源在自己的组件树里渲染 `<style>{styles}</style>` **五次**（`index.tsx:1397/1405/1843/1900/1913`），样式随组件来去；套件做法让重挂载是 no-op 而不是叠第二份 1.2 万行样式。**这一片有真实证据**（前几片只有静态证据，这一片有可执行的机制验证）：`scratch/probe-creative-styles.mjs` 用 esbuild 单独打包 `styles.ts` → 84,960 字节的 bundle 里**确实含样式表首尾的规则**与注入守卫 id，4/4 PASS / exit 0。原因是入口还不 import 它，所以真机构建产不出含 CSS 的 bundle，也就分不出「加载器通」和「加载器坏」—— 这条探针把「读配置」变成了「量结果」。**新增 3 条单测**（`tests/client-styles.test.ts`：注入一次、二次调用 no-op、整份样式表首尾规则都在），套件 **278 → 281**；测试打包器也补了同一个 `.css` 文本加载器（它此前没有，`tests/` 里任何 import `styles.ts` 的用例都会拿到空模块）。**顺带查清一笔**:样式表里**代码零汉字**（唯一一处 Han 在注释里）,`content:` 值是 `›` / `●` 这类字形 —— 没有「藏在 CSS 里的文案」。**切片 10 已落地（本轮）**：`src/client/workbench.tsx`（工作台主体，2,011 行、**92 个新字典键**、前缀 `bridge.`）。**这一片也派了出去，而它第一次没能拿到绿门禁 —— 如实报了三项红**（typecheck exit 2、`check-plugin-graph` exit 1、`plugin-gates` exit 1）。我逐项复核后**推翻并修正了它的两处判断**，这正是「子智能体结论只作参考」的实例：**① 它把 3 处 implicit-any 归因于缺 `@deepseek-ai/dsh-api-session-controller`，并用一个临时 `paths` 映射的 tsconfig 证明「装上就好」。** 我按它说的把包加进 devDependencies 后**错误照旧** —— 真因是 TS 从 `dsh-client-ui-session` 的 `.d.ts` **所在的那棵树**往上找：那棵树在**根** `node_modules`,而根上没有这个包;装在插件目录里够不着。修法是照**另外五个插件的既有约定**把 `@deepseek-ai/dsh-client-ui-session` 声明进**本插件的 peer+dev**(那样它的 `.d.ts` 落在本插件的树里,才能向上够到我装的 controller),`typecheck` 随即 exit 0。它的 `paths` 探针绕过了真实解析,所以结论是假的。**② 它手写了一个结构接口 `ISessions` 顶替内核类型，并把 `IConversation` 再导出给入口。** 我在包真装好之后确认 `ISessions` **在包里就有**(`./client` → `lib/types/client/index.d.ts`),于是删掉手写接口与那个再导出,让入口像源一样直接从各自的包取类型 —— 这样少了一处「手写结构接口可能与内核漂移」的风险,也少了一处冗余导出。**③ 它自报 9 处 Han 需允许名单,我逐行看过,9 处全是契约数据**(分组目录名与分组键、媒体根、上游成片正则、创作者文档名、`Open|打开` 前缀),据此加了一条理由完整的允许名单条目。**我自己另有两处独立核查**:zh/en 对称(318/318、零悬空、零重复)与 `as unknown as` 计数 —— 文件里那 1 处**落在模块头注释里**,而**棘轮测试自己证明**了它不计入(`as unknown as counts stay at or below the ratchet baseline` 通过)。**未覆盖**:入口仍未接(下一片),所以 `lib/client.js` 里还没有这个文件,渲染行为零证据;单测数量不变(281)。**切片 11（客户端入口）本轮未落地，如实记**：入口按源的 `apply` 加套件入口约定写出（210 行，草稿在 `scratch/client-entry-draft.ts`，gitignored），typecheck 报 **12 处错**；补上三个 peer（`dsh-client-locale` / `dsh-client-ui-renderer` / `dsh-client-ui-slots` —— 它们是 `ctx.locale`、`ctx.slots` 的 Context 合并来源，此前只在根上解析）后**降到 4 处**。4 处的性质已分清：① `binding(sessionId)` 需要 branded `SessionId` 而槽位 `inject` 给的是 `string` —— 套件对这条 seam 的既有做法是**结构化切片**（`plugin-rewind` 的 `SessionsSlice`），所以我上一片删掉那个手写接口**是错的**，应恢复切片并放在入口里（只此一处消费）；②③ 两个 `tool.call.toolview` 注册报 `No overload matches this call`，待单独看；④ **`workspace-route.ts` 的 `ctx.typert` 被入口连带打坏**（还原入口即恢复绿），属程序级问题（同一声明被两份模块实例拆开），需要一个**逐 import 二分**定位，不在本轮预算内。**本轮只落盘真实增量**：三个 peer + 一条 `bridge.sessionUnavailable` 键，`typecheck`/`build` 均 exit 0，树保持绿色。**本轮另有一个更重的发现，必须有记录**：`@deepseek-ai/dsh-client-store` **不在运行时产物里** —— 三处独立核查（`runtime-dist/runtime-files-win32-x64.json` 无此名、tarball 条目 0 条、解包运行树 `node_modules/@deepseek-ai/` 下**没有任何 `*store*` 包**），而**两个已发布插件**（`plugin-client-ui/src/client/models-advanced/store.ts`、`plugin-effort/src/client/slider.tsx`）与本次移植的 `workbench.tsx` **都在运行时 `require` 它**（`plugin-client-ui/lib/client.js` 里是货真价实的 `var import_dsh_client_store = require("@deepseek-ai/dsh-client-store")`）。**不是本片引入的**，但它是「客户端半边可达」这条路上的一颗地雷：接上入口后这个 require 没有模块表行。**下一轮先定**：把该包补进运行时闭包，还是把 `defineStore` 换成套件自己的槽位 store 机制（`plugin-workbench` 的 `store:` + `PropsStore`）。**切片 11 续（本轮）**：把「入口打坏宿主半边」查到了根因并修掉一半。方法是**把候选 import 一个个单独加进那个已经绿的入口再跑 typecheck**，比读代码快得多。三条结论，全部可复现：① 单独加 `@deepseek-ai/dsh-client-locale/client`（type-only）就会打坏 `workspace-route.ts` 的 `ctx.typert`；另两个（`ui-renderer`、`ui-slots`）单独加是干净的。② **已修**：`dsh-client-locale` 的类型面引用了 `dsh-client-ui-settings` 与 `dsh-package-manifest`，二者此前**只在根上解析**，于是把**第二份 `Context` / `SlotMap` 实例**拉进程序、宿主半边的合并被顶掉；把这两个包声明进本插件 devDependencies 后错误消失（`typecheck` exit 0）。**这条修正独立于入口怎么写都需要**，已落盘。③ 还剩**第二个触发器**，也已二分到位：`dsh-client-locale` 的 type import **与**入口里那段 `LocaleNamespaceMap` 合并**同时存在**才触发（各自单独都干净）—— 即「引用 `ui-slots` + 增补 `ui-slots`」这一对把程序拆成两份模块图。**尚未修，也不猜着改**：候选下一步是给这两个包补 peer 声明、把合并挪到别的文件、或让两个半边分属不同 tsconfig program。草稿仍在 `scratch/client-entry-draft.ts`。**切片 11 已落地（本轮）**：`src/client.ts` 成为真正的入口，**客户端半边第一次可达**。① 上一轮那个「第二个触发器」用**结构**解决的：`typecheck` 拆成两个程序（宿主 `tsconfig.json` 排除 `src/client*`；客户端 `tsconfig.client.json` 显式 `include` 那几个路径并 `exclude: []`）。理由是**两个半边本来分属不同模块图**（node 与浏览器），同一个程序才是异常 —— 分离按构造消除了「客户端类型依赖顶掉宿主 `Context` 合并」。② **我差点被一个空的绿骗过去**：拆完之后 `typecheck` 立刻报 0 错，但父配置的 `exclude` 会被 `extends` 继承，客户端程序里其实**只有 1 个文件**（客户端半边两个程序都没检查）。我是用 `tsc --listFiles` 数文件数发现的（客户端 21 / 宿主 15），补上 `exclude: []` 后重跑才是真结果。**这一条值得记住：拆配置时，"0 错" 可能只是"没检查"。** ③ 剩下 3 处（branded `SessionId`、两个工具视图注册缺 `locale: NS`）修完即 `TSC=0`。④ **构建抓到一个真缺陷**：`workbench.tsx` 等文件里 5 处把 `.tsx` 写成 `.ts` —— TS 的 Bundler 解析容忍它，esbuild 不容忍，而在入口接上之前 `build.mjs` **根本走不到那些文件**，所以从切片 5 一直隐藏到现在。**教训：只有真机构建能证明"能打包"；`typecheck` 与插件套件都看不见这一类。** ⑤ **那一大片"移植件不被入口引用"的状态结束**：`lib/client.js` 现在 385 KB，实测含样式表、注入守卫 id、座位 id、会话分栏与工具名。**仍未做**：四张域卡片；以及 `dsh-client-store` 那颗地雷（本片没有处理，只是现在它真的会走到）——**下一轮先定它**。**切片 12（四张域卡片）本轮落地但未生效，如实记**：`src/client/cards.tsx` 已进产物（388 KB，实测四个卡 id 与 picker 接缝都在），`typecheck`/`build`/插件套件全绿；但**真内核探针里四张卡没有注册**（`cardIds: []`，日志中四个 id 零出现）。**实测链条四条**：① `lib/client.js` 在**模块工厂顶层** `require("@deepseek-ai/dsh-client-store")`（已用 bundle 摘录与正则确认是顶层、非惰性）；② 探针启动的运行树携带 **59 个 `dsh-client-*` 包，没有这一个**（两个解包树 + `runtime-dist` 清单，共三次独立核查）;③ 把它从 `dsh.client.inject` 去掉（那是「inject 名没有 graph row 就跳过本插件」的机制）后重跑，**仍然不注册**；④ 四张卡的设计本身无异议（会话型、不占 `workbench.view`）。**结论：半边在 bundle 里可达，在真核心里不加载。** 修法就是十几片前点名的那条：把 `defineStore` / `@deepseek-ai/dsh-client-store` 换成跟随线真的携带的 store 机制（容器自己的 `store:` + `PropsStore` 是先例），属 `workbench.tsx` 里 store 的重构，是下一步的具体动作。**顺带一条更重的**：同一个 require 也在两个**已发布**插件里（`plugin-client-ui`、`plugin-effort`），所以「客户端加载器是否容忍缺失 id」这个问题现在有了**否定**答案 —— 那两处很可能今天也是坏的。**还有一条方法论**：`cardIds` 这个断言不是为这一片写的，它本来就在探针里 —— **是既有的观测点把我的半边「有没有加载」变成了可读事实**；这一片的价值一半在这里。**用户实测报回三个问题（本轮）**：① **默认（空）会话里出现了写作引导页** —— 门控 `welcome = sessionBlank && … && !creativeProject` 的字面意思就是「会话是空的且没有创作文件」，而那是**每一个新建会话**，于是引导页铺进所有用户的对话栏。**已修**：额外要求 `preference === "open"`（创作者已采纳过该工作区），代码注释写明这是**有意偏离源**及理由；同时把 `storedPreference`/`preference` 上移到 `welcome` 之前（否则引用未声明，typecheck 当场报错）。验证：typecheck / build / 套件 281 / 真内核探针 51 checks 全绿。② **卡片 UI 未用官方原语** —— `cards.tsx` 手写 `<div>/<strong>/<p>/<button>` 加自造类名，违反 `plugins/AGENTS.md` §6「组合宿主原语、绝不重绘，写界面前先查 `dsh-client-ui-primitives` 的导出表」。**未修，待办**。③ **四张卡不注册**：用户能看到座位 ⟹ **半边确实加载了** ⟹ 我上一轮「缺包导致不加载」的结论**被证伪**（这同时解释了另外两个 require 该包的已发布插件为何正常）；`cardIds: []` 因此是一个**独立缺陷**，差分实验（把卡片注册挪到 `apply` 最前，一次分清"没加载"与"注册没生效"）仍未做。 | [~] |
| W16 | [!] | 后续弧 4：游戏类预览的来源隔离——是否给预览第二个来源（独立 scheme，或 shell 自持的端口）。属安全边界，等用户决定 | [!] |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1–W12, W17 | 条目全 `[x]`（W13–W16 是后续弧、W18 是 `[–]`，均不计入）；`npm run check:suites:gate` 与 `npm run check:graph` exit 0；插件 typecheck/build/测试全过；`npm test` 全绿；`scripts/probe-workbench.cjs` 全部断言 PASS / exit 0；运行时重建后 `verify --tgz` 与打包冒烟通过 | [x] |
| 2 | W13 | 前缀匹配、`Range`、**`webServer` 是否可用**三项结论各自附命令输出 —— 三项都有（18 项断言 / exit 0）。**第三问附组合限定**：探针走的是 CLI/`dsh web` 组合，shell 真机的 `dsh-desktop-host` 入口未测，见 Work items W13 | [x] |
| 3 | W14, W15 | 三个域工作台**端到端可用**，且容器代码未改。可检查的定义：在真内核上（a）工作台页出现四张卡；（b）点其中一张 → 用户选定一个**有创作文件**的目录 → 主区域回到 Conversation，且该会话里挂起分栏工作台；（c）分栏里能看到那个目录的文件树；（d）`plugins/plugin-workbench/` 的源码在本阶段**零改动**（`git diff --stat` 可验，这是「新增领域只改域插件」那句话的证明）；（e）四道插件门禁 + `check:suites:gate`（20 个）+ 根套件全绿 | [ ] |
| 4 | W16 | 安全评审有结论，第二个来源的方案写清边界与拒绝路径 | [–] |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。

**W2 与 W3 必须落在同一个 commit**：只有 W2 时，侧边栏会多出一行点了就抛的入口
（`main panel "workbench" is not registered`），而计划自己的成功标准第 1 条在那个状态下无法验证。
本仓库「缺陷不是 backlog 项」的规矩不允许把这个中间态写进历史。

## Affected behaviors

- **侧边栏顶部行序**：`nav[aria-label="全局面板"]` 的按钮顺序从 `["插件","自动化任务"]` 变成
  `["工作台","插件","自动化任务"]`。任何按 DOM 顺序定位的探针或视觉基线要同时更新——定位方式只有
  `aria-label`（见事实基线）。
- **`ctx.layout.selectPanel` 的合法 key 集合**新增 `workbench`；`activePanelId` 多一个取值。
  未注册 key 抛错并保留选中态的行为不变。
- **五处 roster 名单**变化 → `npm run check:suites:gate`、`scripts/smoke-suite.mjs`、
  `.github/workflows/release.yml` 的预构建循环同时读它。漏改一处得到的是静默的原版界面，没有报错。
- **第六处快照表**：`test/type-escape-ratchet.test.mjs` 的 `BASELINE` 会拒一个「有 `src/` 但不在表里」
  的插件目录，已随本切片补上表项（补之前根套件是红的）。
- **`scripts/check-slot-registrations.mjs` 的 id 形状放宽**：`SLOT_ID_SHAPE` 原来要求 id 至少有一个点，
  内核自己声明的无点座位（`main`/`root`/`sidebar`/`rightbar`）从来没被收集，于是第一个注册进 `main`
  的套件插件被判成「注册到未声明座位」。**实测差集 +4**（旧正则在 layout 已安装时 52，新正则 56；
  56 与 48 之差里另外 4 个来自安装 layout 包本身）。`test/slot-registrations.test.mjs` 加了回归测试，
  并已用「把正则改回旧版 → 该测试变红」的方式做过反例验证。
- **`suiteVersion` 只对插件的 `package.json` 版本取哈希**，所以本插件的版本号必须真的变。
- **`src/main/brand-suite.ts` 是编译进 shell 的名单**：不切 shell tag，已安装用户的外壳仍然只链接
  原 18 个目录，新 runtime 里的这个插件永远不会被激活。所以 changeset 的 `shell` 字段是 `patch`
  而不是 `none`，且发布时需要 runtime + shell 同一次发布。
- **客户端多一个座位消费者**；不修改任何上游行的渲染。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | roster 五处一致 | — | exit 0，19 个插件名称一致 | `npm run check:suites:gate` | PASS（19 distinct names，no drift） |
| 2 (W1) | 插件图规则 | — | exit 0 | `npm run check:graph` | PASS |
| 3 (W1) | 插件类型门 | — | exit 0 | `cd plugins/plugin-workbench && npm install --legacy-peer-deps && npm run typecheck` | PASS |
| 4 (W1) | 构建产物存在 | `npm run build` | `lib/index.js` 与 `lib/client.js` 都在且非空 | 同目录 | PASS |
| 5 (W10) | 插件自带测试 | — | 全过 | `cd plugins/plugin-workbench && npm test` | PASS（22 条：`tests/client-entry.test.ts` 13 + `tests/entry.test.ts` 9） |
| 6 (W10) | 根套件 | — | 全过 | 仓库根 `npm test` | PASS（680 tests / 678 pass / 0 fail / 2 skipped） |
| 7 (W2,W3) | 入口渲染且排第一 | 真实内核启动 | `nav[aria-label="全局面板"]` 第一行是工作台 | `node_modules/.bin/electron scripts/probe-workbench.cjs` | PASS（永久探针；顺序 `["工作台","插件","自动化任务"]`，`rowIndex 0`，宽栏与 56px 轨道各测一次） |
| 8 (W3,W5) | 点击进入容器页 | 点第一行 | 中栏出现容器页；页头标题与说明逐字等于字典 | 同上 | PASS（`titleText: 工作台`、`introTextMatches: true`）。**已知缺口**：探针没有断言该行的 `aria-current="page"`（临时 harness 观察到过这个值）；要补需在 `SIDEBAR_SNAP` 采该属性并在 A1 加一条 |
| 9 (W5) | 打开域视图与返回 | 点卡片入口，再点返回 | 出现视图内容；返回后回到宫格 | 同上 | PASS（`PROBE VIEW CONTENT` → 宫格，`viewInDom` 翻转） |
| 10 (W5) | 离开面板重置视图 | 打开视图后 `selectPanel(null)`，再回来 | 全新元素且显示宫格 | 同上 | PASS（expando token：面板内三次切换不变，离开后为 null，回来是 `NO-TOKEN (fresh element)` + 宫格） |
| 11 (W4,W7) | 卡片进入宫格 / 空态 | 走查插件注册一张卡；另一次加载不注册 | 有卡时宫格含卡；无卡时显示空态文案 | 同上 | PASS（`gridContainsCard: true`；`emptyInDom: true`、`emptyText` 逐字等于字典） |
| 12 (W3) | 卡框落点 | 测量锚点与卡片的 computed style | 卡框在卡片上，锚点上全为 0 | 同上 | PASS（卡片 `padding 14px / border 1px / radius 12px / bg rgb(35,35,36)`；锚点全 0，盒子 0×0） |
| 13 (W6) | 会话形态进入工作区 | 点会话型卡片（真实目录） | 侧边栏工作区列表新增该目录；中栏不再是容器页；`activePanelId` 变 null | 临时 harness | PASS（工作区行文本 `probe-entry-workdir`；`workbenchPageInDom: false`；`activePanelId` 由 `workbench` 变 `null`） |
| 13b (W6) | 失败路径的文案 | 点空路径入口 | 卡片逐字渲染字典里 `invalid-argument` 那一句，且不导航 | 同上 | PASS（`没有可打开的目录。` 逐字相等；`activePanelId` 保持 `workbench`） |
| 13c (W6) | 入口不抛异常 | 全程 | `error` / `unhandledrejection` 收集数组为空 | 同上 | PASS（两次运行 count 均为 0） |
| 14 (W8) | 容器自己的键盘面 | 进域视图后聚焦返回按钮；再派发 Escape | 返回按钮是真 button 且可聚焦；Escape 回宫格 | 同上 | PASS（`tagName: BUTTON`、`tabIndex: 0`、`focusLandedOnBack: true`；Escape 后 `viewInDom: false`） |
| 14b (W8) | 卡片侧键盘契约 | 读卡片入口元素的标签 | 每个入口都是真 `<button>` | 同上 | PASS（三个入口 `tagName: BUTTON`、`tabIndex: 0`） |
| 15 (W12) | changeset 门 | — | exit 0 | `node scripts/check-changeset.mjs --base <最近 release tag>` | PASS（v0.16.5 基线）；片段经 `parseFragment` + `decide` 双重确认 |
| 16 (W1) | roster 打包冒烟 | `npm run runtime:build`（已跑，101 MB 产物） | 新插件出现在产物里 | `tar tzf <产物> \| grep plugin-workbench` + `npm run verify -- --tgz <产物>` | PASS（产物里有 `runtime/app/node_modules/@dsh-app/plugin-workbench/{package.json,lib/,locale/,icon.svg}` 共 9 个条目；真内核冒烟输出 `smoke: all checks passed`）。Risk 6 因此关闭 |
| 17 | 编译闸门 | — | exit 0 | `npm run typecheck` | PASS |
| 18 (W2) | 座位注册被静态门接受 | — | exit 0，列出 `sidebar.panellist` 与 `main` | `npm run check:slots` | PASS（56 slots declared / 21 registrations judged / 0 not judged） |
| 19 (W1) | 内核接触面扫描 | — | exit 0 | `npm run check:touchpoints:gate` | PASS |
| 20 (W9) | Han 字符只在字典里 | — | exit 0 | `npm run check:graph`（内含 Han 扫描） | PASS |
| 21 | 检查器回归测试 | 把 `SLOT_ID_SHAPE` 改回旧版 | 该测试必须变红 | `node --test --test-name-pattern="flat seat" test/slot-registrations.test.mjs` | PASS（反例已实测：旧正则下 exit 1，同一句断言失败） |

## Verification commands

```sh
npm run check:suites:gate
npm run check:graph
npm run check:slots
npm run check:touchpoints:gate
npm run typecheck
cd plugins/plugin-workbench && npm install --legacy-peer-deps && npm run typecheck && npm run build && npm test
cd ../.. && npm test
node --test test/slot-registrations.test.mjs
node_modules/.bin/electron scripts/probe-workbench.cjs
node scripts/check-changeset.mjs --base "$(git tag --list 'v*' --sort=-v:refname | head -1)"
npm run runtime:build && node scripts/smoke-suite.mjs --tgz runtime-dist/dsh-runtime-*-x64-*.tgz
```

## Rollback

本插件不写任何持久状态：宫格视图是内存里的导航状态且随卸载消失，会话形态写的是用户自己点出来的
工作区登记。回滚＝删掉 `plugins/plugin-workbench/` 整个目录 + 五处 roster 退回 + 第六处 `BASELINE`
表项 + changeset 撤掉，**并保留检查器的修**（那是独立缺陷的修复，与本插件无关）。
版本号一并退回——否则 `suiteVersion` 仍然变化。

## Risks

1. `order` 与未来上游在负 order 上加行冲突。本线实测只有 0 与 10 参赛，但上游可以变；
   W11 的探针是它的守门人。
2. 座位行的定位只能靠 `label` 解析出的文字（`aria-label`）。改文案会同时打断探针与无障碍断言。
3. 套件插件里服务必须按调用时解析（实测 apply 阶段是 `undefined`）。写成 `inject` 依赖会在别的
   内核版本上静默失效。
4. 五处 roster 漏改一处＝静默的原版界面；第六处（`BASELINE`）与第七处语义（检查器的座位发现）漏改
   则分别是根套件变红与检查器自己看不见座位。
5. 域卡片由别的插件注册，宫格必须能容纳 0 / 1 / N 张卡，以及超长的说明文字。空态已交给座位的
   `fallback`（它订阅注册表），所以 0→1 与 1→0 都不会留下过期渲染；但**一个卡片渲染多个根元素会画出
   多个带框的盒子**，这条只写在 owner props 与 styles 注释里，没有门禁守着。
6. **已关闭**：~~`runtime-dist/` 里的运行时不含本插件~~。运行时已重建
   （`runtime-dist/dsh-runtime-win32-x64-0.2.0-rc.2.tgz`，`tar tzf` 得到
   `runtime/app/node_modules/@dsh-app/plugin-workbench/{package.json,lib/,locale/,icon.svg}`），
   且 `npm run verify -- --tgz <该产物>` 输出 `smoke: all checks passed`。
   要记住的是因果链本身：不改 `plugins/plugin-workbench/package.json` 的版本号，
   `suiteVersion` 就不变，已安装的客户端拿不到新插件（`adoption key = dshVersion + suiteVersion`）。
7. 卡框依赖渲染器给锚点写的 `data-slot` 属性。它不是文档化约定，全仓库只有本插件读它；
   上游改掉它只会让卡框悄悄消失（卡片仍在，只是没有边框）。W11 的探针应把这条量进断言。
8. `sidebar.panellist` 的 `id` 是与第三方插件共享的主键空间，撞键会抛错（不是静默）。当前已知的
   占用者只有内核两行；市场快照里两个含 workbench 字样的第三方插件都是不可安装状态。
9. `src/client/entry.ts` 与 `plugins/plugin-client-ui/src/client/workspace-launch.ts` 是同一段逻辑的
   两份（结构性读面 + 按调用时解析 + 失败码归一 + 永不 reject）。套件在结构上不能共享客户端代码：
   每个客户端半边都是被 `window.__ModuleLoader__.load` 包裹的独立模块，本插件也不产出 `.d.ts`。
   仓库对同款重复的既有处置是「重复 + 漂移测试」（`WORKSPACE_LAUNCH_GLOBAL` 那一对），
   这一对还没有——两张用例表应当跑同一个 seam 并断言 token 相同，随第一张真实卡片落地时补。
10. 域卡片必须**逐字重复**本插件的 `declare module` 块与 `WorkbenchCardOwnerProps`（同上：没有共享包、
   没有类型产物）。拼错一个字段时两边都能编译，而卡片会在运行时被 outlet 的错误边界吞掉、静默消失。
   已用 `BEGIN/END workbench-card-slot` 标记圈出要复制的那段；漂移测试同样随第一张卡片落地。

## W14 路由改写映射（把「路由层要重写」变成具体清单）

被移植插件的宿主半边注册的是**一条 prefix 路由**（`kind:'prefix'`、`path:'/<写作域>'`），内部按 pathname 分派。分派表实测（`packages/dsh-plugin/src/workspace-route.ts:730-783`）是 **6 个固定端点 + 1 棵前缀树**：

| 原端点 | 方法 | 能否落到 Connection 的 exact 路由 | 备注 |
|---|---|---|---|
| `/<源前缀>/workspace` | GET | **能** → `/api/plugins/dsh-app/plugin-creative/workspace` | |
| `/<源前缀>/video-preflight` | GET | **能** → `…/video-preflight` | |
| `/<源前缀>/drama-preflight` | GET | **能** → `…/drama-preflight` | |
| `/<源前缀>/file` | GET | **能** → `…/file` | |
| `/<源前缀>/file` | **PUT** | **要换方法** → `…/file` 用 **POST** | 载体只收 GET/HEAD/POST |
| `/<源前缀>/media` | GET / HEAD | **能** → `…/media` | **Range 可用**（W13b 实测：载体不剥、不改写、原样流式） |
| `/<源前缀>/game-preview/**` | GET | **不能** —— 一棵无界资源树，exact-only 的载体装不下 | 唯一没有归宿的端点 → **W16 方案 A**（shell 自持的第二个来源） |

**连带要改的客户端**：它现在用 `endpoint(path, sessionId)` 拼 `/<源前缀>/${path}?sessionId=…`（`packages/dsh-plugin/src/client/workbench-ui.ts:23-27`），前缀要换成 Connection 的路径，PUT 那一处要改成 POST。

**改写的实际规模比看起来小**（读那个文件的结构得出的）：要换的只有**传输层**，纯逻辑原样保留。

| 现在 | 改成 |
|---|---|
| `send(response, status, value)`（`workspace-route.ts:161-170`，`writeHead` + `end`） | `new Response(JSON.stringify(value) + '\n', { status, headers })` |
| `sendMediaBytes(request, response, bytes, mimeType)`（`:207-226`，已经处理 416 与 206） | 返回带 `content-range` / `accept-ranges` 的 `Response`；`Range` 从 `request.headers.get('range')` 取 |
| `jsonBody(request, maxBytes)`（`:264-281`，读 `IncomingMessage` + 上限） | **落地是 `request.text()` + 显式字节上限，不是 `request.json()`** —— 后者无法在解析前施加上限。上限不能丢：载体在 `requestBody: 'buffered'` 下**先整份缓冲**（它自己的上限 300 MiB），插件自己的上限在缓冲之后才施加，所以**上限相同、峰值内存更大**（源的 `for await` 是边读边判、超限即停） |
| handler `(request, response)` | `fetch: (request: Request) => Promise<Response>`，每条路由一个 |

**与传输无关、可以原样搬的**：`parseByteRange`（`:178`，纯函数、已导出）、`mediaHeaders`（`:194`）、`assertCreativePath`（`:296`，已导出）、`mediaMimeTypeForPath`（`:309`）、`listFiles`、`readVersionedFile`、以及 `workspaceRealm*` 那一族（它们只依赖 `ctx`/`fs`，不依赖 HTTP）。**`parseByteRange` 与 `assertCreativePath` 是纯函数 —— 先给它们写单测，再动传输层**，这样改写有回归网。

## W14 资源体积与取舍（移植前必须先定的一件事）

被移植插件的知识资产在 `packages/knowledge/`：**910 个文件 / 31 MB**，四个域（短剧 3 MB、小说改游戏 19 MB、写作 6 MB、视频解说 3 MB）。按类型拆开：

| 类型 | 体积 | 说明 |
|---|---|---|
| `.webp` | **18.0 MB** | 几乎全在 `novel-to-game/examples/jin-ping-mei/build/app/assets/**` —— **随包附带的那份示例游戏的美术资源** |
| `.py` | 3.3 MB | 媒体适配器（短剧 / 视频生产要用 Python + ffmpeg） |
| `.js` | 1.0 MB | 那份示例游戏自己的代码 |
| `.md` | 1.7 MB | 技能正文（516 个文件） |
| `.json` | 0.3 MB | manifest 等 |

**仓库的既有规模**（实测）：最大的插件是 `plugin-ppt` **11 MB**，最大的已跟踪文件是 2.4 MB 的字体。**31 MB 会明显越线**（约 3 倍于现有最大插件）。

**建议的取舍**：技能正文 + Python 适配器（约 5.3 MB）**照常提交**，与 `plugin-ppt` 同量级；**那份 18 MB 的示例游戏美术单独定** —— 它是 demo 而不是功能（插件自己的 `hasCreativeProject` 明确把随包示例排除在「这个工作区有创作」之外）。**但它的牵连比想象的多**（本轮查清）：① `novel-to-game/manifest.json` **逐个列出了它的文件**（含那些 webp），不搬就要同步裁掉，否则 manifest 与实际资源不一致；② 路由层把它当作可玩的示例来服务（`workspace-route.ts:38` 的 `BUNDLED_GAME_EXAMPLE = "jin-ping-mei"`、`:576` 解析到 `../examples/jin-ping-mei`、`:590-591` 作为 `source: 'example'` 的一项）；③ 客户端 UI 文案里也提到了这个路径（`client/index.tsx:520`）。所以选项是：① 照发（仓库 +18 MB，示例可用）；② 发一份压缩/裁剪过的示例（manifest 跟着改）；③ 构建期拉取（源仓库本来就有 `assets:sync` 脚本从上游同步）；④ 不发（要同步裁 manifest、并让路由层的示例分支优雅缺席 —— 那是「少一个 demo」而不是「少一个功能」）。**我倾向 ④ 或 ②**。注意**各技能自己的 `examples/minimal/*.jsonl` 小夹具不在这个取舍里** —— 那些是技能的 selftest 用的，必须随包发。

**另一条会在移植中途变红的约束**：套件的 `as unknown as` 棘轮（`test/type-escape-ratchet.test.mjs`）对 `plugin-creative` 的基线是 **0**（骨架入册时加的），而被移植的代码里有 **3 处**：宿主半边 2 处（都在 `role-tool.ts`）、客户端半边 1 处。移植时要逐处处理 —— 能按结构性类型收窄就收窄；确实需要（内核 seam 没有类型）就把基线**提到那个数**，但那是一次**有理由的、被审查过的**改动，不是顺手加的（棘轮文件自己写着「抬高必须是有意的」）。

**汉字规则与已做的豁免**：被移植的代码里有 **590 行含汉字**（宿主半边 278、客户端半边 312）。套件的规则是「汉字只允许出现在插件自己的字典里」，而办公四插件早已按同一理由豁免了**非客户端**模块（`scripts/check-plugin-graph.mjs:148-158` 的 `ALLOWED_DIRS`：那些目录的宿主半边按设计就是面向模型的层 —— 技能正文、prompt、校验报告、单条可行动的失败值）。**已按同样理由把 `plugins/plugin-creative/src/` 加进那张表**（`client/` 仍不在其中，豁免逻辑本身就排除它）。所以：**宿主半边的中文要原样保留**（那是模型面的文案，不是 UI copy），**客户端半边的 312 行必须进本插件的字典** —— 这是 W15 的一项独立工作量，之前没估进去。

## W16 决策材料：预览的来源隔离与资源树

这一节是给 W16 做决定的材料，不是决定本身。

**两件事收敛到同一处缺失。**

1. **iframe 的来源**。游戏台要把项目里构建出的 `index.html` 与它自己的 JS 放进 iframe 才能跑，而那些文档来自用户目录。这台 shell 只有**一个**来源：`dsh-app://app`（`src/main/desktop-host.ts:2085-2103`，注释字面写着 "nothing in the app is allowed to claim a second origin within it"）。而 `docs/agents/security-invariants.md:22-24` 要求「app-origin 文档不进 sandbox frame」—— 理由是 action 路由只信**顶帧**的 initiator 戳，而 sandbox iframe 会从 opaque origin 上报 app 的 URL（`src/main/shell-actions.ts`）。那个插件自己已经检测到这件事：`isolated = url.origin !== globalThis.location.origin`，同来源时它降级成不给 iframe `allow-same-origin`，界面直接写「当前部署无法隔离来源，存档功能不可用」。
2. **资源树的路由**。W13 的发现让它更硬：一棵构建产物的资源树需要**前缀路由**，而套件允许的载体里没有 —— Connection 载体的分派写死为 `fetchRoutes.get(url.pathname)`（exact-only），支持 `kind: 'prefix'` 的是宿主 webServer，而那是套件规则不让插件用的那一层。

所以「游戏台能不能上」实际是在问：**shell 要不要有一个自己的来源，用来服务一棵被显式授权的目录树。**

| 方案 | 边界 | 拒绝路径 |
|---|---|---|
| A. shell 自持第二个 privileged scheme（如 `dsh-preview://`） | 主进程注册 scheme，只服务**一次被显式授权的预览**：令牌绑定 `(sessionId, 项目根, 过期时间)`，路径必须落在该根内，只发静态字节，不注入任何 shell 能力 | 未知/过期令牌、越根路径（`..`、绝对路径、符号链接逃逸）→ 404；非 GET/HEAD → 405；不做目录列举 |
| B. shell 自持一个回环端口的小静态服务 | 同上，但用真实 origin（`http://127.0.0.1:<port>`），与 app 来源天然隔离 | 多一个监听面与端口生命周期；令牌校验同上 |
| C. 不隔离，接受降级 | 零改动 | 游戏台存档永久不可用，且「app-origin 文档进 sandbox frame」与不变式直接冲突 —— 那要改写不变式，我不同意 |

**我的建议是 A**：与现有来源模型一致（scheme 家族由主进程独占）、不新增监听面、令牌与盖章可以照 `host-stream-auth.ts` 与 `shell-actions.ts` 的既有做法。

**要你决定的**：接受给 shell 加第二个来源（A 或 B），还是**把游戏台排除在首轮移植之外**，先上小说 / 短剧 / 视频三个台。后者不需要任何 shell 改动。

**两条路由层改写量到、要一并带进这个决定的材料（审查提出，2026-10-15）**：

① **`/workspace` 返回的 `previewUrl` 字符串指向那棵树**。本轮保留原值（编一个不存在的载体路径比死链更糟），所以它现在答 404；**客户端那轮无论如何要重写这个字段** —— W16 的第二个来源也不会是 `/<源前缀>/game-preview/…` 这个形状，所以别把这个字符串当成「以后会活」的占位。

② **源对预览树用的是更宽的判据**：`workspace-request-trust.ts` 的 `isTrustedPreviewNavigation` 允许回环别名之间的 cross-site navigate，而载体的 `isTrustedApiRequest` 只有更严的那一个。本轮不搬那个判据是对的（树没搬），但**树若搬上载体，这条会重新咬人** —— 要么 A/B 的来源自己带这套判据，要么承认预览的导航信任比源更严。

## 收尾项（已调查、有意留到后续 —— 不是遗漏）

审查点过、我判断现在不做，逐条写在这里，免得下一个读者重新发现一遍。

| 项 | 位置 | 为什么现在不做 / 怎么补 |
|---|---|---|
| 探针里约 5 条冗余或恒真断言：`anchorMatchesRule` 恒假（锚点的父就是 grid，结构上不可能匹配）、`pageToken === null` 与 `pageInDom === false` 是同一读数、`gridContainsCard` 被 `cardInDom` 蕴含、`activeTabIndex` 被 `backTabIndex` 蕴含、6 条只断言 fixture 自己的标记 | `scripts/probe-workbench.cjs` | 合并不减守卫，只减数目；探针要守的是已交付行为，不是断言条数。fixture 那 6 条留 1 条作契约记录 |
| 探针「跑了 0 条也退 0」这条路径没被代码关死 | `scripts/probe-workbench.cjs` 的 `main()` | **已修（本轮）**：加 `passed === 0 → RESULT: FAIL (0 checks ran)` 分支，退出判定一并纳入 `passed === 0`。实测探针仍 `PASS (50 checks)` / exit 0 |
| `rowDataSlot === null` 断言过拟合到内核实现 | 同上 A1 段 | 上游给行加 `data-slot` 是纯改进，加了则探针变红而功能无回归；宜降级为打印（`rowAttributes` 已在打印） |
| 「有卡片时空态文案不在」缺一条断言 | 同上 A2 段（`emptyInDom` 已采到） | outlet 若改成 fallback 与条目同渲，现在 50 条仍全绿 |
| `aria-current="page"` 未断言 | 测试计划第 8 行 | **已修（本轮）**：A2 里加一条独立断言（点行后该行 `aria-current === 'page'`），探针由 50 条变 **51 条**、仍 exit 0 |
| `test/recursive-delete-guard` 的扫描根含 `scripts`，fixture 的生成 `lib/` 落进同步删除审计范围（今天无命中、根套件绿，将来会以「生成文件里有未审计的删除」这种难懂理由变红） | `test/recursive-delete-guard.test.mjs:37-41,164` | **已修（本轮）**：豁免正则从 `^plugins\/[^/]+\/lib$` 扩到 `^(?:plugins\/[^/]+\|scripts\/fixtures\/[^/]+)\/lib$`。实测该测试文件 exit 0（三条断言全过） |
| 座位检查器的 `keyProps` 假阳性：内联 `keyProps: { 'x': { … } }` 会被当成已声明座位，从而**掩盖一次真实退休** | `scripts/check-slot-registrations.mjs:159-176` | **已修（本轮）**：判据改成**只认 SlotMap 体的顶层键**（按 `{`/`}` 数深度），比「跳过 `keyProps` 之后的对象」更硬 —— 后者依赖成员顺序。同时**回退**了一版「要求条目体以 `kind:` 开头」的写法：它会给「`scope` 写在 `kind` 前」的合法座位带来**假阴性**。实测 `check:slots` 计数不变（56/21/0），新增回归用例 9/9 过，且做过反例（摘掉深度判据该用例变红） |
| `docs/agents/kernel-line-regression.md` 同一节里仍有「根 + 16 插件 spec 同改」这条**给下次升线复用的操作模板**，以及「当前扫 738 个文件」「当前 14 次注册」这类当下值（W17 改了同文件的另一处） | `:407`、`:40`、`:88` | 同一次描述性同步的漏项；改成 19 或去掉具体数字 |
| 根 README 能力表里 `plugin-rewind`、`plugin-effort` 缺行（中文比英文多一行的既有不对称，与本轮无关） | `README.md` / `README.en.md` | 写它们等于新写两段能力描述，超出「同步计数」的范围 |
| 两份 workspace-entry 实现的漂移测试 | `plugins/plugin-workbench/src/client/entry.ts` vs `plugins/plugin-client-ui/src/client/workspace-launch.ts`（Risks 9） | 两张用例表跑同一个 seam、断言 token 相同；随第一张真实卡片落地 |
| 域卡片契约的漂移测试 | `BEGIN/END workbench-card-slot` 标记块（Risks 10） | 同上，随第一张真实卡片落地 |
| ~~**W13 的路由探针没转正**~~ **已转正** | `scripts/probe-routes.cjs`（前身 `scratch/probe-routes/probe.cjs` + `scratch/probe-desktop-routes/probe.cjs`） | 两份一次性探针合成一份永久探针：启 **W13b 的真机 desktop-host 形态**（入口 `dsh-desktop-host/lib/index.js`、`webShapeArgs` 那组位置参数、无 `--patch`、URL 从 `ready` 消息拿、cookie 用 shell 自己的 `authenticateHostWeb` 换），把 W13 独有而 W13b 没测的 `Range` 与流式断言并进来（真机形态下同样用 shell 换来的 cookie 发 `/api` 请求，不需要页面）。**32 项断言 / `RESULT: PASS (32 checks)` / exit 0**（**本轮新增 S6 段后为 41 项 / `RESULT: PASS (41 checks)`**：真实套件插件 `plugin-creative` 自己的路由在载体后面派发、载体自己的 404/403 体是纯文本、异源 `Origin` → 403 —— 这是「插件自己的路由真的接上了载体」的唯一端到端证据）。Q5（同一条 prefix 路由无 cookie 200、异源 200）由「测量并打印」升为**断言** —— W14 的路由决策压在这条上，栅栏一变就该红。两个 fixture 搬到 `scripts/fixtures/probe-routes` 与 `scripts/fixtures/probe-wsinject`（`src/` + `build.mjs`，产物 `lib/` 落进已有的 `scripts/fixtures/*/lib/` 忽略规则）。重跑时机登记在 `AGENTS.md` §4 与 `docs/agents/kernel-line-regression.md` §6.4 / §9。崩溃退 1、`passed === 0` 退 1、端口 19387 被占即报错退出，三条都实跑过 |
| W18 宫格内委托式方向键导航 | 见 Work items | 没有卡片可导航，且要与卡片契约漂移测试一起做才有东西可测 |
| **20 个文件 / 21 处写着一条实测为假的安全前提**：「the desktop host disables its `webserver` row, so a plugin that waits for it never activates」。**实测（真机 desktop-host 组合）**：该行由 `dsh-web-app` bundle 启用，`webServer` 可用。分布：`AGENTS.md:197`、`docs/agents/security-invariants.md:28`、`docs/desktop-optimization-plan.md:419`（主语是**上游官方** desktop，属历史记录 —— **保留 + 加注**，不改写历史），以及 17 个插件文件 / 18 处（`plugin-{archives,hooks,memory,doc,pdf,mcp,websearch,swarm,presets,sheet,ppt,brand,usage,sidebar}/src/**` 与 `plugin-sidebar/tests/routes.test.ts:6`）。**`plugins/plugin-brand/src/routes.ts:8-9` 不该删**：它说的是 frames 线（「every request arrives over the Electron byte pipe」），那条线上是真的 —— 加限定语即可 | 见左列 | **规则不变，只换理由；但我不擅自改安全不变式文档** —— 按你的规则这类改动先给方案、等你确认。理由现在已实测（见下一行），提议措辞也在下一行。另：本轮已修掉它的**根因** —— `src/main/brand-suite.ts:51-60` 的模块头把 frames 线的做法写成了无条件事实（连带 `plugins/README.md`、`docs/ARCHITECTURE.md` 两处，并带出片段 `changesets/suite-injection-channel.md`） |
| ~~「`webServer` 路由在 Connection 栅栏之外」这条还没测~~ **已测（本轮）** | `scratch/probe-desktop-routes/probe.cjs`（真机 desktop-host 组合，**21 项断言 / exit 0**） | **实测**：同一条 prefix 路由，**无 cookie → 200**、带 `Origin: https://evil.example` → **200**；对照 Connection 的 `/api` 路由：无 cookie → **401**、带 cookie + 异源 Origin → **403**、带 cookie + 同源 → 200。**栅栏由路由的拥有者各自施加，不在服务器上**。**提议的不变式措辞**（规则本身不变）：「套件宿主路由走 Connection 载体，因为该载体在派发前做浏览器鉴权与 Host/Origin 栅栏；而 `webServer` 路由对回环端口上任何进程开放、且不校验来源（实测）」 |
| **探针的运行时解包缓存只按来源路径判新鲜，不按内容** | `scripts/probe-workbench.cjs`（`extracted-from.txt`）与 `scripts/probe-routes.cjs` 同形 | **本轮真实发生**：运行时产物同名重建（多了第 20 个插件）后，缓存树仍是旧的 19 个 `@dsh-app`，而 overlay 读的是工作树的 20 行 —— 于是新行报 `creative (@dsh-app/plugin-creative): failed to import`，探针红 1 条。删掉 `scratch/probe-workbench/rt` 重解后 **51/51 绿**。**这不是回归，是缓存的假阴性**（响亮失败，不会假绿）。修法：`extracted-from.txt` 里记 tarball 的 `mtime+size`（或 sha512），不匹配就重解。**与名册变动的耦合是同一类**：名册一动，所有「产物 + 工作树 overlay」的探针都要重解一次 |
| 载体在客户端断开时**不取消**，而是把整条流读完 | `plugins/plugin-creative/src/workspace-route.ts` 的 `/media` —— 本套件**第一条**交出真文件流的路由 | 载体 `dsh-client-connection/lib/index.js` 的 `if (abort.signal.aborted) continue;` 是「继续读完」而不是「停」；插件侧无法修，属载体属性。后果：一个 256 MiB 的视频在客户端走后仍会被读一遍。**记录，不修** |

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1（W1+W2 切片） | 2026-10-14 | `check:suites:gate` exit 0（19 distinct names / no drift）；`check:graph` exit 0；`check:slots` exit 0；`check:touchpoints:gate` exit 0；插件 typecheck/build/test exit 0；根 `npm test` 679 tests / 0 fail；临时内核探针 4 条全 PASS | 四问：**主张复核**——「侧边栏顶部出现工作台并排在插件之前」在真实 rc.2 内核上跑通，因果链每一环都有文件与行号；**最小性**——自绘图标保留（primitives 无语义合适的宫格字形），`order` 由 -10 收敛到 -1；**新风险**——入口先于容器页存在，必须与 W3 同 commit；**反例**——未注册 `main` 时点击抛错并保留选中态，已实跑。审查另找到三条必修：根套件第七份名单 `BASELINE`（已补，红转绿）、changeset 级别应为 `shell: patch`（已改）、`PANEL_ID` 一致性无守卫（已导出并被测试断言） |
| 1（W3+W4+W5 切片） | 2026-10-14 | 插件 typecheck/build/test exit 0（12 条）；`check:slots` exit 0（56/21/0）；`check:suites:gate`、`check:graph`、`check:touchpoints:gate`、根 `npm test` 全 exit 0；临时内核探针 6 组证据全过（含 expando token 的卸载验证与卡框落点测量）；`test/slot-registrations.test.mjs` 8 条全过，其中新增的平座 id 用例已做反例验证 | 四问：**主张复核**——「点卡片进入域页面」与「离开面板即重置」都在真实内核上跑通；**最小性**——用座位自带的 `fallback` 与「卸载即重置」省掉了 store 与订阅，座位数从 3 收敛到 2；**新风险**——卡框依赖渲染器的 `data-slot` 锚点（已记 Risks 7），空态分支改由 outlet 订阅（修掉了一处「父组件读未订阅注册表」的真实缺陷）；**反例**——(a) 探针量到卡框原本打在 `display: contents` 锚点上、卡片身上全为 0，修后锚点全 0、卡片拿到框；(b) 检查器正则改回旧版会让平座用例变红；**过程中自己踩了一次仓库明令禁止的坑**：在 template-literal CSS 的注释里用了反引号，构建当场失败，同一切片内犯过两次——这条规则由构建兜住，没有再犯的余量 |
| 1（W6+W8 切片） | 2026-10-14 | 插件 typecheck/build/test exit 0（22 条）；`typecheck`、`check:suites:gate`、`check:graph`、`check:slots`、`check:touchpoints:gate` 全 exit 0；真实内核探针 **18 项 PASS / 0 FAIL**（会话入口三事实、失败文案逐字、零异常、按钮与焦点与 Escape）；根 `npm test` 全绿 | 四问：**主张复核**——「点会话型卡片进入工作区」由三个事实合起来证明（侧边栏工作区行出现、容器页从 DOM 消失、`activePanelId` 变 `null`），不是靠单一信号；**最小性**——入口不抽公共包（客户端半边是 loader 包裹的独立模块，跨插件 import 在结构上不成立），保留第二份实现并把「不抽」的理由写在模块头；**新风险**——`entry.ts` 与 `plugin-client-ui/client/workspace-launch.ts` 是同一段逻辑的两份，仓库对同款的既有处置是「重复 + 漂移测试」，那份测试还没有（记 Risks 9）；**反例**——审查指出「容器只能 (a)+(b)」过强（套件自己的维护设置容器就在别人注册的贡献上做了 roving focus），已改成「本轮只交付容器自己的那一半 + 卡片契约」，并把「委托导航」记为可做而未做。审查另外三条必修已闭合：W8 的 Escape 半边原本既没做也没记录（已实现并实测）；用户可见文案里印裸 host code 且漏掉唯一可操作的 `workspace/invalid-path`（已按 code 分句）；`openWorkspace` 抛错这条真实分支零覆盖（已补）。还修掉一处**测试假绿**：桩的 `t` 忽略插值参数，页面渲染出 `{code}` 也不会红 |
| 1（W11+W17 收口切片） | 2026-10-14 | 我实跑 `node_modules/.bin/electron scripts/probe-workbench.cjs` → 退出码 0、`RESULT: PASS (49 checks)`；`typecheck`、`check:suites:gate`、`check:graph`、`check:slots`、`check:touchpoints:gate` 全 exit 0；`changeset-gate` exit 0；根 `npm test` 680/678/0/2 | 四问：**主张复核**——「探针真的在断言」不靠它打印的 `PASS` 而靠「失败数 → 退出码」这条绑定，而这条绑定在搬运时被修过一次（前身 harness 崩溃时 `finally` 先于 catch 执行、断言数为 0，于是退 0）；**最小性**——49 条断言里确实有可合并的（同一事实的多角度测量），但每条都对应一条已交付行为，删任何一条都会留下一个无人守的角落；**新风险**——探针依赖渲染器给 `renderSlot` 锚点写的 `data-slot` 与侧边栏行的 `aria-label`，两者都是实现细节，上游改掉时断言会**响亮失败**（等的值不出现）而不是静默通过，这正是它该有的失败形态；**反例**——W17 若只改数字不改「当下测量值」的写法，每加一个插件就会过期一次（已改成不写死），历史计数若跟着改就是篡改历史（已一律保留） |
| 3（W14 路由层切片） | 2026-10-15 | 插件 `npm run typecheck` / `build` / `test` exit 0（**66/66**、15 suites）；`node scripts/plugin-gates.mjs plugins/plugin-creative` exit 0（type gate **未跳过**、29 个 import 全有声明、`lib/` 新鲜）；`check:graph` exit 0（20 plugins / `^0.2.0-rc.2`）；`check:suites:gate` exit 0（5 份名册 / 20 个名字 / no drift）；`check:slots` exit 0（58 declared / 21 judged / 0 not judged） | 四问：**主张复核**——「6 个端点改写成 5 条 exact 路由后行为不变」由三件事合起来证明：纯函数单测（`parseByteRange` 19 条）在**传输层改写之前**写好、路由级测试驱动真 handler 与真字节（206/416/200 与 body 切片都量了）、真机 desktop-host 探针的 S6 段（插件的 400 与载体的 401 对照、`/video-preflight` 真读数）；**最小性**——`workspace-request-trust.ts` 整份不搬（载体逐行等价），`Config.trustedHosts` 随之删除；**新风险**——请求体被载体整份缓冲（峰值内存）、404/403 体形状变化（客户端不能按 JSON 读）、流中途 I/O 错误的表现变化，三条都写进模块头与 changeset；**反例**——审查指出测试里「未声明路径 → 404」是读注册表得出的**推断**，已改成经 `call` 的路径/方法回落派发；另有一处**改错**被审查抓到：本轮插入的计划文本把 W14 表格行拆成两行，已修 |
