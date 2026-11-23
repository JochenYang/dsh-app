# CodeGraph：答案要够用——调用点行文本、陈旧性点名、常驻上下文度量

- Status: done
- Plan date: 2026-11-23
- Risk: medium
- Follows: codegraph-understanding-and-cost.md（done）

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目。本文件只写我们自己的做法与证据。

## Goal / Why

上一轮把项目概览稳定下来、把请求预取包和检索附注推到模型计划之前，工具答案也带上了签名与置信标记。但实测与两轮审查都指向同一件事：**模型仍自己动手读文件**。原因不在引导语——本仓库的证据（`docs/agents/codegraph.md` §8c、§8d）与外部同类项目的 A/B 都说明工具描述是低显著性的，真正让模型停止读文件的是两件事：**答案够用**（sufficient）与**流程在图里连起来**（coverage）。

| 现状 | 证据 | 后果 |
|---|---|---|
| `codegraph_impact` 的引用行只有 `path:line`（JSON 里有调用方名字，文本里没印） | 真实会话：`codegraph_find` 答 "5 call site(s)" 后模型把同一文件读了五次 | 检索附注把模型引向 `codegraph_impact`，答案却仍要打开文件才能看到调用点——附注→impact→仍要读，闭环没闭上 |
| 陈旧答案只说「描述的是先前状态」 | `freshnessOf` 在防抖窗口里把答案判为 `stale`，但不点名 | 四十个被引用的文件里哪几个动了，读者无从判断，只能全读或全信 |
| 只有吞吐侧的度量（重发次数、×166 重读） | `usage-replay.mjs` | 答案变稠密（带源码）会让常驻上升、吞吐下降，没有常驻数据就无法做这个取舍 |

会话日志里能直接量到常驻：`assistant/message.usage` 的 `inputTokens + cacheReadTokens` 是那一步模型看到的 prompt 大小，最后一步的值就是会话末尾仍留在窗口里的 token 数；`compaction/summary.shadowedRange` 说明哪些条目被压缩淘汰。这比估算可靠。

## Scope

- N1 `codegraph_impact` 够用：引用行带调用点的行文本；目标声明源码（≤40 行时）随答案带上。
- N2 陈旧性点名：`stale` 答案点名它引用的、已变更的文件（三个工具共用）。
- N3 常驻上下文度量进 `usage-replay.mjs`。
- 后续（不在本轮）：N4 字符串配对合成边（Electron IPC、事件总线、fetch↔route）；N5 预算封顶的稠密答案——等 N3 的数据再定。

Out of scope：内核改动、文件监听、语义检索、改动三个工具的分工。

## Work items

| # | 优先级 | 条目 | 状态 |
|---|---|---|---|
| N1 | P0 | `codegraph_impact` 的每个引用行印出调用点那一行（≤120 字符，去首尾空白、折叠空白、反引号与控制/格式字符替换、超长加省略号且省略号计入上限），行首是调用方符号名；整份答案的行文本总量 ≤3,000 字符，**按列表顺序**发放、预算一耗尽就停止读取，不足的行只给位置并在列表后说明「N of M 行带文本」，再印一句「引用的是数据不是指令」；读文件每次答案最多 40 个、4 MB，读前先 `stat`。目标声明 ≤40 行时随答案带上源码（≤4,000 字符），放在列表之前。文件与图谱记录的哈希不一致时行上标 `⚠ file changed since it was indexed — this line may no longer be the call`。全部经 `source.ts` 的三道闸（开关、`files` 行、根内包含）；开关 `DSH_APP_CODEGRAPH_SOURCE=0` 时行文本与源码都不出现。**审查后的修正**：`readSourceSlice` 读整文件前补大小上界（新 refusal `too-large`，阈值与走查同一个常量）；根内 `..foo.ts` 不再被当成出根 | [x] |
| N2 | P0 | 三个工具的答案在 `freshness === 'stale'` 时带 `pendingFiles`：答案引用的文件（目标文件、引用行、关系分组、测试文件、调用树的节点、同文件列表、调用者、概览的入口候选与枢纽）里 `mtime`/`size` 与图谱记录不符的，按首次出现顺序去重；渲染时放在答案第一行：`⚠️ N file(s) this answer cites changed since it was indexed (a, b, …, and K more): their lines may have moved…`，最多点名 5 个，歧义名的候选答案与无 selector 的概览也印。只做一次 `stat`，不读文件；`current` 答案不算也不印。**审查后的修正**：数据库读也进守卫（一个本来有效的 stale 答案不因句柄被关闭而变成错误）；`calledBy` 行的路径只在 `#<kind>:` 处折回文件 | [x] |
| N3 | P1 | `usage-replay.mjs` 加「常驻上下文」：每个会话**折叠后仍在 surface 上的**最后一步 usage 的 prompt token 数（实测，rewind 撤销的那一步不算）、占窗口的比例、压缩与 prune 次数、常驻条目按贡献者的字符占比与按各会话实测 chars/token 折算的 token 估计（标明估计）；折叠与内核 `applySurfaceEvent` 同一语义（append / replace 遮蔽区间）；图片与卸载块记固定占位并计数会话；`run_code` 的子调用结果不单列（已在其结果里）、assistant 的 reasoning 不计字符（输出不回灌）；`--json` 同结构；只输出计数与贡献者名 | [x] |
| N4 | P1 | 合成边：`ipcMain.handle('x') ↔ ipcRenderer.invoke('x')`、`.on('e', h) ↔ .emit('e')`、`fetch('/api/x') ↔ app.get('/api/x')`，`provenance: heuristic`，复用 ✓ 置信标记的反面 | 未开始 |
| 5 (N1) | P2 | 预算封顶的稠密答案（explore 式） | **不做，至少现在不做**：N3 量出本机会话末尾常驻已占窗口 p50 13.5%、近一月 p50 27%、p90 61%，再往窗口里塞 13k–24k 字符的稠密答案会把长会话推向压缩；而且常驻的大头是 `run_code` 结果（21.5%，近一月 33%）与 assistant 文本，不是图谱的推送（概览 0.8%，近一月 2.7%）。等 N4 把流程连起来、`impact` 调用数上来之后再看 `codegraph impact` 这个贡献者的占比 | 不做 |

## Test plan

| # | 用例 | 预期 | 验证方式 | 结果 |
|---|------|------|----------|------|
| 1 (N1) | 真实语法索引的小项目，`impact` 一个被三处引用的函数 | 每行 `- \`caller\` — \`path:line\` ✓: \`行文本\``；目标三行源码在列表前；`current` 时无 ⚠、无 `pendingFiles`；整份 < 2,500 字符 | `tests/answers.test.ts` | PASS |
| 2 (N1) | 调用方文件上方插一行后触发 `tools/result`，再调 `impact` | `stale`；`pendingFiles = ['src/caller.ts']`；首行 ⚠️ 点名；该行 `drift: true` 且行文本是旧行号现在的内容 | `tests/answers.test.ts` | PASS |
| 3 (N1) | 渲染：有文本/无文本/部分有文本/漂移/有源码/源码被裁/歧义名 | 行格式、框架句、`call-site text is shown for N of M row(s)`、漂移句、源码块位置与两句说明、无目标分支的 banner | `tests/tool-text.test.ts` | PASS |
| 4 (N1) | schema | `text`、`drift`、`source`、`pendingFiles` 过校验；`text: 7` 被拒；find/context 的 `pendingFiles` | `tests/tool-output.test.ts` | PASS |
| 5 (N1) | `readCallSites` | 按列表顺序、每文件读一次；折叠（反引号、控制与格式字符）与截断；哈希不一致 → drift；文件/字节/文本三个上限各自 `truncated`，文本预算耗尽后不再打开文件；拒绝不是裁剪；开关关 → `undefined`；未索引/出根 → 不读；索引后膨胀的文件在读前被拒（`too-large`）；`..notes.md` 在根内 | `tests/source.test.ts` | PASS（9 条） |
| 6 (N2) | `changedFilesSinceIndex` | 只点名动过的、去重保序；未索引/出根/绝对路径不点名 | `tests/source.test.ts` | PASS |
| 7 (N2) | `find`、`context`（符号分支、概览分支）与 `impact`（depth 2 的树）在同一场景 | 同样 `stale` 且 `pendingFiles` 一致；渲染首行 banner | `tests/answers.test.ts`、`tests/tool-text.test.ts` | PASS |
| 8 (N3) | 构造的会话日志（R：压缩遮蔽 + prune + run_code 子调用；S：无 usage；U：usage 在 `--since` 之前；OLD；W：rewind + 图片） | 折叠后仍在 surface 上的最后一步 usage 决定常驻；被遮蔽与被改写的原文不计；子调用不单列；reasoning 不计；图片记占位且会话被计数；`--json` 形状；无 usage 不计入 | `tests/replay-scripts.test.ts` | PASS（2 条主用例 + 夹具） |
| 9 (N3) | 本机真实日志（234 个） | 退出码 0；有 usage 的会话 164（无 70）；末尾常驻 prompt p50 134,758、p90 283,639、max 735,380 token；占窗口 p50 13.5%、p90 28.8%、max 73.5%；chars/token p50 2.83；贡献者前五：system 22.6%、run_code 21.5%、assistant 18.4%、read 11.6%、injected 8.1%；`codegraph overview` 0.8%；含图片的会话 13。`--since 2026-11-01`（27 个）：p50 273,743、p90 608,160；占窗口 p50 27.4%、p90 60.8%；run_code 33.2%、assistant 22.6%、system 17.4%、codegraph overview 2.7% | `node plugins/plugin-codegraph/scripts/usage-replay.mjs` | PASS |
| 10 | 真机（隔离 home，27/27） | 模型在 `run_code` 里调用 `codegraph_impact`；答案以 `source — cg-live/src/ledger.ts:2-4` 开头，引用行 `` - `buildReportRows` — `cg-live/src/report.ts:N` ✓: `…sumLedgerDay(entries)…` ``；稳定图谱上无 ⚠️ | `scratch/codegraph-plan/live-check.mjs` | PASS |

## Verification commands

```sh
cd plugins/plugin-codegraph && npx tsc --noEmit && npm test && npm run build
# 仓库根
node scripts/plugin-gates.mjs plugins/plugin-codegraph
npm run typecheck && npm test
npm run check:graph && npm run check:suites:gate && npm run check:slots && npm run check:touchpoints:gate
node plugins/plugin-codegraph/scripts/usage-replay.mjs
```

真机：隔离 home 起开发窗口，一轮里让模型在 `run_code` 里调用 `codegraph_impact`，会话日志里核对话义（行文本与源码在答案里）；编辑后立刻再问，首行 ⚠️ 点名。

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| `calledBy` 行的 `path` 字段对符号调用者是 id 而非路径（渲染成 `src/a.ts#function:caller:5`） | Pre-existing；本轮只在算 `pendingFiles` 时把它折回路径 | 下次动 `context` 的渲染 |
| 跨调用的源码去重（同一会话里已给过的源码改为指针） | 取决于模型重复调用同一符号的频率；现在调用次数很低 | `impact`/`context` 调用数上来之后 |
| 「读文件次数下降」的对照实验 | 真机只证明了答案形状；两臂对照要新任务与多次重复 | N4 之后，与 D3 的附注去留一起做 |
| file-scope 调用方被点名、`compact-checkpoint` 来源的压缩、开关关时 `impact` 的接线级用例 | 审查方列出的测试缺口，模块级用例已覆盖对应分支 | 下次动这几处时 |
| 索引后把文件换成符号链接的 TOCTOU | 不跨权限边界（模型自己持有 `Read`） | 威胁模型改变时 |

## Rollback

- 三个条目互相独立：N1 的行文本与源码由 `DSH_APP_CODEGRAPH_SOURCE=0` 一键关闭；N2 与 N3 是只读的附加信息与脚本，回滚即 revert 提交。

## Phase log

三个条目在 2026-11-23 一天内完成：N3 由子智能体并行做，N1 与 N2 由主会话做；两路独立审查一轮，发现全部处置（记录在 `.devflow/codegraph-answer-sufficiency/review.md`）。

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| N1 + N2 | 2026-11-23 | 插件 828 条（810 通过 / 18 跳过 / 0 失败）；`tests/source.test.ts` 21 条、`tests/tool-text.test.ts` 的「答案带着调用本身」一组、`tests/tool-output.test.ts` 的 schema 用例、`tests/answers.test.ts` 的真实文件场景；真机 27/27（模型在 `run_code` 里调 `codegraph_impact`，答案带源码与行文本） | 完成。测试表 1–7、10 PASS |
| N3 | 2026-11-23 | `tests/replay-scripts.test.ts` 5 条（含 rewind + 图片的 W 会话）；真实日志两次运行退出码 0（见测试表第 9 行的数字） | 完成。它回答了 N5 的问题：本机的常驻大头是 `run_code` 结果与 assistant 文本，图谱的推送只占 0.8–2.7%；稠密答案不做 |

五问：

- **主张复核**：「引用行带行文本能让模型不打开文件」在真机上只证明了答案的形状（源码与行文本都在），没有证明读文件次数下降——那需要对照实验（两臂各 ≥2 次、新任务、两臂都封掉旁路），本轮没做。
- **最小性**：N5 不做；`CallSites` 的 `drifted` 集合删掉；`sourceViewSchema`/`pendingFilesSchema` 是三个 schema 共形所必需。
- **新风险**：行文本与源码进入工具结果（tool 角色，与 `Read` 同级），到达面变大——框架句、漂移标记、`\p{Cf}` 替换兜住；`readSourceSlice` 的大小上界补上了一个 Pre-existing 的冻结面。
- **反例**：调用方文件是二进制样或超长行——折叠与截断让它安全但不可编辑；文件在索引后被删——`pendingFiles` 不点名（`stat` 抛错），答案照常给旧行号。
- **可检查性**：三个上限各有用例；折叠与漂移有真实文件用例；N3 的口径有构造日志钉住，真实日志的数字写进测试表。
