# CodeGraph 检索升级：让工具成为终点

- Status: done
- Plan date: 2026-11-04
- Risk: medium

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。

## Goal / Why

`plugin-codegraph` 现在只回答「在哪声明、谁引用、邻居是谁」，模型拿到答案后仍要 Read 一遍才能改代码。一次结构类提问的真实成本因此是「1 次工具调用 + N 次读文件」，图谱省下的探索又被读文件补回去了。

本计划把 `codegraph_context` 变成可以直接编辑的**终点**（带行号的源码 + 一句影响面），并把检索从「整名 / 子串」提升到「分段召回 + 字段过滤 + import 引导消歧」，同时收窄索引噪声，让答案少而准。

成功标准（全部可测）：

1. 对已索引符号调用一次 `codegraph_context`，返回的源码首尾行与声明严格一致、带行号、可直接 Edit；模型不再需要读同一文件（以真实会话观察为准，不以「工具调用次数」为准）。
2. 单次工具输出的字符数有上界，且该上界随项目规模单调不减；截断必须逐列表、逐文件说明。
3. camelCase / 下划线片段（如 `RulerMarks`、`dshcg`）在 `codegraph_find` 中命中，且「精确 → 前缀 → 词内 → 子串」的顺序稳定、同输入同输出。
4. 同名歧义在「只有一个候选被 import」时收敛到那一个；无法收敛时保持现有「不猜」行为。

## Scope

- Must-have:
  - `symbols` 记录声明结束行，`codegraph_context` 返回源码切片（含新鲜度校验与越界拒绝）
  - 输出预算：分档、有上界、逐文件截断可见
  - 检索精度：精确（大小写不敏感）短路 + 前缀/子串/多词分层 + `kind:` / `path:` / `lang:` / `name:` 字段过滤
  - 消歧：用已有的 `imports` 边收敛同名候选
  - 索引范围：`.gitignore`（根与嵌套）、生成文件、单文件大小上限，三类跳过计数分别可见
- Out of scope:
  - 语言数量扩张：除 Vue / Svelte / SQL 外不做（见 W14、W15）。这三门都不新增下载：两个组件语言复用 TypeScript 语法，SQL 用扫描器。其余每门要么需要我们换 CDN 并重新 pin + ABI 校验（Kotlin/Swift/Dart/Terraform 等 pin 的包里都没有），要么写第二个扫描器
  - 动态派发生成器（callback / 事件总线 / 框架重渲染 / 桥接层）
  - 框架路由节点与跳转边
  - 常驻文件监听、跨进程共享索引进程、原生编译的解析内核
  - 死代码分析、循环依赖报告、跨项目查询（`projectPath`）
  - 语义检索 / embedding

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 索引时把源码片段存进 `symbols` | 数据库变成仓库的第二份拷贝，且是过期的一份；改一行要重写整段文本。切片放查询期，用 `files.hash` 校验，存储不增、漂移可判 |
| 用「工具调用率」作为成功指标 | 我们已经用真实会话否证过这个判据：模型可以正确想到工具、再在列计划时放弃它。改判「读完答案后是否还需要 Read」 |
| 一次性把 34+ 语言补齐 | 单语言的提取表本身就带真实语法树验证成本（`tests/parse.test.ts` 每行一条）；边际收益低于输出形态的改变 |
| 用完整 import 解析器（路径别名 / workspace 包）一次性替换名字匹配 | 成本高、回归面大。先用已有的 `imports` 边做「候选收敛」这一小步，收益与风险之比更高，剩下一层留到边界数字说服人之后 |
| 引入项目内配置文件做 `include` / `deprioritize` | 在用户仓库里新增一个由我们解析的文件，需要 schema、路径校验与文档，是独立的产品决定；先只做 `.gitignore` 与内置判定 |
| 用常驻监听进程保新鲜度 | 我们在 `docs/agents/codegraph.md` §9 已经论证过：进程内 `tools/result` + 只读比对 + 补偿轮次覆盖了同一个问题域，且不引入驻留句柄与回收难题 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `symbols` 增加 `end_line`：`parse.ts` 从 `node.endPosition.row + 1` 取值，`SymbolRecord` / `replaceFile` / `symbolSpan` 贯通，`SCHEMA_VERSION` 3→4（派生的图用重建当迁移） | [x] |
| W2 | P0 | 新模块 `src/source.ts`：按 `(path, startLine, endLine)` 从磁盘切源码；只接受**已索引且位于图根之下**的路径；用 `files.hash` 复算判定漂移；带 `DSH_APP_CODEGRAPH_SOURCE=0` 关闭开关。同步更新 `docs/agents/codegraph.md` §2 模块表（读盘的第二个例外） | [x] |
| W3 | P0 | 输出预算函数（新 `src/budget.ts`）：按已索引文件数分档给出「每次调用总字符上限 / 每文件行数上限」，并断言「大档每文件字符数 ≥ 小档」；超限的单文件降级为裁剪并说明 | [x] |
| W4 | P0 | `codegraph_context` 符号分支返回源码：输出 schema 增 `source: { path, startLine, endLine, text, truncated, drift }`，render 明确「这就是 Read 的结果，不要重复读取」 | [x] |
| W5 | P0 | 答案级漂移标记：`sourceDrift` 改由 `source.drift` 承载（不新增第四态 `freshness`，两者关系写进 `docs/agents/codegraph.md` §9b） | [x] |
| W6 | P1 | 检索分层：`findSymbols` 改为「精确（大小写不敏感）结束搜索，否则前缀 → 子串 → 多词扫描按序合并」。**不建 FTS5 表**（见下方口径修正），多词用逐 token 的 `LIKE` 兜。移除发生在两轮审查之后，理由与实测已记录 | [x] |
| W7 | P1 | 字段化查询解析：`kind:` / `path:` / `lang:` / `name:`，未识别前缀回落为普通文本（新 `src/search.ts`） | [x] |
| W8 | P1 | import 引导消歧：调用边接入与 `relationEdges` 同一套 `linkFor` 三层规则（此前只有类型关系那条链有） | [x] |
| W9 | P1 | 走查范围：新 `src/ignore.ts`（`.gitignore` 解析与匹配、生成文件判定），走查与 `projectChanged` 共用同一判断；`ScanResult` / `IndexOutcome` 增 `ignored` / `generated`，设置页分别呈现 | [x] |
| W10 | P2 | 工具描述补上字段前缀（已做）；描述重写与 `isError` 审计结论：不重写（§8a 已证描述不改变工具选择），`isError` 只出现在 `requireCwd` 这一真实「停止尝试」场景 | [–] |
| W11 | OPT | `affected` 式受影响测试清单（复用 `imports` 边的传递闭包）：先只做 host 路由 + 设置页一个按钮，不新增模型工具 | [–] |
| W12 | P0 | 文档与索引：`docs/agents/codegraph.md` 的 §1/§2/§4/§5/§8/§9b/§10b 已更新；`docs/plans/README.md` 已加一行 | [x] |
| W21 | P1 | **Elixir / Lua / Zig / R / Julia / Haskell / Objective-C / Groovy**：八门 wasm 自建（commit 已钉进 §11），表全部来自真实语法树普查。为此 `GrammarShape` 补了四项能力：`nameChild` 支持路径、`declarations` 支持「同类型多规则」、`alsoCall`（ObjC 两种调用节点）、`heritageFields`（超类在字段上）。已知缺口：Groovy 语法对 `implements`/`enum`/带类型构造参数报 ERROR、`trait` 静默无声明，故不挂 `.gradle`；Elixir 没有调用边（一切皆是 `call` 节点） | [x] |
| W20 | P1 | **Scala**：wasm 自建（上游 `v0.26.4` / commit `8c0b6d4`，4.05MB），表里 10 个声明节点（`val_definition` 的 nameField 是 `pattern` 不是 `name`）；`call_expression` 有 `function` 字段；`import` 的 `path` 是重复字段只能拿首段（不产生 import 边，已写明）。压力验证：上游三个真实 Scala 源各 28/81/35 符号，无 ERROR | [x] |
| W19 | P1 | **Terraform / HCL**：新 `src/hcl.ts`，块头标签成地址（`aws_instance.web`、`var.region`、`module.db`、`data.aws_ami.ubuntu`），引用按同一套地址连边；注释与 heredoc 遮罩（heredoc 里的 JSON/脚本花括号不是 HCL）。`data.x.y` 不会重复匹配成资源地址 | [x] |
| W18 | P1 | **Kotlin / Swift / Dart**：三门语言的 wasm 由 tree-sitter 源码**自建**（pinned 的语法包里没有），随包提供；`GRAMMAR_SHAPES` 三张表由 `scratch/cg-grammar-dump.ts` 的真实语法树普查得出。ABI 闸门：`tree-sitter` CLI 0.27.1 ↔ `web-tree-sitter` 0.27.1，三份 wasm 均可 load、`hasError=false`、有符号。已知缺口（写成显式断言，不靠沉默）：Dart 无调用边（callee 在 `argument_part` 之外，现有 shape 表达不了）、Dart 函数体内声明的 parent 缺失、Kotlin 接口按 `extends` 记、Swift 的 struct/enum 落在 `kind: class` | [x] |
| W16 | P1 | **Astro**：`src/sfc.ts` 增加 `frontmatter` 形态——`---` 块按行遮罩（markup 全遮），复用随包的 TypeScript 语法。实测：`Warm-kitchen-time` 无 `.astro` 文件，故以真实语法的测试夹具覆盖（frontmatter 行号、模板-only、正文里的 `---` 不误判） | [x] |
| W17 | P1 | **Prisma / GraphQL SDL**：新增 `src/schema.ts`，一个「关键字 + 名字 + 花括号块」的扫描引擎 + 两张表（声明关键字、类型引用、标量白名单）。声明→`struct`/`enum`/`type`/`interface`；字段类型、`implements`、`union` 成员产生引用边。实测 `Warm-kitchen-time`：`schema.prisma` 的 12 个 model 带真实行号，`impact` 返回 6 处关系行 | [x] |
| W15 | P1 | **SQL**：新增 `src/sql.ts`，语句级扫描器（先遮罩注释/字符串/`$$` 体，再按 `;` 切）。声明 `CREATE TABLE`（→`struct`）/`VIEW`/`FUNCTION`/`PROCEDURE`/`TYPE`/`DOMAIN`；`REFERENCES`/`FROM`/`JOIN`/`INSERT`/`UPDATE`/`DELETE`/`ALTER TABLE` 产生指向声明的引用边，声明内的引用归到该声明。零下载（pin 的语法包里没有 SQL）。实测 Prisma 迁移：7 条入表引用边，`impact(AdminUser)` 返回两处引用行 | [x] |
| W14 | P1 | **Vue 与 Svelte**：新增 `src/sfc.ts`，把 `<script>` 块按原行/列遮罩出来（其余字符替换为空格、换行保留），交给已随包携带的 TypeScript 语法解析。零新增语法文件、零下载。模板里的表达式不解析（它们不是声明）。实测 `Warm-kitchen-time`：40 个 `.vue` → 861 个符号，索引文件数 287 → 377 | [x] |
| W13 | P0 | **本轮引入的回归修复**：升版后项目列表整体消失。两层修法：① `knownProjects()` 改用只读的 `peekProjectMeta`（不建 schema、不改 pragma、不写），列表不再触发重建；② `openGraph` 在 schema 重建时**先把 `meta.project` 读出来、重建后连同一份零计数写回**——项目身份不是派生数据，目录名是 cwd 的 sha256，丢了不可反推。现场已用 `plugin-memory` 同一套 hash 的 `project.json` + 会话记录反查出 12 个被清空图谱的 cwd 并写回 | [x] |
| W23 | P1 | **`codegraph_find` 每行打印 id**：`tool-text.ts` 的 `renderFind` 从「kind 名 — 路径:行 — N call site(s)」改成再追加 `(id: …)`；`formatSymbol` 不动（另有 4 处共用）。理由与项目无关：一个实体通常按表示法各有声明（类型别名 / ORM 的 model 类 / SQL 迁移建的表），`codegraph_impact` 只接受唯一名，名字歧义时它拒答并给候选，而旧行让模型没有可选选择器，只能退回按名搜文件。同步：`impact` 的「歧义即拒绝」语义不变（不并入探针），大计数提示改为 `prefer codegraph_impact`（id 已在行上，不重复打印），小计数提示改为「取上面任一个 id」（同样不重复 id） | [x] |
| W24 | P1 | **少用语言改按需下载**：`LanguageSpec` 增 `source: 'cdn' \| 'release'`；Scala / Elixir / Zig / Julia / Haskell / Groovy 六个自建语法改为 `bundled: false, source: 'release'`，其余常用语言（含 Kotlin / Swift / Dart / ObjC / Lua / R）仍随包。地址与哈希来源：`grammarUrls()` 生成两档候选（ModelScope 在前、GitHub release 在后，与内核 artifact 一致），同一份 sha512 校验每次尝试；内核版本取自 shell 已传的 `DSH_APP_KERNEL_VERSION`，缺失时报明确错误。字节移到插件内 `grammars-optional/`（已提交、不入包），`release.yml` 把它们随 `runtime-<version>` 发布；重装/升版用户这六门会先显示「未安装」计数，点下载即恢复 | [x] |
| W25 | P0 | **构造调用计入引用**：实测在 1728 文件的 TS monorepo 上，「references 边指向 class」的总数是 **0** —— `new Foo()` 不是 `call_expression`，对任何带构造语法的语言等于「每个类都没有调用方」。按真实语法树补 `alsoCall`：TS/TSX/JS `new_expression`(`constructor`)、Java/C# `object_creation_expression`(`type`)、Scala `instance_expression`(首个子节点)。修后同一仓库：`class Agent` 从 0 → **66** 条引用，指向 class 的 references 边 0 → **4055** 条。Dart 的 `Widget()` 是 `selector` 链，仍是无调用边的已知边界（已写进 §10b） | [x] |
| W26 | P1 | **工具不再依赖 web 载体**：`inject` 从 `['tools','connection','systemPrompt']` 改为 `['tools','systemPrompt']`，设置路由改走 `ctx.inject(['connection'], …)` 可选项。真实 headless 内核复现：`connection` 是必需项时整个插件 `pending`，会话回答「没有代码图谱工具」，模型于是用文本检索读了二十个文件 | [x] |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选（不做要写明理由）。

状态流转（就地更新，不得跳级）：`[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过；`[?]` 审查不通过，已回退或待重做；`[–]` 本轮不做（写明理由）；`[!]` 待用户决定。

**每个阶段的提交都要带**：`plugins/plugin-codegraph/package.json` 版本 bump（patch 位单数字，`0.8.9` → `0.9.0`，不得出现 `0.8.10`）与一份 `changesets/<kebab>.md`（`shell: none`，`plugins: plugin-codegraph`）。未 bump 的插件不会随 runtime 发出去，而所有本地门禁照样是绿的。

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 1 源码成为终点 | W1, W2, W3, W4, W5, W12 | 真实项目上一次 `codegraph_context` 返回可直接编辑的源码；越界与漂移两条负向用例通过；插件套件与四道门禁全过 |
| 2 检索精度 | W6, W7, W8 | 字段化查询与分层用例通过；消歧前后的边数对比已记入「本轮实测」 |
| 3 索引进噪 | W9 | 三类跳过计数在 dsh-app 与含 `node_modules` 的项目上分别可见；「索引不完整」的既有语义未被削弱 |
| 4 收尾 | W10, W11（可选） | 工具描述与 `isError` 审计用例通过；文档、索引、changeset 齐 |

阶段闸门：任何条目处于 `[~]`、`[?]` 或 `[!]` 时不得开始下一阶段。Gate 通过 = 该阶段条目的验证项全 PASS 且独立审查无阻塞发现；条目从 `[~]` 转 `[x]` 前必须回答四问（主张复核、最小性、新风险、反例）。

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| `symbols` 表结构（`end_line`）与 `SCHEMA_VERSION` 4 | modified | `plugins/plugin-codegraph/src/store.ts:177`、`src/store.ts:42` |
| 符号记录携带结束行 | modified | `src/store.ts:73`、`src/parse.ts:700` |
| `codegraph_context` 输出新增源码与拒绝码 | modified | `src/index.ts:800`、`src/query.ts` |
| `codegraph_find` 命中集与排序、字段前缀 | modified | `src/query.ts:318`、新 `src/search.ts` |
| 调用边解析在同名候选间的选择（import 层） | modified | `src/parse.ts`（`linkFor`）、`src/indexer.ts` |
| `imports[].names` 现含默认导入的本地名 | modified | `src/parse.ts` |
| 走查范围（`.gitignore`、生成文件、少索引一批文件） | modified | `src/indexer.ts:53`、`:56`、`:197`、新 `src/ignore.ts` |
| `projectChanged` 只对图里没有的文件读头部 | modified | `src/indexer.ts`（`scanProject` 的 `indexed` 参数） |
| 设置页新增两条计数文案 | modified | `src/client/section.tsx`、`src/client/locales.ts`、`src/routes.ts` |
| 源码切片与预算 | added | 新 `src/source.ts`、新 `src/budget.ts` |
| 漂移标记 `source.drift` 与 `sourceRefused` | added | `src/query.ts`、`src/tool-text.ts` |
| 受影响测试清单 | added | 见 W11（可选，本轮 `[–]`） |

`src/prompt.ts` **不在**本轮受影响范围：概览注入只读 `truncated` / `removalSkipped`，而 `ignored` / `generated` 与既有的 `tooLarge` 一样只活在一次 pass 的结果里（队列内存），模型侧看不到——这是既有形态，不是本轮遗漏。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 结束行落库 | 多行函数 / 类 / 方法 / 单行声明 | `end_line` = 声明最后一行，单行声明首末相同 | `npm test`（`tests/parse.test.ts`「declaration extent」） | PASS |
| 2 (W1) | schema 版本升级 | 旧版本 DB | 检测到版本不符后重建，不做迁移，不抛错 | `npm test`（`tests/store.test.ts`，用例已存在） | PASS |
| 3 (W2) | 切片边界 | 顶层与文件中部声明 | 文本首行为声明行、逐行带行号、不夹带相邻声明 | `npm test`（`tests/source.test.ts`） | PASS |
| 4 (W2) | 越界拒绝（负向） | 未索引路径、`../` 逃逸、索引后删除 | 分别返回 `not-indexed` / `outside-root` / `unreadable` | `npm test`（`tests/source.test.ts`） | PASS |
| 5 (W3) | 预算不倒挂 | 0…1e6 文件、NaN、负数 | 每文件行数与字符数随档位单调不减；异常值落到最小档 | `npm test`（`tests/budget.test.ts`） | PASS |
| 6 (W4) | 工具输出契约 | 真实图 + 一个符号，走真实 schema 校验 | `source` 通过 `validateJsonSchemaValue`，render 含「treat it as already read」 | `npm test`（`tests/schema-validation.test.ts`、`tests/tool-text.test.ts`） | PASS |
| 7 (W5) | 漂移标记（负向） | 索引后改写文件；图跨过文件末尾 | `source.drift: true`，返回的是磁盘当前字节，render 点名文件 | `npm test`（`tests/source.test.ts`、`tests/tool-text.test.ts`） | PASS |
| 8 (W6) | 排序与精确短路 | 精确名 + 同前缀名；词内命中 | 精确命中即结束搜索；`ruler` 找到 `diffRulerMarks` | `npm test`（`tests/query.test.ts`） | PASS |
| 9 (W6) | 召回不退化（负向） | 改动前 `LIKE` 能命中的名字；多词查询 | 子串层仍返回；`marks ruler` 由多词层返回 | `npm test`（`tests/query.test.ts`） | PASS |
| 10 (W7) | 字段过滤 | `kind:` / `path:` / `lang:` / `name:` 各一例 | 各自生效，可组合 | `npm test`（`tests/query.test.ts`） | PASS |
| 11 (W7) | 未知字段回落（负向） | `TODO:`、`C:\repo`、`name:`（空值） | 当普通文本处理，不报错、不变成空过滤 | `npm test`（`tests/search.test.ts`） | PASS |
| 12 (W8) | 消歧收敛 | 同名两处，仅一处被 import | 只连被 import 的那个（解析层 + 真实解析端到端各一条） | `npm test`（`tests/parse.test.ts`、`tests/e2e.test.ts`） | PASS |
| 13 (W8) | 歧义不猜（负向） | 无 import 时全连；import 指向的模块没声明时不连 | 不新增猜测性边 | `npm test`（`tests/parse.test.ts`） | PASS |
| 14 (W9) | 忽略、取反与优先级 | 根/嵌套 `.gitignore`、`!` 取反、`**` 通配 | 忽略生效；取反在被忽略目录内生效；`SKIP_DIRS` 优先于取反（见「口径修正」） | `npm test`（`tests/ignore.test.ts`、`tests/indexer.test.ts`） | PASS |
| 15 (W9) | 生成文件与超大文件 | `*.g.dart`、头部横幅、1.5 MiB 文件 | 分别计入 `generated` / `tooLarge`，不解析 | `npm test`（`tests/indexer.test.ts`、`tests/ignore.test.ts`） | PASS |
| 16 (W9) | 计数分别可见 | 走查结果 + 设置页文案 | `ignored` / `generated` / `tooLarge` 各自一条文案，en/zh 成对 | `npm test`（`tests/indexer.test.ts`、`tests/locales.test.ts`）+ `tsc` | PASS |
| 17 (W10) | `isError` 审计 | 检查三条工具的失败路径 | 结论：只有 `requireCwd`（无会话 cwd）抛错，其余「未索引 / 找不到」都是成功形状 + 指导 | 代码审计（`src/index.ts:1299`、`graphFor`） | N/A（无需改动） |
| 18 (W11) | 受影响测试（可选） | — | 本轮不做（见 W11 = `[–]`） | — | N/A（本轮不做） |
| 19 | 插件门禁 | 插件目录 | import / type / presence / freshness 四道全过 | `node scripts/plugin-gates.mjs plugins/plugin-codegraph` | PASS |
| 20 | 仓库套件 | 仓库根 | 类型检查与全部套件通过 | `npm run typecheck && npm test` | PASS（见下「口径修正」的 delete-guard 计数） |
| 21 | 真实内核路径 | `npm run dev`（工作树解析套件） | 会话内 `codegraph_context` 返回源码，设置页计数正确 | 手工 + 会话日志分析（`scratch/cg-session-zip.mjs`）：五轮会话中工具返回的源码块与行号入口都出现 | PASS（用户本人在应用内跑过并确认；脚本侧证据是会话日志，非自动化探针） |
| 22 (W12) | 文档与索引同步 | 改完的实现 | 模块表 / 新鲜度 / 边界章节已更新，索引有本计划一行 | `grep -n "source.ts" docs/agents/codegraph.md`；`grep -n "codegraph-retrieval-upgrade" docs/plans/README.md` | PASS |
| 23 (W13) | 升版后项目列表不丢 | 一个 `schema_version=3` 且带 `meta.cwd` 的库 | `knownProjects` 仍返回该项目，且调用后该库版本仍为 3、`project` 行仍在 | `npm test`（`tests/registration.test.ts`「reads an outdated graph WITHOUT rebuilding it」，已做反向验证：把实现换回 `openGraph` 该用例变红） | PASS |
| 24 (W23) | 每行 id 可用作 impact 选择器 | 真实图上一个在三种表示法里各有一份声明的名字 | 每行都带 `(id: …)`；每个 id 都过 `resolveSymbol` 并让 `referencesTo` 有答案 | 单测 `tests/tool-text.test.ts`（同名两声明各带自己的 id）；真实图 `node scratch/cg-find-id-probe.mjs "D:\codes\Warm-kitchen-time" AdminUser` → 3 个声明、3 个 id 全部 resolve | PASS |
| 25 (W18/W21) | 自建 wasm 的宿主兼容 | 20 个随包语法；12 份真实样例 | 全部 load 成功；样例 `error=false` | `node scratch/cg-wasm-probe.mjs` 在两套 Node 下各跑一遍（本地 v24.21.0、内核运行时自带 v22.23.4）| PASS |
| 26 | 真实内核装载套件 | 已安装内核目录 | 每个套件插件的入口都被激活（含 plugin-codegraph）；被点名的那几条路由与打包资源应答 | `npm run verify -- --runtime "<userData>/kernel/dsh-0.2.1-rc.5+suite-d6cfcef2"` → `all checks passed`（含「every suite plugin entry activated」）。注意它不解析源码、也不探 codegraph 自己的路由，所以它只证明「装得上」，不证明「语法能加载」 | PASS |
| 27 (W24) | 按需语法的地址与校验 | 六个 release 源语言 + 一个 CDN 源语言 | `grammarUrls` 给出 ModelScope→GitHub 两档；镜像 404 时落到第二档并校验通过；无内核版本时报明确错误；记录的 sha512 与 `grammars-optional/` 的字节逐份相等 | `npm test`（`tests/languages.test.ts` 新增 7 条） | PASS |
| 28 (W24) | 随包/按需的分界 | 语言表 | 随包 22 个 id / 14 个语法文件；六门 release 源不在 `BUNDLED_LANGUAGE_IDS` 里 | `npm test`（`tests/languages.test.ts`「ships the common set」）；`node scripts/plugin-gates.mjs`（presence 只看 `files` 里的 `grammars/*.wasm`） | PASS |
| 29 (W25) | 构造调用成为引用 | 真实语法：TS / Java / C# / Scala 各一例 | `new Widget()` 产生一条指向 `Widget` 的调用；真实 1728 文件仓库上 `class Agent` 引用数 0 → 66、指向 class 的 references 边 0 → 4055 | `npm test`（`tests/parse.test.ts`「counts a constructor call…」+「constructor calls across grammars」）；`scratch/` 直读 graph.db 计数 + 真实内核会话复核 | PASS |
| 30 (W26) | 没有 web 载体也能用工具 | 一个不提供 `connection` 的 Context | 三件工具照常注册，路由一条不注册，不抛错 | `npm test`（`tests/registration.test.ts`「mounts without a Connection carrier」）；真实 headless 内核会话：工具可用并回答「66 处引用」 | PASS |

**口径修正（实现后发现的偏差，已按现实改写而不是迁就原计划）**

| 原计划 | 实现 | 为什么 |
|---|---|---|
| W4 输出字段 `source:{...}`、W5 顶层 `sourceDrift` | 漂移放在 `source.drift`，不新增顶层字段 | 一个答案只有一个源码块，第二个布尔会把「哪段字节变了」丢成「有东西变了」 |
| W4「超限单文件降级为骨架（只给签名）」 | 改为按行/字符裁剪并在文本里说明 | 骨架需要 `signature` 列（本轮没加），而在现有数据上假装「骨架」只会少给代码却不说明 |
| T14 `dist/` + `!dist/keep.ts` | 取反只在项目自己声明的忽略目录里生效；`dist` 在 `SKIP_DIRS` 里，取反不能重开 | 若取反能重开底表目录，任何仓库一句 `!node_modules/x/index.d.ts` 就能让走查重回依赖树。该优先关系另有用例钉住 |
| W3 预算含「每次调用总字符上限」按档位 | 每档给出 `maxLines` + `maxChars` | 符号分支一次只覆盖一个声明，字符上限的实际作用是拦下压缩成一行的大文件 |
| W6 用 FTS5 虚表做分段索引 | 改为不建表：分词命中必然是子串命中（`ruler` 在 `diffRulerMarks` 里），而本工具不按分数排序，虚表只带来每符号一次写（实测 +11%）、一份名字副本和一个跨模块的 `rowid` 约定，召回一分不多。多词查询（`marks ruler`）是子串唯一答不了的情形，用逐 token 的 `LIKE` 即可 | 只有当检索开始**按相关度排序**（那时才需要 `bm25`）或符号量到百万级、`LIKE` 全扫成为瓶颈时 |

**本轮实测（脚本在 `scratch/`，未入版本）**

| 项 | 数字 | 怎么量的 |
|---|---|---|
| FTS 表本来会付的写放大（**已作为移除依据**） | 10000 符号 542ms vs 488ms → **+11%**、约 5µs/符号 | 一次性探针（脚本随表移除已删）：临时在 SCHEMA 里加回 `CREATE VIRTUAL TABLE symbols_fts USING fts5(text)` 并让 `replaceFile` 每符号写一行，与「把表换成同结构的普通表」各跑 250 文件 × 40 符号，取 `replaceFile` 循环耗时 |
| import 层删掉的调用边 | plugin-market 1050→1046（**-0.4%**，1 个文件收窄）；plugin-swarm / plugin-ppt / `src/main` 均为 **0** | `scratch/codegraph-import-layer-cost.mjs`：同一批 parse，`callEdges` 传/不传 resolver 各数一遍 |
| 有没有文件因此「失去全部调用方」 | **没有** | 同上，`filesThatLostEveryEdge` 为空 |
| 真实源码上的词内命中与切片 | `ruler` 命中 `DiffRulerMark` 与 `diffRulerMarks`；切片落在 158–182 行，首行即声明原文 | `scratch/codegraph-real-smoke.mjs`（对 `plugins/plugin-sidebar/src` 建图） |
| 自建 wasm 的加载与解析 | 20 个语法全部 load；12 门语言的真实样例 `error=false`（Node v24.21.0 与内核自带 v22.23.4 结果一致） | `scratch/cg-wasm-probe.mjs`（每门语法 `Language.load` + 解析 `scratch/language-fixture/` 里的样例，打印节点类型数与命名节点数） |
| 真实图上的 id 契约 | `AdminUser` 的 3 个声明各带 id，3 个 id 全部过 `resolveSymbol`，2 个 SQL/Prisma 声明各有 2 处引用 | `scratch/cg-find-id-probe.mjs <root> <name>`（先复制 graph 再 `openGraph`，不碰用户的库） |
| 构造调用漏报的规模（**W25 的依据**） | 1728 文件 / 60744 符号的 TS monorepo：`kind='references'` 且目标为 class 的边 **0** 条；`class Agent` 入边只有 1 contains + 1 exports + 4 type_refs，没有一条调用 | 直读 `graph.db`（`scratch/` 一次性 `node -e`），随后以真实内核会话复核：修前「0 处引用」，修后「66 处引用（40 shown + 26 truncated）」，与模型此前的 grep 计数一致 |
| 修后的图 | 同一仓库重索引：1728 文件 / 60744 符号 / 380480 边；指向 class 的 references 边 **4055**；`class Agent` **66** | 直读 `graph.db` 计数 |
| 少用语言按需下载的体积 | 六门 wasm 合计 12.86MB（Scala 3.86 / Haskell 3.66 / Julia 2.51 / Elixir 1.35 / Groovy 0.82 / Zig 0.66），`grammars/` 44MB → 31MB | `ls -S -l plugins/plugin-codegraph/grammars/*.wasm` |

**独立审查（三轮，原始报告在 `.devflow/codegraph-retrieval-upgrade/`）**

| 轮次 | 报告 | 结论与处置 |
|---|---|---|
| 1 | `review-line.md`、`review-oracle.md` | 2 条 P1 全部修（barrel 场景调用边归零、Phase log 缺边数证据）；5 条 P2 修（默认导入漏名、`ignored` 口径、检查路径读头、FTS 无维护测试、文档里 sourceDrift 的命名与 10x 重号）；一条判为「不改并写明」：`callEdges` 的本地符号表不加路径守卫，因为 `callerId` 在文件作用域调用时可能是符号 id |
| 2 | `review-fix-round2.md` | 6/9 修复完全成立，2 条留文档与用例缺口、1 条为可接受的契约选择；缺口全补（五种拒绝、悬空链接、`import * as ns` 断言、分层与 indexer 各两条用例） |
| 3 | `review-fts-removal.md` | 核心论证成立、参数顺序正确、`SCHEMA_VERSION` 4 正确；4 处散文仍在描述刚删的表 → 全部改写；多词门槛按「原始词数」计（`a star` 能命中 `aStar`）；补 AND 负向用例；`symbols_fts` 的清理改为无条件 `DROP`（版本相同的中间态库也能清掉） |

**本轮引入并已修的回归（W13）**：升版后设置页/侧边栏的项目列表整体消失。`knownProjects()` 为读 `meta.cwd` 调了 `openGraph`，而升版会先 drop 全部表——`meta` 连同 `project` 行一起没了，目录名又是 cwd 的 sha256，抹掉不可反推，于是列表既读不出项目、也把它们全部排除。修法是只读窥视 `peekProjectMeta`（不建 schema、不改 pragma、不写），重建仍只发生在真正打开项目时。已做反向验证：把实现换回 `openGraph`，T23 变红。

## Verification commands

```sh
cd plugins/plugin-codegraph && npm run typecheck && npm test
cd plugins/plugin-codegraph && npm run build
node scripts/plugin-gates.mjs plugins/plugin-codegraph
npm run check:graph
npm run check:suites:gate
npm run typecheck && npm test
npm run dev    # 真实内核路径；dev 从工作树解析套件
npm run verify -- --runtime "<userData>/kernel/dsh-<version>+suite-<hash>"   # 真实内核装载整套件
node scratch/cg-wasm-probe.mjs                                   # 20 个语法的 load + 12 门真实样例的 parse
node scratch/cg-find-id-probe.mjs "<project-root>" <name>         # 真实图上 find 的每个 id 都能当 impact 选择器
```

动到 `styles.ts`、语言行结构或行内动作按钮时追加：

```sh
node scripts/probe-codegraph-langs.cjs
```

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 项目内配置文件（`include` / `deprioritize` / 扩展名映射） | 在用户仓库里新增由我们解析的文件，需要 schema、路径校验、文档与一次独立安全审查；`.gitignore` 先覆盖大部分噪声 | 出现「某目录不该赢过业务代码，但仍要能被搜到」的真实抱怨时 |
| 完整 import 解析（tsconfig `paths`、workspace 包、别名） | W8 只收敛候选，不动解析器；完整解析的回归面覆盖整个 `parse.ts` 与 `indexer.ts` | W8 落地后若「同名双连」的计数仍显著偏高 |
| 语言数量扩张 | 每个新提取表都要真实语法树验证 + CI 上的 wasm 拉取，成本在验证不在代码 | 真实用户仓库里出现高频且完全未覆盖的语言 |
| 动态派发生成器（回调、事件总线、框架重渲染、桥接） | 「部分覆盖比不覆盖更糟」：桥一半会逼模型继续读；要做得端到端走通，是独立计划 | 出现反复追问「这条流怎么走通」而图谱停在边界上的场景 |
| 框架路由节点与跳转边 | 与本计划的正交价值高，但需要按框架逐个验证；先不混进检索升级 | 前端项目占比上升，或「点这个按钮去哪」成为高频问题 |
| 死代码、循环依赖、跨项目查询 | 各自独立且不改变现有答案的正确性 | 有人明确提出需求时 |
| 源码切片的语法高亮 | 客户端渲染成本与本计划的检索目标无关 | 可视化视图需要时 |
| `codegraph_context` 的文件分支返回整段源码（带 `offset`/`limit`） | 本轮只做了符号分支；文件分支仍是 outline。加这两个参数是查询面与 schema 的扩张，且要重新定义「文件分支的预算」 | 真实会话里出现「`codegraph_context(<路径>)` 之后模型仍去 Read 同一文件」时 |

## Rollback

- 插件级：从 `plugins/dsh-app.patch.yml` 移除 `codegraph` 行并同步五份 roster 副本，重启即恢复。
- 数据级：删除 `$DSH_HOME/storages/dsh-app-plugin-codegraph/` 整个目录；`SCHEMA_VERSION` 不一致时图的既有行为是「重建」，所以升版本身可自愈。
- 单条功能级：W2 提供 `DSH_APP_CODEGRAPH_SOURCE=0`，关闭源码切片后工具回到今天的形状，不需要回滚代码。
- 已知坑：
  - `src/parse.ts:366` 的位置类型是结构化类型（测试里有桩对象），加 `endPosition` 会波及这些桩，需一并更新。
  - 插件套件在本地默认有 16 个跳过（按需语言未下载）；`DSH_APP_CODEGRAPH_GRAMMARS=<dir>` 可跑到全绿，CI 用 `scripts/fetch-ci-grammars.mjs` 保证同一条件。
  - `npm test` 根套件曾出现偶发失败并重跑通过；报「改动前就有」之前必须先在基线复现。
  - 改动插件不影响打包产物，除非重新构建 runtime —— 发布是独立动作，不在本计划内。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 4 收尾（含 W23–W26） | 2026-11-04 | 插件 `npm run typecheck` 干净；`npm test` 588 用例 / 570 通过 / 18 skip / 0 fail，按 CI 口径（`DSH_APP_CODEGRAPH_GRAMMARS` 指向 14 份按需语法）**588/588 通过、0 skip**；`node scripts/plugin-gates.mjs plugins/plugin-codegraph` 四道全过；`npm run check:graph` ok；`node scripts/check-changeset.mjs --base HEAD` 通过；仓库根 `npm test` 731 用例 / 729 通过 / 2 skip / 0 fail。真实内核：`npm run verify -- --runtime "<userData>/kernel/dsh-0.2.1-rc.5+suite-d6cfcef2"` → `all checks passed`；真实 headless 内核会话（1728 文件的 TS monorepo，仓库外项目）复现并复核 W25/W26：修前 `class Agent` 0 引用、插件因 `connection` 待定而不可用，修后 66 引用（40 shown + 26 truncated）并与手工 grep 计数一致。`node scratch/cg-wasm-probe.mjs` 在两套 Node 下 20 个语法（14 随包 + 6 按需）全部 load、12 份样例 `error=false`。独立审查：`.devflow/codegraph-retrieval-upgrade/review-find-id.md`（1 条 P1 已改，6 条 P2/nit 已处置或记录） | 通过 |
