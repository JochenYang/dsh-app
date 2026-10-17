# 工作台容器：可扩展的领域工作台入口

- Status: active
- Plan date: 2026-10-14
- Reduced: 2026-10-17

> **修订说明（2026-10-17）**：创作类的域插件（原先 W14–W16 的移植对象）已从套件移除，本计划里规划它的
> 三节 ——「W14 路由改写映射」「W14 资源体积与取舍」「W16 决策材料」—— 以及 W14b / W15 / W16 三个条目
> 一并删掉；W14 只留下结论作**决策记录**（外部文档与探针按这个编号引用它）。**留在这里的只有容器本身**：
> 侧边栏座位、容器页、两个扩展座位、空态、会话入口，以及守它的永久探针。W13 / W13b 保留，因为它们量的
> 是**路由载体**而不是那个插件：栅栏结论仍是 `scripts/probe-routes.cjs` 的断言，也是「套件宿主路由一律走
> Connection 载体」这条规则的依据。

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
| W19 | [ ] | **开放工作台给用户自建**（产品方向，你提出）：把「用户自己设计一个工作台并导入使用」做成插拔式。**架构已经支持** —— 容器只认两个座位，任何插件注册一张卡就出现；先例是 `dsh-context`（第三方插件加侧边栏行）与 `plugin-market`（走内核 CLI 把第三方插件装进被启动的 profile）。**缺三件**：① 一份**可 import 的契约包**（types-only，导出 owner props 接口 + 两个 SlotMap 合并）—— 现在卡片作者必须**逐字手抄**那块 `declare module`，抄错一个字段两边都能编译、卡片会在 outlet 的错误边界里静默消失（Risks 10）；② **发现面** —— 用户无法知道有哪些工作台可装，容器的空态正是它的落点（市场目录加一个 tag/分类，空态里列「可安装的工作台」）；③ **能力与信任的诚实说明** —— 卡片/视图跑在 app 的文档里、**同源、同一棵 React 树，不是沙箱**；而容器交给每张卡两个能力，其中 `enterWorkspace(path)` 会**不经用户确认**地把任意目录登记为工作区（内核自己的选择器要求用户挑目录）。建议把 `enterWorkspace` 改成走用户选择而不是卡片传路径，但那是已建好的东西的设计改动，要单独定。**明确不做**：工作台的声明式 DSL / JSON 卡片格式 —— 座位就是 React 组件，声明层表达不了真工作台，那会是第二个更弱的契约。**现成的样例已经存在**：`scripts/fixtures/probe-workbench/` 就是一张能跑的真卡片，可以直接当参考实现 | [ ] |
| W13 | [x] | 后续弧 2：路由层能力探针（`scratch/probe-routes/probe.cjs`，**18 项断言 / exit 0**，从页面里发请求以满足载体的浏览器认证）。**三问的结果，附组合限定**：探针启的是 **CLI/`dsh web` 形态**（`dsh/lib/bin.js --profile … --patch …`），而 shell 真机启的是 `dsh-desktop-host/lib/index.js` 的**位置参数**形态、且不传 `--patch`（`src/main/desktop-host.ts:387-389,641-661`；`--patch` 在 `src/` 里零命中）——**两套组合不同，所以第三问只在该组合下成立**。① Connection 载体 **exact-only** —— 注册 `/…/tree` 后 `/tree` 200、`/tree/a/b/c.js` **404**（实现同此：`fetchRoutes.get(url.pathname)`，运行树 `dsh-client-connection/lib/index.js:611,616`）；② **载体不剥 `Range`、不改写响应、不缓冲** —— `Range: bytes=0-3` → **206** + `content-range: bytes 0-3/10` + body `ABCD`（这三个头是 fixture 自己设的，载体只是原样送出，别读成载体自带 Range）；流式也在（三块 402/837/1236 ms，自定义头存活）；③ **`webServer` 存在**且 `kind:'prefix'` 服务深层子路径（`/probe-tree/a/b/c.js` → **200**），`ctx.get('webServer')` = `{ctor:'WebServer', port:5858, register:fn}`，`inject:['connection','webServer']` 的插件正常激活。**结论**：套件约定要求宿主路由走 Connection 载体（`plugins/AGENTS.md` 第 6 节），改用 `webServer` 是**破例**，要安全评审；这条约定没有随任何插件变动 | [x] |
| W13b | [x] | **真机组合实测**（`scratch/probe-desktop-routes/probe.cjs`，**21 项断言 / exit 0**）：走的是 shell 那一套 —— 入口 `dsh-desktop-host/lib/index.js`、`webShapeArgs` 同组位置参数（`--expose-internals <entry> <app> <profileDir> <runtime> <pnpm> <node>`，**无 `--patch`**）、`stdio` 含 `ipc`、URL 从 `ready` 消息拿、cookie 用 shell 自己的 `authenticateHostWeb` 换；组合由 shell 自己的代码铺（`prepareBrandSuite({layer:true})` + `installSuiteLayer`，层内容与真机 profile 里那份**逐字节相同**）。**四问的答案**：① `inject:['connection','webServer']` 的插件**激活**（`serviceCtor: 'WebServer'`, `port: 19387`, `register: fn`）；② `ctx.get('webServer')` 有值；③ `kind:'prefix'` 服务深层子路径（`/probe-tree/a/b/c.js` → 200，且 handler 自己的记录证明是它跑的，不是静态回落）；④ **栅栏问题测出来了**：同一条 prefix 路由，**无 cookie → 200**、带 `Origin: https://evil.example` → **200**；对照 `/api/…` 的 Connection 路由：无 cookie → **401**、带 cookie + 异源 Origin → **403**、带 cookie + 同源 → 200。即**栅栏不在服务器上，而由路由的拥有者各自施加**（`dsh-host-webserver` 的 `handle()` 零鉴权直派；`/api` 的 401/403 来自 Connection 的 `admit()`）。**结论**：任何想给资源树破例改用宿主 `webServer` 的想法，代价是那条路由**对回环端口上的任何进程开放、且不校验来源** —— 所以不破例。**证据源已转正**：本条的观测由永久探针 `scripts/probe-routes.cjs`（**32 项断言 / `RESULT: PASS (32 checks)` / exit 0**）守，前身留在 `scratch/probe-routes/` 与 `scratch/probe-desktop-routes/` 供追溯 | [x] |
| W14 | [–] | **决策记录（原工作项已随插件移除）**：这里原先排的是域插件宿主半边的移植（6 个固定端点改写成 Connection 的 exact 路由、资源树留给第二个来源），移植对象已从套件移除，工作项作废。**保留的只有结论**：① 套件宿主路由一律走 Connection 载体（`plugins/AGENTS.md` 第 6 节）；② 不为资源树破例改用宿主 `webServer` —— 真机 desktop-host 组合实测该层路由**对回环端口上任何进程开放、且不校验来源**（见 W13b）；③ 真机栅栏由 `scripts/probe-routes.cjs` 的 S5a / S5b 守着，栅栏一变就重做这条决策 | [–] |
