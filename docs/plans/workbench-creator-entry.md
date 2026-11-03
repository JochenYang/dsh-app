# 工作台的创造模式入口：在工作台里按需求做插件

- Status: done
- Note: 条目全 `[x]`；Creator 行与配套技能随 `feat(workbench): Creator entry that lands a card` 交付
- Plan date: 2026-11-02
- Risk: medium

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。

## Goal / Why

让用户能从侧栏进创造模式，一句话说清「我要在工作台里有一个什么样的卡片」，产出的插件就注册成工作台卡片，
和 `plugin-todo` 那张卡并排。今天创造模式只覆盖上游的三个落点（左侧栏、会话视图、右侧栏），工作台是
我们自己的容器，它既没有入口，也没有能被创造模式 agent 读到的座位契约。

成功标准：侧栏工作台那一行旁边多一个动作，点了进入创造模式并带上工作台专用的开场提示；创造模式产出的
插件能注册进 `workbench.item` / `workbench.view` 并正常渲染；agent 能通过一个 skill 拿到精确的座位契约，
而不是靠猜或靠抄一段会漂移的类型块。

## 事实基础（静态读取，未运行应用）

**创造模式是什么**：它不是新 API，是三样东西的组合。

1. **一个 agent preset，id 是 `cordis`**。上游「Add plugin」菜单里的「Create your plugin」项，启用条件就是
   roster 里有这个 preset（`dsh-client-ui-agent-preset/lib/client.js` 的 `CreatePluginMenuItem`）。
2. **一次客户端调用，带区域化开场提示**。`dsh-client-ui-entry-customization` 往三个 `*.actions` 座位挂行，
   每行做同一件事：`ctx.uiWorkspace.startSession(void 0, { agentPreset: "cordis", prompt: t("createPrompt.<region>"), whenDraftExists: "append" })`。
   三个区域是 `sidebar` / `conversation` / `right`，各自一句开场提示。
3. **沙箱动态挂载**。`dsh-tool-cordis` 给 agent 两个只读探测工具（`cordis_inspect_list` / `cordis_inspect_query`），
   产出的插件由 `dsh-cordis-host-runner` 作为 `cordis-dynamic` 组的子 fiber 挂载，不重启。

**这几样都在我们已装的内核里**（`0.2.1-rc.5`）：`dsh-tool-cordis`、`dsh-cordis-host-runner`、
`dsh-cordis-client-runner`、`dsh-client-ui-cordis`、`dsh-client-ui-entry-customization` 全部存在，
且 `entry-customization` 出现在内核的 `runtime-files.json` 里，说明**已被 loader 挂载**，不是仅仅躺在 node_modules。

**动态插件拿得到 `slots`**。客户端 runner 的守卫注释写明：「两个座位带额外机制：`slots`，注册代理会分配
遮蔽优先级并对普通条目与 Factory 定义记账」。所以产出的插件能注册进座位——这是本方案成立的前提。

**我们的容器**：`workbench.item`（list）与 `workbench.view`（keyed）由容器页面的 `children` 声明
（`plugins/plugin-workbench/src/client.ts:239-240`），`id` 与 `key` 必须是同一个 `VIEW_ID`。

## Scope

- Must-have:
  - **W1 入口行**：在 `sidebar.panellist.actions` 注册一行「在工作台里新建插件」，与工作台自己的侧栏行相邻。
    点击走 `ctx.get('uiWorkspace').startSession(undefined, { agentPreset: 'cordis', prompt, whenDraftExists: 'append' })`。
    服务按本插件既有纪律**结构化读取**：拿不到就返回 `pending`，不抛。
  - **W2 开场提示**：工作台专用的一句话，明确要求 agent 先加载 skill、再产出注册进 `workbench.item` /
    `workbench.view` 的插件，并说明卡片是**本次会话内有效**（见 W4 的取舍）。
  - **W3 座位契约 skill**：`plugin-workbench` 的宿主半边把 `dsh-app-workbench-card` 的 `SKILL.md` 装到
    `$DSH_HOME/skills/<name>/`，内容是两个座位名、`id`/`key` 同源、`order` 语义、卡片与页面的边界
    （容器拥有 frame、返回、Escape、卡片边框）。用 `writeFileAtomic`，与 `plugin-ppt/src/skill.ts` 同一套做法。
  - **W4 交付物**：版本 bump、changeset、`plugins/README.md` 的角色列从 client 改成 dual（宿主半边不再是空的）、
    字典 zh/en。
- Out of scope:
  - 把创造模式产出的卡片**持久化**成正式插件（见 Ruled out）。
  - 改动容器本身的卡片渲染、座位声明或 `workbench.view` 的 key 语义。
  - 上游那三个区域的行为、`cordis` preset 的内容、创造模式的探测工具。
  - 卡片上标注「这是临时卡片」——那需要读动态插件注册表，本轮不做（见 Deferred）。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 把座位契约写进开场提示 | 提示词只有一两句的空间，抄不全那段 `SlotMap`；容器一改就悄悄失真。skill 可版本化、可被检索、与容器同源 |
| 自动把产出的插件落盘进 profile 并登记 | 会静默改写用户的 profile（版本、卸载路径、五份名册的 `check:suites:gate` 全都要跟着处理）。这是安装行为，该由用户显式触发，属独立一轮 |
| 复刻上游的 roster 预检查来禁用入口 | 上游用的是 `dsh-client-ui-agent-preset` 内部的 `useAgentPresets` hook，不是公开服务。耦合它会在内核线一动时静默失效；改用本插件既有的「结构化读取 + 状态 token」 |
| 在工作台页面里再加一个空态入口 | 用户从侧栏进入创造模式是主路径；页面内再加一处是第二个入口、第二份提示词，收益不抵维护成本。等有真实使用反馈再加 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `src/client.ts`：往 `sidebar.panellist.actions` 注册「在工作台里新建插件」一行，`ctx.get('uiWorkspace')` 结构化读取，失败回状态 token | [x] |
| W2 | P0 | 工作台专用的开场提示：要求先加载 skill，再产出注册进两个座位的插件，并说明卡片本次会话内有效 | [x] |
| W3 | P0 | 新增 `src/skill.ts` + `src/index.ts` 的宿主半边：把 `dsh-app-workbench-card` 的 `SKILL.md` 装到 `$DSH_HOME/skills/`，`writeFileAtomic` | [x] |
| W4 | P1 | 测试：skill 内容含两个座位名与 `id`/`key` 同源；入口行注册与失败回 token；`src/**` 除字典外无汉字 | [x] |
| W5 | P2 | 交付物：版本 bump、changeset、`plugins/README.md` 角色列 client → dual、字典 zh/en | [x] |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选。

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 1 入口与提示 | W1, W2 | 条目全 `[x]`；T1–T2 PASS |
| 2 契约与交付 | W3, W4, W5 | 条目全 `[x]`；T3–T6 PASS；`check:suites:gate` 与 `check:graph` 绿 |

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| 侧栏工作台行旁新增「在工作台里新建插件」动作 | added | `plugins/plugin-workbench/src/client.ts` |
| 宿主半边从空实现变为安装 skill | modified | `plugins/plugin-workbench/src/index.ts` |
| 插件角色 client → dual | modified | `plugins/plugin-workbench/package.json`（peer/dev 增 `dsh-atomic-write`）、`plugins/README.md` |
| `$DSH_HOME/skills/dsh-app-workbench-card/` 出现新 skill | added | 新增 `plugins/plugin-workbench/src/skill.ts` |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 入口注册 | 以假 ctx 应用客户端半边 | 注册进 `sidebar.panellist.actions`；`uiWorkspace` 缺失时点击返回 `pending` 而非抛出 | `npm test` | PASS (`npm test`, 2026-11-02) |
| 2 (W2) | 提示词 | 读提示常量 | 含「先加载 skill」与「本次会话内有效」；**不含**座位名（防止第二份契约）；不含 Han | `npm test` | PASS (`npm test`, 2026-11-02) |
| 3 (W3) | skill 安装 | 在临时 `$DSH_HOME` 应用宿主半边 | `skills/dsh-app-workbench-card/SKILL.md` 存在且含两个座位名与 `id`/`key` 同源说明；产物含真反引号 | `npm test` | PASS (`npm test`, 2026-11-02) |
| 4 (W3) | 重复安装 | 连跑两次 | 幂等，不产生第二份或半截文件 | `npm test` | PASS (`npm test`, 2026-11-02) |
| 5 (W4) | 套件一致性 | 改完版本与角色列 | `check:suites:gate`、`check:graph`、`check:slot-registrations` 绿 | 根目录执行 | PASS (`check-suites-drift --check` + `check-plugin-graph` + `check-slot-registrations`, 2026-11-02) |
| 6 | 真机走查 | `npm run dev` 点该入口 | 进入创造模式并带上工作台提示 | `npm run dev` 手工 | pending（本环境无图形界面） |

## Verification commands

```sh
cd plugins/plugin-workbench && npm run typecheck && npm run build && npm test
npm run check:suites:gate        # 根目录
npm run check:graph              # 根目录
npm test                         # 根目录
```

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 把产出持久化为正式插件 | 会静默改写用户 profile，需要版本、卸载与名册门禁一整套 | 出现「希望这张卡重启后还在」的真实反馈时 |
| 卡片上标注「临时」 | 需要读动态插件注册表来判断某个卡片是否来自动态插件，属跨包耦合 | 与持久化一起评估 |
| 页面内的第二处入口 | 侧栏是主路径，第二入口带来第二份提示词 | 侧栏入口的使用数据表明需要时 |

## Rollback

代码改动集中在 `plugins/plugin-workbench/`，回退该目录与版本号即可；宿主半边新增的只是一个 skill 文件写入，
回退后已装到 `$DSH_HOME/skills/dsh-app-workbench-card/` 的目录会留下，但没有任何东西再引用它
（与 `plugin-ppt` 的 `RETIRED_SKILLS` 是同一类问题——若本插件被移除，该 skill 需登记进退役名册）。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 入口与提示 | 2026-11-02 | `cd plugins/plugin-workbench && npm run typecheck`=0；`npm test`=0（56 项全过）；`npm run build`=0；构建产物只有 `require("@deepseek-ai/dsh-client-ui-primitives")`，未内联其内部依赖；T1–T2 PASS | Gate 通过 |
| 2 契约与交付 | 2026-11-02 | 同上命令；T3–T4 PASS（skill 落地、幂等、产物含真反引号）；`node scripts/plugin-gates.mjs plugins/plugin-workbench`=0（21 个 import 全部声明、类型门未被跳过）；`check-slot-registrations`=0；`check-suites-drift --check`=0；根 `npm test`=0（729/727/0） | Gate 通过（T6 界面走查仍 pending，不阻塞代码项） |

## 实现期间纠正的四次偏离

首轮实现把这一行**手绘**成 `<button role="menuitem">`，理由是「primitives 进不了本插件的 import 图」。核实不成立：`plugins/build-lib.mjs:30` 把所有 `@deepseek-ai/*` 标成 external，构建路径不解析其内部依赖；真正的报错来自**测试**打包路径。正解是声明并安装 primitives（该插件此前从未声明过它），测试用 esbuild `alias` 指向桩——与 `plugin-swarm` 对 `@deepseek-ai/dsh-session` 用的是同一手法。现已改用 `MenuItemButton`，并留了「JSX 里不得出现 `<button` / `role="menuitem"` / `<svg>`」的断言，改回手绘会红。

第二轮之后修的一处：开场提示词起先硬编码成英文常量。那段文字是**预填进输入框的草稿**，用户会读会改，属用户可见文案，必须走字典；上游同一机制本来就分中英两套（`createPrompt.sidebar` 的中文是「创建一个带左侧栏入口的 DSH 插件。」）。现已移入 `src/client/locales.ts` 的 zh/en，技能名经插值从 `src/contract.ts` 取单一来源，并在点击时求值，所以切语言后立即生效。测试改为逐语言断言两份字典值都含技能名与会话内有效、都不含座位名，并断言发出的 prompt 与当前语言的字典值逐字相等。

行序也修过一处：我们的行原本与内核那条并列（都没给 `order`，默认 0），靠注册顺序落到「创建你的插件」之上。内核那条在一个条目里渲染两行，所以只能排在整条之后 —— 改成 `order: 1` 并加断言锁住。

第三处来自一次真实创造模式会话的日志复盘。首版技能正文把座位契约**指向仓库路径**（「去读 `plugins/plugin-workbench/src/client.ts` 里 BEGIN/END 之间的块，`plugin-todo` 重复了它」），而创造模式跑在**任意工作区**：那次会话在 `D:\codes\杂项\test`，于是 agent 先扑向构建产物（类型声明运行时不存在）、走丢到别人的插件仓库、翻了 profile 与端口进程，**第 50 次工具调用才第一次写文件**。更严重的是那段块本身不完整——它只含 `interface SlotMap`，引用的 `WorkbenchCardOwnerProps` 声明在块外（`src/client/page.tsx:73`），找到文件也编译不过。

现已让技能正文**自带完整契约**：声明块逐字嵌入、owner props 三个成员逐条列出、明确写「整份契约就在本文档，没有源码树要翻」。两条防漂移测试守住：①正文里的声明块与 `src/client.ts` 标记之间的文本归一化后逐字相同；②`page.tsx` 里 `WorkbenchCardOwnerProps` 的成员名集合与正文列出的集合双向相等（多一个少一个都红）。另有第三条断言正文不含任何仓库路径。三条都做过变异验证（改 `kind`、改成员名各只红对应那一条）。

第四处：上面那轮改完**实测成本没降**。重启后的一次真实会话（已确认加载到新版正文）仍是 209 次工具调用、第一次 `write` 在第 49 次，与改前的 202/50 持平。日志显示剩下的调用花在两件这份技能不覆盖的事上——动态插件的打包/挂载（读 `build.mjs`、`cordis.patch.yml`、`lib/client.js`）与数据存储/宿主路由（读 `plugin-todo` 的 `index.ts`、`wire.ts`、`api.ts`、`store.ts`），它甚至把 profile 里的 `suite-layer` 拷进了自己的插件目录。

于是技能补了三节：**本技能的边界**（打包归 `cordis-plugin-development`、数据落 `$DSH_HOME/storages/<plugin>` 且原子写、宿主路由走 `ctx.connection.fetch.register`）、**一个划算的例子入口**（`$DSH_PROFILE_DIR/node_modules/@dsh-app/plugin-todo/src` **存在才读**，不存在说明是打包安装、没有源码可读）、**禁止磁盘考古**（检出若存在也是另一个版本，学到的形状可能不是生效的那个）。

这里避开了一个真实的坑：`~/.dsh/profiles/dsh-app/node_modules/@dsh-app/plugin-todo` 在 dev 下是**指向工作树的符号链接**，所以看得到 `src/`；而该包的 `files` 是 `["lib","cordis.patch.yml","locale/*.json","icon.svg"]`，**`src` 不在打包清单里**。把那条路径写成无条件事实就是「在我机器上能用」。

路径断言相应**收窄**而非删除：仍禁盘符路径、`/d/`、`~/.dsh` 与 `plugins|scratch|docs|scripts|src/` 这类工作树相对路径；`@dsh-app/` 允许出现但必须紧绑在 `$DSH_PROFILE_DIR/node_modules/` 之后（正则断言前缀，不是宽松 includes）；并新增「必须提到 `cordis-plugin-development` 与 `$DSH_HOME/storages/`」。两次变异验证各自只红对应那一条。
