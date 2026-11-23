# CodeGraph：合成边——把运行时才连起来的两半接进图里

- Status: done
- Plan date: 2026-11-23
- Risk: medium
- Follows: codegraph-answer-sufficiency.md（done；其 N4 即本计划）

> 状态列是唯一进度源。本文件只写我们自己的做法与证据。

## Goal / Why

上一轮把答案做到「够用」；这一轮补「覆盖」。解析器只看见名字：preload 里的 `ipcRenderer.invoke(PLATFORM_IPC.open)` 与主进程里的 `ipcMain.handle(PLATFORM_IPC.open, …)` 是对两个 Electron 函数的两次调用，两个文件里没有任何一句说它们会相遇——是运行时按键把它们接起来的。本仓库实测（本计划之前）：四个平台 IPC 通道在两端之间**零条边**，对处理器问 `codegraph_impact` 得到「无直接调用者」，而这个应用唯一的调用者就在那里。

同一个形状出现三次，且每次的键两边写法完全一致（字符串字面量的内容，或点号连接的标识符链）：

| 配对 | 注册 | 分发 | 本仓库 |
|---|---|---|---|
| `ipc` | `ipcMain.handle / on / once (K, h)`、`ipcRenderer.on / once / addListener (K, h)` | `ipcRenderer.invoke / send / sendSync / sendTo (K)`、`<x>.webContents.send (K)` | 5 个通道，5 条边（之前 0）：4 条主→渲染，1 条渲染←主（`localeChanged`） |
| `event` | `<r>.on / once / addListener / subscribe (K, h)` | `<r>.emit / trigger / fire / publish / dispatch (K)`，**同一个接收者** `r`（`this` 除外），键要够具体 | 53 个注册，0 对——内核发这些事件，仓库里没有文件发 |
| `route` | `<app>.get / post / … / use ('/p', h)`，第二参数得证明是处理器 | `fetch('/p')`、`axios|http|… .<method>('/p')`，不看其它参数 | 0（唯一一个候选是客户端实例的 `app.post('/add', payload)`，被负载规则拒掉） |

副产品：内联处理器以前没有声明可指，现在是 `handler` 类符号（47 个），`codegraph_context` 能读到整个函数。

## Scope

- 解析侧：`ParsedCall` 带 `receiver / key / handler / endLine`（TS/JS 家族）。
- 存储 v6：`edges.provenance`、`registrations` 表、`SymbolKind` 加 `handler` / `route`。
- `synthesis.ts`：三条规则、合成符号、分发→注册的边、注册目标的两步解析。
- 渲染：行上 `⇢ ipc|event|route`，图例一次。
- Out of scope：Python 装饰器路由、Electron `contextBridge` 的 `window.x.fn()` 侧、别名导入的键折叠、跨层（HTTP/队列）边、设置页显示注册数。

## Work items

| # | 条目 | 状态 |
|---|---|---|
| S1 | 解析：`ParsedCall` 加 `receiver`（成员调用的接收者）、`key`（第一个参数是字符串字面量或点号链时的归一化文本）、`handler`（第二个参数是名字 / `(inline)`）、`endLine`（调用节点末行；扫描器语言无）。15 条真实语法用例 | [x] |
| S2 | 存储 v6：`registrations(path, line, kind, key, receiver, target, handler)` 与索引 `(kind, key)`；`edges.provenance`；`replaceFile` 带注册（重解析即替换）、`forgetFile` 连带删除；`registrationsFor` / `registrationsIn` | [x] |
| S3 | `synthesis.ts`：`synthesizeFile`（分类 + 合成 `handler` / `route` 符号 + 注册行）、`dispatchEdges`（分发对图中注册的查找）、`routeEdges`（路由→处理器）、`refineRegistrationTargets`（导入的处理器在全图就位后解析）、`resolveHandler`（本文件声明优先，其次全图唯一的可调用名）。**审查后加的规则**：分发侧由接收者与方法决定而不是参数（`fetch('/x', init)` 的 `init` 是负载）；route 的第二参数得是内联函数、本文件声明的可调用（含 `const h = () =>`）、路由器、或 import 子句带进来的名字，否则是负载（本仓库实测的误报）；`ipcRenderer.on` 是 IPC 的反向注册；`this` 不参与事件配对；合成 id 对已占用的 id 唯一（`~N`），同文件两条同路径路由不再撞主键；合成符号不进按名解析（`NAME_RESOLVABLE`）；名字与签名像声明头一样清洗、限 200；目标指向已退役的符号时先回到文件节点再重解析 | [x] |
| S4 | 接线：相 1 写合成符号与注册（带 import 名单）；相 2 先精化目标，再写分发边与路由边；`imports` 的 INSERT 补 `provenance`（漏掉时 NOT NULL 约束让 `INSERT OR IGNORE` 静默丢行——套件抓到的） | [x] |
| S5 | 读取与渲染：`referencesTo`、调用树的 `callersOf`、`context` 的 `callsOf` / `calledBy` 带 `provenance`；`Referrer.provenance`、`CallerNode.provenance`、`EdgeView.provenance`；schema 声明；列表、树、context 的行上 `⇢`，图例一次（列表与树合并收集，含 event 的接收者约定） | [x] |
| S6 | 度量：`scratch/codegraph-plan/measure-synth.mjs` 对本仓库跑一遍（只有计数与路径） | [x] |
| S7 | 按名解析的三处补口（第二轮审查）：文档提及的名字表、枢纽的同名计数、歧义候选都只认可解析的种类（`isResolvableKind` / `NAME_RESOLVABLE`）——合成 key 不能抢走真声明的 documents 边、不能把成对的真声明推成「同名三处」、不能当歧义候选 | [x] |

## Test plan

| # | 用例 | 预期 | 验证方式 | 结果 |
|---|------|------|----------|------|
| 1 | 解析：注册 / 分发 / 负载 / 泛型 / 注释 / 模板串 / 可选链 / 多行内联 | 字段按契约 | `tests/parse.test.ts`（15 条） | PASS |
| 2 | 三条配对与每条拒绝：IPC 两端与反向监听、`webContents.send` / `event.sender.send`；事件同接收者、`data`/`stream`/`process`/`this` 不配；路由声明与 `fetch`（含 `window.fetch`）/`axios`（带参数的也是分发）、无处理器的 `app.get` 是分发、负载/参数/成员链/`this.get` 不是注册、`const h = () =>` 是处理器；同键两次注册的 `~N`；同文件两条同路径路由不撞 id；导入的处理器留给精化；接收者/键/签名的清洗与 200 上限、键不剥注释 | `tests/synthesis.test.ts`（12 条） | PASS |
| 3 | 注册在图里活过做出它的那次 pass；导入的处理器在全图就位后解析；同名两处不再解析；目标指向已退役符号时回到文件节点；本文件声明优先于别处同名；重解析不带注册则删 | `tests/synthesis.test.ts` | PASS |
| 4 | 真实语法 + 真实索引器 + 注册的工具：`impact` onOpen → preload 的 `open`（`⇢ ipc`、行文本、图例、无 ✓）；内联处理器可按 id 查到、跨度等于注册调用；反向通道（渲染端监听 ← 主进程 `webContents.send`）；事件对、路由对、路由→处理器；depth 2 的树带同一个 `⇢`；key 与真函数同名时 `find` 列两种、`impact` 命中函数、`context` 的 calledBy 带标记与图例 | `tests/answers.test.ts` | PASS |
| 5 | 本仓库：900 文件 18.1 s；`ipc=5`、`event=53`、`route=0`、`handler=47`；五个通道的两端相连（含反向的 `localeChanged`）；无假路由 | `scratch/codegraph-plan/measure-synth.mjs` | PASS |
| 6 | 门禁 | 插件 857（839 / 18 / 0）、`tsc`、`build`、四道门禁、`check:graph`、根 typecheck、根套件 767（765 / 2）、三个静态门禁 | 见 Phase log | PASS |

## Verification commands

```sh
cd plugins/plugin-codegraph && npx tsc --noEmit && npm test && npm run build
node scripts/plugin-gates.mjs plugins/plugin-codegraph
npm run typecheck && npm test
npm run check:graph && npm run check:suites:gate && npm run check:slots && npm run check:touchpoints:gate
node scratch/codegraph-plan/measure-synth.mjs        # 本仓库的配对计数
```

真机：本仓库的四个 IPC 通道由度量脚本证明（它跑的是真实解析与真实索引器，只是不起 Electron 窗口）；模型侧的阅读由上一轮的真机点查覆盖（行文本与 `⇢` 标记在同一行格式里）。

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 设置页显示每项目的注册数与合成边数 | 本轮先证明配对成立；UI 是另一张表 | 用户问「为什么没连上」时 |
| 通过 `contextBridge` 的渲染端（`window.dsh.x()`）到 preload 的 `invoke` | 要把暴露对象的名字映射回 preload 文件 | 用户项目以渲染端调用为主时 |
| 别名导入的键折叠（`import { K as X }`） | 两边拼法不同就不配——保守，不猜 | 实测出现时 |
| Python 装饰器路由（`@app.get`） | 另一条语法族 | 用户项目以 Python 后端为主时 |
| 多层中间件路由（`app.get('/x', auth, handler)`）只记第一个中间件为处理器 | 解析只读第二个参数 | 实测出现时 |
| 同键新增一个内联注册在已有的之上、或在已有的之上插入一条同方法同路径的路由，`~N` 序号会移位 | 按 `~N` 唯一化只保证不撞；移位时旧 id 退役、指向它的入站边被删，下一次分发文件重解析时重建 | 用户项目里同键多内联处理器或同路径多路由的文件频繁改动时 |
| **注册变了，别的文件里已有的分发边不刷新**（新增处理器、删除注册、改目标） | 分发边只由分发文件那一次 pass 产生——与增量 pass 对每一条解析边的性质相同（后加的被调用方不会出现在未重解析的调用方里）；派生数据，整库重建即精确。修法是一张 dispatch 行表（kind、key、path、line、receiver、owner），在注册集合变化的 pass 里按键重算——另开一轮 | 用户项目的 `impact` 对一个已知存在的调用者答「无」时 |
| `refineRegistrationTargets` 每次带 pending 的 pass 全表扫一次 | 注册行量级是几十到几千，一条 UPDATE | 注册行上万时 |
| `registrations` 的 mtime 口径复核 | 注册随 `replaceFile` 走，与符号同生命周期；目标指向退役符号由对账 UPDATE 兜住 | 无 |

## Rollback

- 回滚即 revert 提交；schema 6 → 5 时旧版本打开会整库重建，`registrations` 表随之消失，无残留。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| S1–S7 | 2026-11-23 | 插件 857 条（839 通过 / 18 跳过 / 0 失败）；`tsc`、`build`、门禁、`check:graph`；根 typecheck、根套件 767（765 / 2）、三个静态门禁；本仓库度量：`ipc=5`、`event=53`、`route=0`、`handler=47`，五个通道相连（含反向）。两路独立审查两轮（`.devflow/codegraph-synthesized-edges/review.md`）：首轮一条 P1（同文件重复路由撞主键、整个 pass 失败）与九条 P2、三条安全应修；次轮六条 P2（context 不带标记、树图例只看根、按名解析漏三处、回归用例、`\p{Cf}` 记录失实）全部处置，R2-1 记入 Deferred | 完成。测试表 1–6 PASS |

五问：

- **主张复核**：「运行时才连起来的两半能接进图里」在本仓库成立（五个 IPC 通道，含反向的一条——审查前只连了四个）；事件与路由在本仓库没有可配对的分发，所以这两条规则只有形状级证据，没有真实代码的正面证据。
- **最小性**：不做别名折叠、不做跨层、不改 UI。
- **新风险**：合成边是惯例不是事实——`provenance` 列、`narrowed = 0`、列表与树的行上 `⇢` 与一次图例把它和解析边分开；处理器/负载的歧义靠「文件里这个名字是什么」判定（路由）或方法语义（IPC/事件的监听方法）；合成符号不进按名解析；id 唯一化不撞主键。
- **反例**：`ipcMain.handle(K)` 无处理器 → 不是注册；`bus.on('data')` → 键不具体；`stream.on('x')` / `this.on('x')` → 接收者被排除；`app.post('/x', token)`（参数）→ 不是注册；`fetch('/x', init)` → 是分发。
- **可检查性**：每条规则与拒绝都有用例；真实仓库的配对数可复跑。
