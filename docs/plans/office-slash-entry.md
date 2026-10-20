# Office 套件的 `/` 入口

- Status: done
- Plan date: 2026-10-20
- Risk: medium

## Goal

在输入框键入 `/` 时，菜单里出现一个「办公」分组：四行（文档 / PDF 文档 / 演示文稿 / 电子表格），每行带
格式图标、中文名与一行能力说明；点击后输入框落一个 chip，其提交形态是对应技能的 `/name` 手势。

成功标准（**已按运行探针实测校正**：第 2、3 条里「发送后模型拿到技能正文」不是本探针能证明的事——
`userText` 装饰作用于已发送的消息气泡，验证它要么发一条消息（把模型调用放到关键路径上），要么在桌面
形态下才能成立；探针改断言机制层面的事实，见 Test plan）：

1. 已打开会话里打 `/`，菜单出现「办公」分组，恰好四行，顺序固定，每行有图标、中文名、一行说明；
2. 点击「文档」后输入框出现**一个** chip，其显示文字是「文档」、其提交形态（`clipboardText` 与
   `getTextContent()`）是 `/office-docx`，且该节点声明自己不可键盘选中、内联——这就是「一次删除整体
   移除」的机制保证；
3. 分组位于内核命令组之后、内核技能组之前；未选中会话的 hero 阶段没有 `/` 菜单（内核按会话注入），
   那里的入口仍是胶囊；
4. 既有能力零回归：胶囊开关、模板面板、PDF 工程、内核技能目录、`/dsh-ppt` 手工输入全部照旧；
5. 四项技能名与真实安装的技能名一致：`dsh-ppt` / `dsh-pdf` 由本套件安装（探针实测在目录里），
   `office-docx` / `office-xlsx` 由**桌面宿主**的 office 载荷提供（探针在 web 线上实测**不在**目录里，
   见下方更正说明）。

## Scope

- Must-have：菜单数据表与候选生成、触发源注册与 codec、四组字典键、图标映射、与既有两个源共存的
  唯一性、一条真 runtime 运行探针、版本号与 changeset、两处文档同步。
- Out of scope：chip 点击预览 SKILL.md（需要 `remote.skills` + `sidebarRight` + `dsh-resource` 地址文法）；
  新增插件或改动套件 roster；office bar 容器与胶囊行为；Word / Excel 的胶囊；任何标注/选区工作流；
  内核源码；`/documents` 这类英文命令名 + Enter 改写；**桌面形态的 office 技能解析**（见下方更正 1）。

**为什么落在 `plugin-ppt` 而不是新插件**：这个套件没有共享包机制（`plugin-pdf` 的 `office-bar.ts` 是
独立重述，不是 import 兄弟插件），而 `plugin-ppt` 已经是套件的 office 宿主——它持有共享的 office bar
容器契约、`OFFICE_FORMAT_ORDER`（已预留 `word` / `excel` 两个空位）、跨格式的 `RETIRED_SKILLS` 退役名单，
并且「在 roster 里、除安全模式外每次启动都挂载」。新增第 18 个插件要改五处 roster 副本、三处
「Seventeen」文案与一条 changeset，收益只是归属更纯，代价是更多可失效的坐标。菜单是四行静态数据，
放在既有宿主里是最小正确解。

**为什么候选的 `name` 用技能名而不是英文命令**：菜单渲染 `label`，`label` 与 `name` 不同时把 `name`
作为暗色别名显示（`name` 也是第二个搜索键）。若 `name` 写成 `documents`，用户照菜单教的名字打
`/documents` 回车，既没有源认领（本分组不实现 `matchEnter`），也不是任何技能名，消息就是一句普通
文本——菜单教会了一个不通的写法。写成 `dsh-pdf` / `office-docx` 时，手打同一个 token 发送就能触发
技能注入，界面上的别名与真正可用的手势是同一个字符串。代价是别名在视觉上不齐（两个内核名 + 两个
套件名），这一条记在 Deferred。

**两个由运行探针推翻、已更正的假设**（计划的其余部分已按实测重写）：

1. **`office-docx` / `office-xlsx` 在 web 线上不存在。** 内核的四个 `office-*` 技能是**桌面宿主**挂载的
   载荷：`runtime/office-skills/` 只被 `@deepseek-ai/dsh-desktop-host` 引用，`dsh web` 的技能目录里没有
   它们（实测：菜单的 skill 源不含任何 `office-*`；手打 `/office-docx` 不产生任何装饰）。所以这两行在
   桌面形态下可用、在 web 形态下只插入一个指向不存在技能的 token。**本轮不改这个范围**：桌面形态是产品
   的唯一交付形态（AGENTS.md §3 的 boot 路径就是 desktop-host），web 线只是探针的观测载体。探针因此用
   `dsh-ppt` 验证「别名与真实手势同串」这条不变量，`office-docx` 的解析留给桌面形态的探针（Deferred）。
2. **「一次 Backspace 删掉 chip」无法从页面外部驱动。** CDP `sendInputEvent`、原生 Range + `sendInputEvent`、
   `document.execCommand('delete')`（谎报成功）、合成 `beforeinput{inputType:'deleteContentBackward'}`
   （被 `preventDefault` 后什么都不删）四种都失败，因为 Lexical 的选区状态不接受外部写入。探针改为断言
   该节点的两个契约事实（`isKeyboardSelectable() === false`、`getTextContent()` 是完整的 `/office-docx`），
   它们才是「一次删除整体移除」的机制保证。真按键路径记在 Deferred。

**第三处更正（本轮开工后由事实推翻，比前两条更要紧）**：我曾把这一分组描述成「两套机制混用」——
说 `office-docx` / `office-xlsx` 需要用户自备 Python 环境。这是错的。核过三件事之后：

- `runtime-dist/primary-runtime-win32-x64/runtime.json` 的 `pythonPackages` 里已经包含
  `python-docx` / `python-pptx` / `openpyxl` / `pandas` —— 这些正是内核 office 技能的依赖，**随我们的
  安装包分发**；
- `src/main/desktop-host.ts` 会把这份 primary-runtime 的路径作为第四个位置参数交给内核子进程
  （`officePrimaryRuntime`），`load_workspace_dependencies` 就从这个路径取库；
- 因此桌面形态下四行**全都不需要用户安装任何东西**。

所以「菜单里一条要 Python、一条不要」这个说法不成立，缺口 2 也随之改变：需要透传的不是「引擎差异」，
而是「新做 vs 改已有」这条真正的分工边界（见 Deferred 里对它的处理）。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | 新增 `plugins/plugin-ppt/src/client/office-menu.ts`：`OFFICE_MENU_ITEMS` 四项数据表（`name` = 技能名、`iconKind`、`labelKey`、`descriptionKey`）+ `createOfficeMenuSource({ t, iconFor })`（`trigger:'/'`、`name:'dsh-office-menu'`、`order:1`、`showGroupTitle:false`、`candidates` 用 `rankByName` 过滤并带 `section: t('menu.group')` 与 `icon: iconFor(kind)`、`onPick` 返回 `{insert}`、`codec`）。**`lexicon` 刻意不声明**（内核 skill 源已滚动这些名字，重复声明只会重复装饰）；**`rankByName` 与图标工厂作为参数注入**，模块零运行时导入——否则插件 node 测试会把 primitives（react/shiki/katex）打进包，实测 88 个解析错误 | [x] |
| W2 | P0 | 注册与依赖：`plugins/plugin-ppt/src/client.ts` 在既有 `ctx.inject(['inputTriggers'])` 块内追加第二个 `scope.effect(() => registry.registerSource(...))`；新增 `plugins/plugin-ppt/src/client/office-menu-icons.tsx`（`officeMenuIcon(kind)` 用 primitives 的 `FileTypeIcon` 包一层，菜单只传 `{size}`）；。**未新增任何 npm 依赖**：沿用 `skill-reference.ts` 的结构类型读法（`ReferenceSourceRegistry` / `OfficeMenuRegistryLike`），服务用**单层** cast 读（`Parameters<…>[0]` 联合），`as unknown as` 计数保持 0，不抬 `type-escape-ratchet` 基线。`dsh.client.inject` **不动**：该服务由内核自己挂载，既有两个源已经靠 `ctx.inject` 等到它 | [x] |
| W3 | P0 | 字典：`plugins/plugin-ppt/src/client/locales.ts` 增加 `menu.group`、四项 `menu.<id>.label`、四项 `menu.<id>.description`。zh 是源，en 用 `Record<PptKey, string>` 约束，缺键即编译错。说明文字按**本产品真实能力**写，不照搬他处文案 | [x] |
| W4 | P0 | 图标映射：四类 `FileTypeKind` = `word` / `pdf` / `ppt` / `excel`，14px 下可辨；菜单渲染器只给组件传 `{size:14}`，因此包装组件只接受 `{ size?: number }`（`IconProps` 未从 primitives 的 index 导出） | [x] |
| W5 | P1 | 降级与唯一性：`registry === undefined` 时早返回（不注册 → 菜单里没有该分组，绝不出现空分组）；源名与既有 `dsh-office-ppt` / `dsh-office-pdf` 三者互不相同（同名注册会抛错）；注册必须包在 `scope.effect` 内，随插件 fiber 销毁 | [x] |
| W6 | P1 | 与既有源共存：`lexicon` 与内核 skill 源名称重叠只影响装饰、不产生重复 chip；胶囊插入路径仍走各自的源，`skill-prefill.ts` 的 `OFFICE_CHIP_TOKENS` **刻意不扩**到 `/office-docx` 等（一次性指令不是模式，清掉等于丢弃用户明确选中的东西） | [x] |
| W7 | P1 | 运行探针 `scripts/probe-office-menu.cjs`：解包真 runtime、起真内核、Electron 窗口；聚焦输入框后 `webContents.insertText('/')` 打开菜单，断言 A1–A6（见 Test plan）。触发条件写进 `AGENTS.md` §4 | [x] |
| W8 | P2 | 版本与 changeset：`plugins/plugin-ppt/package.json` `0.3.3` → `0.3.4`；`changesets/office-slash-entry.md`（`shell: none`、`plugins: plugin-ppt`，中英各一行） | [x] |
| W9 | P2 | 文档同步：`plugins/README.md` 的 `plugin-ppt` 行补上 `/` 入口职责；`AGENTS.md` §4 探针清单补 `probe-office-menu.cjs` 与其再跑触发条件 | [x] |
| W10 | OPT | chip 点击预览技能正文（`openReference`）——本轮不做，理由见 Deferred | [–] |
| W11 | OPT | 英文命令名 + `matchEnter` 改写 `/documents` 为 `/office-docx`——本轮不做，理由见 Deferred | [–] |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 纯逻辑 | W1, W3, W4 | 条目全 `[x]`；`npm run typecheck` 与插件测试全 PASS | [x] |
| 2 接线 | W2, W5, W6 | 条目全 `[x]`；`npm run build`、`npm run check:graph`、`npm run check:slots` PASS | [x] |
| 3 运行证据 | W7 | 探针 A1–A6 全 PASS，原始观测随输出打印 | [x] |
| 4 交付物 | W8, W9 | 条目全 `[x]`；`npm run check:suites:gate`、`npm run check:touchpoints` PASS | [x] |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。Gate 通过 = 该阶段条目的验证项全 PASS 且
review 无阻塞发现；条目从 `[~]` 转 `[x]` 前必须回答四问——主张复核、最小性、新风险、反例。

## Affected behaviors

- `/` 菜单的分组顺序变了：内核命令源 order 缺省 0 → 本分组 1 → 内核技能源 order 2。既有用户打 `/`
  会看到「办公」夹在「指令」和「技能」之间（此前只有两组）。
- 装饰词表重叠：本分组 `lexicon` 声明的四个技能名与内核 skill 源的词表重复。预期只是同一 token 被两个源
  声明、去重后装饰一次；需在探针里确认不出现重复 chip。
- 提交路径：chip 的源必须带 `codec`，否则发送被拒。本分组与 chip 在同一次 `onPick` 里，注册失败时
  菜单里根本不会出现该分组，因此不存在「有 chip 无 codec」的状态。
- 胶囊不受影响：`plugins/plugin-ppt/src/client/skill-prefill.ts` 的清理只认 `/dsh-ppt|dsh-word|dsh-sheet|dsh-pdf`，
  菜单插入的 `/office-docx` 不会被胶囊清掉。刻意保留：两个 chip 同时存在是用户可见、可自行删除的状态，
  比静默删掉用户刚选的东西好。已在 Deferred 登记回看条件。
- 菜单是会话作用域的：内核 `MenuView` 的 inject 需要 `sessions.scope(sessionId)`，因此 hero 阶段没有 `/`
  菜单，那里的入口仍是 office bar 胶囊。这一点由探针记录为观测事实，不是本次改动引入。
- `plugins/plugin-ppt/package.json` 版本变化会改 `suiteVersion`，因此这次改动必须产出一个新 runtime
  才能到达既有安装（AGENTS.md §12）；只改代码不 bump 版本，所有闸门照样全绿而用户什么也拿不到。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 数据表完整 | 读 `OFFICE_MENU_ITEMS` | 恰好 4 项；`name` 互不相同；`iconKind` 依次为 word/pdf/ppt/excel | `npm test`（plugin-ppt） | pending |
| 2 (W1) | 空 query 的候选 | `candidates(session, {query:''})` | 4 项，每项都有 `section`/`icon`/`label`/`description`，`section` 为 `menu.group` 的译文 | `npm test` | pending |
| 3 (W1) | query 过滤 | `'pdf'` / `'文档'` | 前者只剩 `dsh-pdf`；后者只剩 `office-docx` | `npm test` | pending |
| 4 (W1) | pick → chip | `onPick({candidate})` | `insert.ref === candidate.name`；`clipboardText === '/<name>'`；`appearance === 'file'`；`label` 是本地化格式名 | `npm test` | pending |
| 5 (W1) | codec | `clipboardText('dsh-pdf')`、`serialize('dsh-pdf')` | 都是 `/dsh-pdf`（token 本身就是可注入的技能名，不追加冗余句子） | `npm test` | pending |
| 6 (W1) | lexicon | `lexicon()` | 四个技能名，顺序与数据表一致 | `npm test` | pending |
| 7 (W3) | 字典完整性 | 编译 | zh 与 en 键集一致；少一个或多一个都编译失败 | `npm run typecheck` | pending |
| 8 (W2) | 注册形态 | 读 `src/client.ts` 文本 | 两处 `registerSource` 都在 `scope.effect` 内；两个源名不同 | `npm test` | pending |
| 9 (W5) | 无触发管线时不注册 | 读 `src/client.ts` | `registry === undefined` 时早返回，不产生空分组 | `npm test` | pending |
| 10 (W7) | A1 分组渲染 | 探针：聚焦输入框，输入 `/` | 菜单出现；存在文本为「办公」的 section 标题；恰好 4 个 `role="option"`，依次为 文档 / PDF 文档 / 演示文稿 / 电子表格，每个 option 有 `svg` 且说明逐字一致，别名等于技能名 | `electron scripts/probe-office-menu.cjs` | **PASS** |
| 11 (W7) | A2 位置与顺序 | 探针读 option 序列 | 四项连续；整体位于「技能」组之前、「指令」组之后 | 同上 | **PASS** |
| 12 (W7) | A3 选中落 chip | 点击「文档」 | 恰好一个 chip，源为 `dsh-office-menu`；显示文字「文档」；`clipboardText` 与 `getTextContent()` 都是 `/office-docx`；节点 `isInline()===true` 且 `isKeyboardSelectable()===false` | 同上 | **PASS**（真按键删除无法从页面外部驱动，见 Deferred） |
| 13 (W7) | A4 别名与真实手势同串 | 等技能目录列出 `dsh-ppt`；再打一段文字 | 目录里有 `dsh-ppt`（即菜单行的别名是一个真实技能名）；打字到达草稿 | 同上 | **PASS**（`office-docx` 在 web 线不在目录里，见更正 1） |
| 14 (W7) | A5 与胶囊共存 | 点 PPT 胶囊开关一次，再打 `/` | 仍恰好四行；四行全部来自同一个源名（比数标题更强）；「办公」标题只出现一次 | 同上 | **PASS** |
| 15 (W7) | A6 无错误 | 全程 | `window.onerror` 与 `unhandledrejection` 为空；内核日志无 failure 信号；无槽位渲染崩溃 | 同上 | **PASS** |
| 16 (W8) | 版本与片段 | 读 manifest 与 changeset | `0.3.4`；片段声明 `plugin-ppt`，中英各一行 | `npm run check:suites:gate` + CI changeset 门禁 | **PASS**（片段已用 `parseFragment` 实测解析） |

## Verification commands

- `cd plugins/plugin-ppt && npm run typecheck`
- `cd plugins/plugin-ppt && npm run build`
- `cd plugins/plugin-ppt && npm test`
- `npm run check:graph`
- `npm run check:slots`
- `npm run check:suites:gate`
- `npm run check:touchpoints`
- `npm run typecheck`
- `npm test`（根套件；先 build，需要 `dist/`）
- `node_modules/.bin/electron scripts/probe-office-menu.cjs`（真 runtime 探针；先 `npm run build` 与插件 build）
- `npm run verify`（真内核 smoke）

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| chip 点击预览技能正文（`openReference`） | 要引入 `remote.skills` / `sidebarRight` / `dsh-resource://file/session/<id>/<path>` 地址文法三件套；路径拼错时只是「点了没反应」，静默失败面比菜单本身大得多 | 当 Office 侧栏预览（或标注）成为下一个需求时，与它一起做，用同一条探针覆盖 |
| 英文命令名 `documents` + `matchEnter` 改写 | 会让别名与真实手势分叉，并引入「改写用户消息」这一新行为；`matchEnter` 一旦认领，`/documents 帮我改这份文档` 这种行也要定策略 | 当真有人抱怨别名不齐、或需要中英双写时；届时先补 `matchEnter` 的边界用例再动 |
| 胶囊清理不扩到 `/office-docx` 等 | 一次性指令不是模式；静默删掉用户刚选的 chip 比留下两个 chip 更糟 | 若实测出现「双 chip 导致模型走错技能」的真实投诉 |
| 把 `office-render` / `office-recalculate` / `office-export-pdf` 也列进分组 | 这些是模型在任务中途自己选的**操作型**技能，不是用户开局的入口；列进菜单只会把四行变成七行 | 当用户明确要求「从菜单直接做转换/渲染」时 |
| Word / Excel 的 office bar 胶囊 | 没有套件插件拥有它们（Word/Excel 生成是内核技能）；`OFFICE_FORMAT_ORDER` 里的 `word` / `excel` 两个空位继续留着 | 当套件真的接管 Word/Excel 生成时 |
| 桌面形态下 `office-docx` / `office-xlsx` 两行的端到端解析 | 探针跑的是 `dsh web`，而这两项技能是**桌面宿主**挂载的 office 载荷（`runtime/office-skills/` 只被 `dsh-desktop-host` 引用），web 线的技能目录里没有它们。要验证得让探针走 desktop-host 形态，那是另一套 boot 形状与断言 | 当需要给「办公四行全部可达」出具桌面形态证据时；届时应基于 `scripts/probe-routes.cjs` 的 desktop-host 启动形状再加一条 |
| 「一次 Backspace 删掉 chip」的真按键证据 | Lexical 的选区状态不接受页面外部写入：CDP `sendInputEvent`、原生 Range + 按键、`execCommand('delete')`（谎报成功）、合成 `beforeinput{deleteContentBackward}`（被 `preventDefault` 后不删）四种都失败。本轮改为断言机制事实（`isKeyboardSelectable()===false` + 完整 `getTextContent()`） | 当需要真按键证据时；可行路径是给探针注入一个 `dsh-app` 测试钩子在编辑器内用 Lexical 的非字符串命令 id 派发删除 |

刻意保留的简化在代码里标 `shortcut: <原因> / 何时该回来`，并登记到本表。

## Rollback

改动集中在 `plugins/plugin-ppt`（`src/client/office-menu.ts`、`office-menu-icons.tsx`、`client.ts`、
`locales.ts`、`package.json`）与新增的两个文件（探针、changeset）。回滚 = 用文件编辑工具把这些改回
先前状态并删除新增文件；不涉及数据迁移、不写 `$DSH_HOME`、不改 roster、不动 profile，因此无需清理任何
持久状态。回滚后 `suiteVersion` 随版本号回到旧值，已安装的 runtime 不受影响；菜单分组在下次启动消失。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 纯逻辑 | 2026-10-20 | `plugins/plugin-ppt`: `npm run typecheck` 通过；`npm test` 159 passed / 0 failed（含新增 `office-menu.test.ts` 17 项）；`node --test .test-dist/office-menu.test.test.mjs` 17/17 | **通过**。四问：①主张复核——17 项断言的是数据表完整性、候选生成、pick→chip、codec 双投影、排序位与无 lexicon；其中「内核技能名存在」改成读 `scripts/build-runtime.mjs` 的 `OFFICE_SKILL_NAMES`，不再是 grep 自己。②最小性——`rankByName` 与图标工厂改为参数注入，`office-menu.ts` 零运行时导入，避免插件 node 测试把 primitives（react/shiki/katex）打进包里（实测 88 个解析错误）。③新风险——`showGroupTitle:false` + 每项 `section` 依赖内核菜单「section 变化才画标题」的行为，已由探针 A1 覆盖（待阶段 3）。④反例——两个最初写坏的测试（grep 自身文件、正则比对源名）已替换为读真实事实源与导入真实常量 |
| 2 接线 | 2026-10-20 | `plugins/plugin-ppt`: `npm run typecheck` 通过；`npm run build` 生成 `lib/client.js`（含 `dsh-office-menu` 与四个技能名，primitives 保持 `require(...)` 外部化）；`npm test` 164 passed / 0 failed；`node scripts/plugin-gates.mjs plugins/plugin-ppt` type gate + import gate（33 处导入全声明）通过；根 `npm run check:graph`（含汉字检查）`ok — no violations`；`npm run check:slots` 全部 OK | **通过**。四问：①主张复核——接线由 5 项源码/产物断言覆盖（两处注册都在 `scope.effect`；真实 `rankByName` 注入；缺服务时早返回且早于两个注册；产物含四个技能名；primitives 仍为外部 require）。②最小性——未新增任何 npm 依赖，沿用 `skill-reference.ts` 的结构类型读法；`cast` 只做一次。③新风险——曾把 `registry.registerSource(...)` 改成带 cast 的写法，破坏了既有 `skill-reference.test.ts` 的精确断言（164 项里挂 1 项），已改回单次 cast 形式复验全绿；`skill-prefill` 的清理集合刻意未扩，并加断言锁住。④反例——用真实 `rankByName` 抽出实测：`''`→四项、`pdf`→`dsh-pdf`、`文档`→`office-docx`+`dsh-pdf`、`zzz`→空，与测试 double 完全一致 |
| 3 运行证据 | 2026-10-20 | `node_modules/.bin/electron scripts/probe-office-menu.cjs` → `RESULT: PASS (29 checks)`，真 runtime（`dsh-runtime-win32-x64-0.2.1-rc.2.tgz`）+ 真内核 + 工作树的 `plugin-ppt`。变异测试：把 `section: deps.t('menu.group')` 改成 `section: ''` 后重跑 → `FAIL (27 passed, 2 failed)`，两条「办公 section heading」断言精确报错；恢复后 `PASS (29 checks)` | **通过**。四问：①主张复核——29 条各自打印原始观测：A1 四行含 `hasGlyph: true`/`glyphPaths > 0`/说明逐字一致/「办公」标题唯一/别名等于技能名；A2 四项连续且落在「指令」与「技能」之间；A3 chip 源为 `dsh-office-menu`、`clipboardText` 与 `getTextContent()` 都是 `/office-docx`、`isKeyboardSelectable()===false`、`isInline()===true`；A5 重开后仍四项且**全部来自同一源名**（比数标题更强）；A6 无 error、无崩溃、日志无 failure。②最小性——探针不新增依赖、不依赖 LLM（预置一个 workspace 直接得到可编辑 composer 与一个会话），全部断言约 10 秒跑完。③新风险——探针自身曾三次静默失败：漏 `--patch`（suite 未挂载，`apply` 从未运行）、欢迎弹窗让页面 `inert`（聚焦失败）、管道缓冲导致挂住无输出；三者都改成「按名字失败」或「等状态而非睡固定时长」。④反例——**计划里被探针推翻的两个假设已更正**：(a) `office-docx`/`office-xlsx` 不在 web 线的技能目录（`runtime/office-skills` 只被 `dsh-desktop-host` 引用），A4 改测 `dsh-ppt`；(b)「一次 Backspace 删掉 chip」无法从页面外部驱动（CDP `sendInputEvent`、原生 Range、`execCommand('delete')`、合成 `beforeinput` 四种都失败），改为断言该节点的两个契约事实 |
| 4 交付物 | 2026-10-20 | `plugins/plugin-ppt`: `npm run typecheck` + `npm run build` + `npm test`（164 passed / 0 failed）；根 `npm run typecheck`、`npm run check:graph`（`ok — no violations`）、`npm run check:slots`（21 项全 OK）、`npm run check:suites:gate`（5 份 roster 无漂移）、`npm run check:touchpoints`（exit 0）、`npm test`（**691 tests / 689 pass / 0 fail**）；`node scripts/plugin-gates.mjs plugins/plugin-ppt`（type gate + import gate 33 处全声明）；`node_modules/.bin/electron scripts/probe-office-menu.cjs` → `RESULT: PASS (29 checks)`，并从**空 scratch** 重建复跑同样 PASS；`parseFragment` 实测 changeset 两行正文与 `shell: none` / `plugins: [plugin-ppt]` | **通过**。四问：①主张复核——`check:suites:gate` 未变（没动 roster）；版本 `0.3.3 → 0.3.4` 已生效（`npm run typecheck` 输出显示 `@dsh-app/plugin-ppt@0.3.4`）；changeset 被仓库自己的解析器读出预期结构。②最小性——没有新增 npm 依赖，没有改 roster、没有动 office bar 与胶囊。③新风险——**发现并修掉一个真实回归**：我最初用 `as unknown as` 读服务，把 `plugin-ppt` 的逃逸数从 12 抬到 14，触发既有的 `type-escape-ratchet` 门禁（`691 tests / fail 1`）；改成单层 cast（`Parameters<…>[0]` 联合）后归零，基线未被抬高，棘轮重新通过。④反例——临时调试打点（DOM marker、`console.log`）与 scratch 备份已全部清除并复验（`grep` 计数 0），探针在删除 scratch 产物后仍从零重建通过 |

## 后续轮次：Office 套件整体优化（2026-10-20 第二轮）

菜单入口落地后，按「哪个组合更好用」重新审了一遍套件，结论与改动如下。

### 事实基线（三条，都核过源码与产物）

1. **我们的模板是 PPTD 工程，不是 pptx。** `plugins/plugin-ppt/templates/` 下 390 个 `.pptd` / `.page`
   文件，没有一个 `.pptx`。所以「官方 `office-pptx` + 我们的模板」这个组合**在技术上不存在**——
   python-pptx 不认 PPTD。模板与版式门禁只有 `dsh-ppt` 有，读写既有 PPTX 只有 `office-pptx` 有。
2. **内核 office 技能的 Python 依赖随我们的安装包分发。** `runtime-dist/primary-runtime-win32-x64/runtime.json`
   的 `pythonPackages` 已含 `python-docx` / `python-pptx` / `openpyxl` / `pandas`；`src/main/desktop-host.ts`
   把该路径作为 `officePrimaryRuntime` 交给内核子进程，`load_workspace_dependencies` 从那里取库。
   **用户不需要自己装 Python**——这推翻了本轮开工时「两套机制混用」的说法。
3. **`pptxgenjs` 只能写不能读**（实测实例上没有 `readFile` / `loadPresentation`）。所以给 `dsh-ppt`
   加「改已有 PPTX」必须新增 OOXML 解析依赖。

### 本轮改动

| # | 内容 | 状态 |
|---|------|------|
| O1 | `plugin-pdf` 新增 `pdf_edit` 工具与 `src/pdfd/edit.ts`：保留/删除页面、旋转、追加其它 PDF、改元数据；页码从 0 开始、源文件不变、结果写新路径 | [x] |
| O2 | `plugin-ppt` / `plugin-pdf` 的 skill 正文写清「新做 vs 改已有」的硬边界，并说明 Python 随包（用户无需安装） | [x] |
| O3 | 两插件版本 bump（pdf 0.2.5→0.2.6，ppt 0.3.4→0.3.5）、`changesets/pdf-page-editing.md`、`plugins/README.md` | [x] |
| – | **不做**：给 `dsh-ppt` 加 PPTX 读取/改写 | [–] |

O1 的拒绝路径同样重要：保留与删除不可同时给、不能删光所有页、越界页码报出总页数、非 90 倍数旋转
被拒、空关键词数组被拒、非 PDF 字节与损坏的 merge 源都被拒并指名文件。19 个单测 + 1 条执行级 e2e
（含 5 个失败路径）覆盖。

O2 的「不做」理由：内核的 `office-pptx` 已经能读改既有 PPTX（python-pptx 随包），再实现一份是重复造，
且须新增 OOXML 解析依赖——违反「不手工解析成熟文件格式」的规则。正确做法是把分工写死在 skill 里，
让模型在用户拿现成文件时不至于试错。

### 本轮验证

- `plugins/plugin-pdf`：typecheck / build / **118 tests, 0 fail**
- `plugins/plugin-ppt`：typecheck / build / **164 tests, 0 fail**
- 根：`npm run typecheck`、`npm test`（**691 tests / 689 pass / 0 fail**）、`check:graph`、`check:suites:gate`、
  两插件 `plugin-gates.mjs` 全过
- `probe-office-menu.cjs`：**PASS (29 checks)**
- 变异测试两轮：破坏 merge 源的存在性校验 → e2e 精确报错；恢复后全绿

### 本轮发现的两个既有问题（非本轮引入，已用基线核验）

1. `test/suite-layer-keeper.test.mjs` 的「a pruned layer is put back while the app runs」是
   **稳定竞态**（10 次跑挂 6 次）。`git stash` 后在基线上跑 6 次挂 4 次，确认与本轮改动无关。
   它测的是 `src/main/suite-layer-keeper` 的恢复间隔，值得单独修。
2. 递归删除审计的 `plugins/*/tests/**` 计数因本轮新增 e2e 从 84 升到 86，已按该门禁自己的规矩
   更新 `AUDIT` 常量并写明理由（两个 mkdtemp 根，均为普通目录、无链接）。

## 后续轮次二：胶囊保留与 effort 键盘缺陷（2026-10-20 第三轮）

### 胶囊保留：不是二选一，是分工（决定，不是待议）

截图里 `/` 菜单与两个胶囊（PPT / PDF）同时存在。核对后确认**胶囊必须保留**，理由是模板选择
是胶囊独占的能力：

- 模板只能通过胶囊的 ▾ 面板选：它写 `POST /mode` 的 `template` 字段（`plugin-ppt/src/routes.ts`
  的 mode 路由）。`/` 菜单落一个 chip 就结束，**没有选模板这一步**。删掉胶囊，那 30 套模板就
  无法使用了。
- 模式是**会话级、跨轮次持续**的（`mode.json` 持久化）；`/` 菜单是**一次性指令**。两者语义不同。
- PDF 胶囊同理，PDF 模式也是会话级开关。

所以：**胶囊管「模式与模板」，菜单管「一次性请求」**。代价是同一件事有两个入口，用户可能困惑；
这一点作为已知取舍记录，不改代码——删掉任何一个都会丢能力。

### 修掉一个真实缺陷：effort 的「左右方向键可切换档位」

用户实测无效。根因不是文案写错，而是**监听挂错了元素**：

- `slider.tsx` 的 `onKeyDown` 只挂在 `track`（那条细滑块，`role="slider"`、`tabIndex=0`）上；
- 而 tooltip 提示是悬停 **track** 时出现的，用户点胶囊后焦点在**官方行**上，按方向键没有任何反应；
- 既有测试只断言 `aria-keyshortcuts="ArrowLeft ArrowRight"` 属性存在——**属性在、行为不通**，
  所以测试一直是绿的。

修复：把「一个按键走几档」抽成 `keyStep`、提交抽成 `stepTo`，两个监听共用同一张表；在
`host.row` 上再挂一个原生 `keydown` 监听。一个必须处理的细节：`track` 在 `row` **内部**
（capsule 的第二行），所以 row 的监听要排除 target 在 track 内的事件，否则一次按键会走两档。

验证：`plugin-effort` 163 tests / 0 fail，新增 3 条断言（行上有监听、track 被豁免、两监听共用
stepTo）。变异测试：删掉 row 监听 → 精确报 2 处失败；恢复后全绿。版本 `0.2.6 → 0.2.7`，
`changesets/effort-row-arrow-keys.md`。
