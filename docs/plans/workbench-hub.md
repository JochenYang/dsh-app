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

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1–W12, W17 | 条目全 `[x]`（W13/W13b 是后续弧、W14 是决策记录、W18 是 `[–]`，均不计入）；`npm run check:suites:gate` 与 `npm run check:graph` exit 0；插件 typecheck/build/测试全过；`npm test` 全绿；`scripts/probe-workbench.cjs` 全部断言 PASS / exit 0；运行时重建后 `verify --tgz` 与打包冒烟通过 | [x] |
| 2 | W13, W13b | 前缀匹配、`Range`、**`webServer` 是否可用**三项结论各自附命令输出 —— 三项都有（18 项断言 / exit 0）。**第三问附组合限定**：W13 走的是 CLI/`dsh web` 组合，shell 真机的 `dsh-desktop-host` 入口由 W13b 补测 | [x] |

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
  当时那批目录，新 runtime 里的这个插件永远不会被激活。所以 changeset 的 `shell` 字段是 `patch`
  而不是 `none`，且发布时需要 runtime + shell 同一次发布。
- **客户端多一个座位消费者**；不修改任何上游行的渲染。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | roster 五处一致 | — | exit 0，插件名称一致 | `npm run check:suites:gate` | PASS（当时 19 distinct names，no drift；此后名册又变过，判据是「五份一致」而不是那个数字） |
| 2 (W1) | 插件图规则 | — | exit 0 | `npm run check:graph` | PASS |
| 3 (W1) | 插件类型门 | — | exit 0 | `cd plugins/plugin-workbench && npm install --legacy-peer-deps && npm run typecheck` | PASS |
| 4 (W1) | 构建产物存在 | `npm run build` | `lib/index.js` 与 `lib/client.js` 都在且非空 | 同目录 | PASS |
| 5 (W10) | 插件自带测试 | — | 全过 | `cd plugins/plugin-workbench && npm test` | PASS（22 条：`tests/client-entry.test.ts` 13 + `tests/entry.test.ts` 9） |
| 6 (W10) | 根套件 | — | 全过 | 仓库根 `npm test` | PASS（当时 680 tests / 678 pass / 0 fail / 2 skipped） |
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
| 18 (W2) | 座位注册被静态门接受 | — | exit 0，列出 `sidebar.panellist` 与 `main` | `npm run check:slots` | PASS（当时 56 slots declared / 21 registrations judged / 0 not judged） |
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

## 收尾项（已调查、有意留到后续 —— 不是遗漏）

审查点过、我判断现在不做，逐条写在这里，免得下一个读者重新发现一遍。

| 项 | 位置 | 为什么现在不做 / 怎么补 |
|---|---|---|
| 探针里约 5 条冗余或恒真断言：`anchorMatchesRule` 恒假（锚点的父就是 grid，结构上不可能匹配）、`pageToken === null` 与 `pageInDom === false` 是同一读数、`gridContainsCard` 被 `cardInDom` 蕴含、`activeTabIndex` 被 `backTabIndex` 蕴含、6 条只断言 fixture 自己的标记 | `scripts/probe-workbench.cjs` | 合并不减守卫，只减数目；探针要守的是已交付行为，不是断言条数。fixture 那 6 条留 1 条作契约记录 |
| 探针「跑了 0 条也退 0」这条路径没被代码关死 | `scripts/probe-workbench.cjs` 的 `main()` | **已修（本轮）**：加 `passed === 0 → RESULT: FAIL (0 checks ran)` 分支，退出判定一并纳入 `passed === 0`。实测探针仍 `PASS (50 checks)` / exit 0 |
| `rowDataSlot === null` 断言过拟合到内核实现 | 同上 A1 段 | 上游给行加 `data-slot` 是纯改进，加了则探针变红而功能无回归；宜降级为打印（`rowAttributes` 已在打印） |
| 「有卡片时空态文案不在」缺一条断言 | 同上 A2 段（`emptyInDom` 已采到） | outlet 若改成 fallback 与条目同渲，现在那些断言仍全绿 |
| `aria-current="page"` 未断言 | 测试计划第 8 行 | **已修（本轮）**：A2 里加一条独立断言（点行后该行 `aria-current === 'page'`），探针由 50 条变 **51 条**、仍 exit 0 |
| `test/recursive-delete-guard` 的扫描根含 `scripts`，fixture 的生成 `lib/` 落进同步删除审计范围（今天无命中、根套件绿，将来会以「生成文件里有未审计的删除」这种难懂理由变红） | `test/recursive-delete-guard.test.mjs:37-41,164` | **已修（本轮）**：豁免正则从 `^plugins\/[^/]+\/lib$` 扩到 `^(?:plugins\/[^/]+\|scripts\/fixtures\/[^/]+)\/lib$`。实测该测试文件 exit 0（三条断言全过） |
| 座位检查器的 `keyProps` 假阳性：内联 `keyProps: { 'x': { … } }` 会被当成已声明座位，从而**掩盖一次真实退休** | `scripts/check-slot-registrations.mjs:159-176` | **已修（本轮）**：判据改成**只认 SlotMap 体的顶层键**（按 `{`/`}` 数深度），比「跳过 `keyProps` 之后的对象」更硬 —— 后者依赖成员顺序。同时**回退**了一版「要求条目体以 `kind:` 开头」的写法：它会给「`scope` 写在 `kind` 前」的合法座位带来**假阴性**。实测 `check:slots` 计数不变（56/21/0），新增回归用例 9/9 过，且做过反例（摘掉深度判据该用例变红） |
| `docs/agents/kernel-line-regression.md` 同一节里仍有「根 + 16 插件 spec 同改」这条**给下次升线复用的操作模板**，以及「当前扫 738 个文件」「当前 14 次注册」这类当下值（W17 改了同文件的另一处） | `:407`、`:40`、`:88` | 同一次描述性同步的漏项；改成当下数字或去掉具体数字 |
| 根 README 能力表里 `plugin-rewind`、`plugin-effort` 缺行（中文比英文多一行的既有不对称，与本轮无关） | `README.md` / `README.en.md` | 写它们等于新写两段能力描述，超出「同步计数」的范围 |
| 两份 workspace-entry 实现的漂移测试 | `plugins/plugin-workbench/src/client/entry.ts` vs `plugins/plugin-client-ui/src/client/workspace-launch.ts`（Risks 9） | 两张用例表跑同一个 seam、断言 token 相同；随第一张真实卡片落地 |
| 域卡片契约的漂移测试 | `BEGIN/END workbench-card-slot` 标记块（Risks 10） | 同上，随第一张真实卡片落地 |
| ~~**W13 的路由探针没转正**~~ **已转正** | `scripts/probe-routes.cjs`（前身 `scratch/probe-routes/probe.cjs` + `scratch/probe-desktop-routes/probe.cjs`） | 两份一次性探针合成一份永久探针：启 **W13b 的真机 desktop-host 形态**（入口 `dsh-desktop-host/lib/index.js`、`webShapeArgs` 那组位置参数、无 `--patch`、URL 从 `ready` 消息拿、cookie 用 shell 自己的 `authenticateHostWeb` 换），把 W13 独有而 W13b 没测的 `Range` 与流式断言并进来（真机形态下同样用 shell 换来的 cookie 发 `/api` 请求，不需要页面）。**32 项断言 / `RESULT: PASS (32 checks)` / exit 0**。Q5（同一条 prefix 路由无 cookie 200、异源 200）由「测量并打印」升为**断言** —— W14 的决策压在这条上，栅栏一变就该红。两个 fixture 搬到 `scripts/fixtures/probe-routes` 与 `scripts/fixtures/probe-wsinject`（`src/` + `build.mjs`，产物 `lib/` 落进已有的 `scripts/fixtures/*/lib/` 忽略规则）。重跑时机登记在 `AGENTS.md` §4 与 `docs/agents/kernel-line-regression.md` §6.4 / §9。崩溃退 1、`passed === 0` 退 1、端口 19387 被占即报错退出，三条都实跑过 |
| W18 宫格内委托式方向键导航 | 见 Work items | 没有卡片可导航，且要与卡片契约漂移测试一起做才有东西可测 |
| **20 个文件 / 21 处写着一条实测为假的安全前提**：「the desktop host disables its `webserver` row, so a plugin that waits for it never activates」。**实测（真机 desktop-host 组合）**：该行由 `dsh-web-app` bundle 启用，`webServer` 可用。分布：`AGENTS.md:197`、`docs/agents/security-invariants.md:28`、`docs/desktop-optimization-plan.md:419`（主语是**上游官方** desktop，属历史记录 —— **保留 + 加注**，不改写历史），以及 17 个插件文件 / 18 处（`plugin-{archives,hooks,memory,doc,pdf,mcp,websearch,swarm,presets,sheet,ppt,brand,usage,sidebar}/src/**` 与 `plugin-sidebar/tests/routes.test.ts:6`）。**`plugins/plugin-brand/src/routes.ts:8-9` 不该删**：它说的是 frames 线（「every request arrives over the Electron byte pipe」），那条线上是真的 —— 加限定语即可 | 见左列 | **规则不变，只换理由；但我不擅自改安全不变式文档** —— 按你的规则这类改动先给方案、等你确认。理由现在已实测（见下一行），提议措辞也在下一行。另：本轮已修掉它的**根因** —— `src/main/brand-suite.ts:51-60` 的模块头把 frames 线的做法写成了无条件事实（连带 `plugins/README.md`、`docs/ARCHITECTURE.md` 两处，并带出片段 `changesets/suite-injection-channel.md`） |
| ~~「`webServer` 路由在 Connection 栅栏之外」这条还没测~~ **已测（本轮）** | `scratch/probe-desktop-routes/probe.cjs`（真机 desktop-host 组合，**21 项断言 / exit 0**） | **实测**：同一条 prefix 路由，**无 cookie → 200**、带 `Origin: https://evil.example` → **200**；对照 Connection 的 `/api` 路由：无 cookie → **401**、带 cookie + 异源 Origin → **403**、带 cookie + 同源 → 200。**栅栏由路由的拥有者各自施加，不在服务器上**。**提议的不变式措辞**（规则本身不变）：「套件宿主路由走 Connection 载体，因为该载体在派发前做浏览器鉴权与 Host/Origin 栅栏；而 `webServer` 路由对回环端口上任何进程开放、且不校验来源（实测）」 |
| **探针的运行时解包缓存只按来源路径判新鲜，不按内容** | `scripts/probe-workbench.cjs`（`extracted-from.txt`）与 `scripts/probe-routes.cjs` 同形 | **真实发生过**：运行时产物同名重建（名册多了一个插件）后，缓存树仍是旧的 19 个 `@dsh-app`，而 overlay 读的是工作树的 20 行 —— 于是新那一行报 `failed to import`，探针红 1 条。删掉 `scratch/probe-workbench/rt` 重解后 **51/51 绿**。**这不是回归，是缓存的假阴性**（响亮失败，不会假绿）。修法：`extracted-from.txt` 里记 tarball 的 `mtime+size`（或 sha512），不匹配就重解。**与名册变动的耦合是同一类**：名册一动，所有「产物 + 工作树 overlay」的探针都要重解一次 |
| 载体在客户端断开时**不取消**，而是把整条流读完 | 本套件第一条交出真文件流的路由（那条路由已随它的插件移除；**属性属载体**，任何未来的流式路由都会遇到） | 载体 `dsh-client-connection/lib/index.js` 的 `if (abort.signal.aborted) continue;` 是「继续读完」而不是「停」；插件侧无法修，属载体属性。后果：一个 256 MiB 的视频在客户端走后仍会被读一遍。**记录，不修** |

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1（W1+W2 切片） | 2026-10-14 | `check:suites:gate` exit 0（当时 19 distinct names / no drift）；`check:graph` exit 0；`check:slots` exit 0；`check:touchpoints:gate` exit 0；插件 typecheck/build/test exit 0；根 `npm test` 679 tests / 0 fail；临时内核探针 4 条全 PASS | 四问：**主张复核**——「侧边栏顶部出现工作台并排在插件之前」在真实 rc.2 内核上跑通，因果链每一环都有文件与行号；**最小性**——自绘图标保留（primitives 无语义合适的宫格字形），`order` 由 -10 收敛到 -1；**新风险**——入口先于容器页存在，必须与 W3 同 commit；**反例**——未注册 `main` 时点击抛错并保留选中态，已实跑。审查另找到三条必修：根套件第七份名单 `BASELINE`（已补，红转绿）、changeset 级别应为 `shell: patch`（已改）、`PANEL_ID` 一致性无守卫（已导出并被测试断言） |
| 1（W3+W4+W5 切片） | 2026-10-14 | 插件 typecheck/build/test exit 0（12 条）；`check:slots` exit 0（56/21/0）；`check:suites:gate`、`check:graph`、`check:touchpoints:gate`、根 `npm test` 全 exit 0；临时内核探针 6 组证据全过（含 expando token 的卸载验证与卡框落点测量）；`test/slot-registrations.test.mjs` 8 条全过，其中新增的平座 id 用例已做反例验证 | 四问：**主张复核**——「点卡片进入域页面」与「离开面板即重置」都在真实内核上跑通；**最小性**——用座位自带的 `fallback` 与「卸载即重置」省掉了 store 与订阅，座位数从 3 收敛到 2；**新风险**——卡框依赖渲染器的 `data-slot` 锚点（已记 Risks 7），空态分支改由 outlet 订阅（修掉了一处「父组件读未订阅注册表」的真实缺陷）；**反例**——(a) 探针量到卡框原本打在 `display: contents` 锚点上、卡片身上全为 0，修后锚点全 0、卡片拿到框；(b) 检查器正则改回旧版会让平座用例变红；**过程中自己踩了一次仓库明令禁止的坑**：在 template-literal CSS 的注释里用了反引号，构建当场失败，同一切片内犯过两次——这条规则由构建兜住，没有再犯的余量 |
| 1（W6+W8 切片） | 2026-10-14 | 插件 typecheck/build/test exit 0（22 条）；`typecheck`、`check:suites:gate`、`check:graph`、`check:slots`、`check:touchpoints:gate` 全 exit 0；真实内核探针 **18 项 PASS / 0 FAIL**（会话入口三事实、失败文案逐字、零异常、按钮与焦点与 Escape）；根 `npm test` 全绿 | 四问：**主张复核**——「点会话型卡片进入工作区」由三个事实合起来证明（侧边栏工作区行出现、容器页从 DOM 消失、`activePanelId` 变 `null`），不是靠单一信号；**最小性**——入口不抽公共包（客户端半边是 loader 包裹的独立模块，跨插件 import 在结构上不成立），保留第二份实现并把「不抽」的理由写在模块头；**新风险**——`entry.ts` 与 `plugin-client-ui/client/workspace-launch.ts` 是同一段逻辑的两份，仓库对同款的既有处置是「重复 + 漂移测试」，那份测试还没有（记 Risks 9）；**反例**——审查指出「容器只能 (a)+(b)」过强（套件自己的维护设置容器就在别人注册的贡献上做了 roving focus），已改成「本轮只交付容器自己的那一半 + 卡片契约」，并把「委托导航」记为可做而未做。审查另外三条必修已闭合：W8 的 Escape 半边原本既没做也没记录（已实现并实测）；用户可见文案里印裸 host code 且漏掉唯一可操作的 `workspace/invalid-path`（已按 code 分句）；`openWorkspace` 抛错这条真实分支零覆盖（已补）。还修掉一处**测试假绿**：桩的 `t` 忽略插值参数，页面渲染出 `{code}` 也不会红 |
| 1（W11+W17 收口切片） | 2026-10-14 | 我实跑 `node_modules/.bin/electron scripts/probe-workbench.cjs` → 退出码 0、`RESULT: PASS (49 checks)`；`typecheck`、`check:suites:gate`、`check:graph`、`check:slots`、`check:touchpoints:gate` 全 exit 0；`changeset-gate` exit 0；根 `npm test` 680/678/0/2 | 四问：**主张复核**——「探针真的在断言」不靠它打印的 `PASS` 而靠「失败数 → 退出码」这条绑定，而这条绑定在搬运时被修过一次（前身 harness 崩溃时 `finally` 先于 catch 执行、断言数为 0，于是退 0）；**最小性**——49 条断言里确实有可合并的（同一事实的多角度测量），但每条都对应一条已交付行为，删任何一条都会留下一个无人守的角落；**新风险**——探针依赖渲染器给 `renderSlot` 锚点写的 `data-slot` 与侧边栏行的 `aria-label`，两者都是实现细节，上游改掉时断言会**响亮失败**（等的值不出现）而不是静默通过，这正是它该有的失败形态；**反例**——W17 若只改数字不改「当下测量值」的写法，每加一个插件就会过期一次（已改成不写死），历史计数若跟着改就是篡改历史（已一律保留） |
