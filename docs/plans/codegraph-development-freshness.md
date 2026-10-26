# CodeGraph development freshness and truthful model output

- Status: done
- Plan date: 2026-10-26
- Risk: medium

## Goal
让模型在当前项目开发中获得及时、可继续查询且不夸大的依赖索引；未提交源码变化能自动进入增量索引，三个工具保持现有名称与数量。

## Scope
- Must-have: W1-W8；未提交修改后的索引触发、运行期间修改的补偿扫描、真实模型可见文本修正、版本与 changeset。
- Out of scope: embedding/语义搜索、类型检查器或变量级数据流、跨仓库索引、新工具、Memory 行为、UI 重构、Git 提交/发布。
- Non-goals: 保证动态分派或外部包的完整调用图；声称图替代源码阅读与测试。

## Work items
| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | 在现有 tools/result 生命周期上调度项目增量检查，覆盖未提交编辑及 shell 写入，避免读写工具本身制造重索引循环 | [x] |
| W2 | P0 | 索引运行或排队期间的后续变更不能被丢弃；同项目串行、同请求合并且补偿扫描可收敛 | [x] |
| W3 | P1 | 修正同名符号歧义提示、概览 id/名称的查询衔接，移除 CodeGraph 对 memory_save 的耦合 | [x] |
| W4 | P1 | 各输出列表独立报告截断，文本不得把导入/类型关系的样本显示为完整结果 | [x] |
| W5 | P1 | 为 extends/implements/type_refs/exports 使用各自准确的关系标签，未知关系不误标 | [x] |
| W6 | P2 | 用有界 indexing 提示替代首次索引静默；在概览说明实际索引关系与静态名称解析边界，不增加常驻内容膨胀 | [x] |
| W7 | P0 | 回归测试、typecheck、四道门禁、真实内核路径验证；记录跳过项 | [x] |
| W8 | P0 | 更新相关文档、插件 patch 版本与双语 changeset | [x] |

状态流转：`[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过；`[?]` 审查不通过。未经主会话 critical review 不得转 `[x]`。

## Phases
| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1-W8 | 回归测试及运行证据通过；独立 critical review 无 P0/P1 | [x] |

## Affected behaviors
- `src/index.ts`：freshnessOf、工具输出、系统提示、session/created 与新增工具结果监听。
- `src/queue.ts`：合并且不丢失索引期间发生的更新；维持并发一。
- `src/indexer.ts`：继续复用现有基于 stat/hash 的增量扫描，不能改成每次全量重建。
- `src/prompt.ts`：概览与 indexing/freshness 文本。
- `src/query.ts`：各列表的结果计数、截断元数据与关系语义。
- 现有 kernel 工具结果生命周期：`tools/result` 只做观察，不能改写工具结果或阻断原调用。

## Test plan
| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 未提交编辑 | 已索引后修改源码但 HEAD 不变，完成非 CodeGraph 工具调用 | 立即登记待检查（查询不得再报 current），只读检查证实变化后调度增量扫描；查询反映新符号/引用并恢复 current | `tests/freshness.test.ts`「indexes the edit a non-codegraph tool result reported」+ 真实内核 smoke | PASS（反向验证见 Phase log 第 1 行：去掉监听后该用例失败） |
| 2 (W1) | shell/嵌套写入 | 任一非 CodeGraph 工具结果，包括 shell 或嵌套调用 | 不依赖 write 工具名称；同样登记一次只读变化检查，证实后增量扫描 | `tests/freshness.test.ts`「treats any tool name as a possible write」 | PASS（工具名 `shell`，反向验证同样失败） |
| 3 (W2) | 运行期间继续修改 | 慢索引期间再次修改并请求扫描 | 不丢后续变化；串行补偿扫描；最终收敛 | `tests/queue.test.ts`「owes a compensating pass」「coalesces several mid-pass changes」 | PASS（反向验证：注释掉 `dirty` 记录后 3 个用例失败） |
| 4 (W2) | 合并与取消 | 大量工具结果、项目 dispose | 有界调度、无重索引循环、无未处理拒绝、卸载后不写库 | `tests/queue.test.ts` 的 check/forget 用例 + `tests/refresh.test.ts` 7 个用例 + `tests/freshness.test.ts`「does not re-index because a codegraph tool answered」「starts no pass after unload」 | PASS |
| 5 (W3) | 同名符号 | 2-10 个同名声明与概览条目 | 不再谎称未建边；输出能直接选择唯一 id，或明确先 find | `tests/tool-text.test.ts`「does not claim the edges are missing」「prints a copyable id for every hub」+ `tests/prompt.test.ts` | PASS |
| 6 (W4) | 非引用列表截断 | references 未截断而 imports/related 截断，及反向组合 | 每组 shown/total/truncated 真实且模型文本明确不完整 | `tests/tool-text.test.ts` 4 个截断用例（imports-only、references-only、both、group） | PASS（反向验证：把 `importsCut` 固定为 false 后 2 个用例失败） |
| 7 (W5) | 关系标签 | 分别渲染 extends/implements/type_refs/exports | 每种关系语义正确，未知关系不默认成 implements | `tests/tool-text.test.ts`「labels each relationship kind」「does not read an unknown kind」「all four kinds in one answer」 | PASS（反向验证：恢复 fallback 为 implements 后 3 个用例失败） |
| 8 (W6) | 提示边界 | indexing/current/失败/大型项目 | 有界 indexing 状态可见；关系覆盖与名称解析边界准确；无 memory_save 耦合 | `tests/prompt.test.ts` indexing/覆盖/memory 三组用例 + 行数上界 | PASS |
| 9 (W7) | 项目检查 | 插件及真实内核 | typecheck/test/plugin-gates 通过；真实调用路径可用 | Verification commands 全部执行，退出码见 Phase log | PASS（`npm run verify -- --tgz` 见 Phase log，真实模型路径的缺口在那里写明） |

## Verification commands
- `cd plugins/plugin-codegraph && npm run typecheck`
- `cd plugins/plugin-codegraph && npm test`
- `node scripts/plugin-gates.mjs plugins/plugin-codegraph`
- `npm run check:graph`
- `npm run check:suites:gate`
- `node scripts/check-changeset.mjs`（若项目脚本参数要求不同，以 package.json 为准）
- `npm run verify -- --tgz <匹配当前 kernel line 的 runtime tgz>`（使用已有本地 artifact；真实模型/工具路径若无法驱动须明确降级）

## Deferred
| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 持续文件系统 watcher | 本轮利用现有工具生命周期已覆盖开发代理写入；不新增常驻 watcher 与跨平台资源成本 | 用户从外部编辑器修改且期间完全没有工具调用仍要求即时刷新时 |
| 全量调用图语义保证 | 与既有名称解析设计冲突且范围大 | 引入类型解析或语言服务时 |
| 按包/目录的架构摘要 | 非本轮缺陷修复必要项，避免扩大常驻 prompt | 概览实测仍无法回答模块边界时 |

## Rollback
用文件编辑工具恢复本轮变更文件；索引为派生数据，不需要删除用户数据库，不执行 Git 历史操作。

## Phase log
| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 | 2026-10-26 | `cd plugins/plugin-codegraph && npm run typecheck` 0；`npm test` 366 tests / 348 pass / 18 skipped / 0 fail；root `npm test` 718 tests / 716 pass / 0 fail；`node scripts/plugin-gates.mjs plugins/plugin-codegraph` 0；`npm run check:graph` 0；`npm run check:suites:gate` 0；`node scripts/check-changeset.mjs --base HEAD` 0（另跑 `--tag v0.17.7` 0）；`npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz` 0（65 ok，多次）；真实内核 event probe 5/5 | 实现完成；**第 1 轮 critical review 未通过**：P1-A 删除项目被运行中索引重建、P1-B 只读工具结果误报 stale 并导致周期重扫、另有一项 schema 校验与文档核实要求 → W1/W2 置 `[?]` |
| 2 | 2026-10-26 | `cd plugins/plugin-codegraph && npm run typecheck` 0；`npm test` 383 tests / 365 pass / 18 skipped / 0 fail；`npm run build` 0；`node scripts/plugin-gates.mjs plugins/plugin-codegraph` 0；`npm run check:graph` 0；`npm run check:suites:gate` 0；`node scripts/check-changeset.mjs --base HEAD` 0；`node --test test/recursive-delete-guard.test.mjs` 0（审计计数 95→96）；root `npm test` 718 tests / 716 pass / 0 fail；`npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz` 0（65 ok）；真实内核 event probe 7/7（含 R6 只读流、R7 per-list 字段） | 三项阻塞按最小修复完成并各自反向验证；W1/W2 回到 `[~]`，等待第 2 轮 review |
| 3 | 2026-10-26 | `cd plugins/plugin-codegraph && npm run typecheck` 0；`npm test` 389 tests / 371 pass / 18 skipped / 0 fail；`npm run build` 0；`node scripts/plugin-gates.mjs plugins/plugin-codegraph` 0；`npm run check:graph` 0；`npm run check:suites:gate` 0；`node scripts/check-changeset.mjs --base HEAD` 0；`node --test test/recursive-delete-guard.test.mjs` 0（审计计数 96→98）；root `npm test` 718 tests / 716 pass / 0 fail；`npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz` 0（65 ok）；真实内核 probe 7/7 | 第 2 轮 review 的两项 P1（不可读根被当成 unchanged、unload 不等待被取消任务）已修复并各自反向验证；W 项保持 `[~]` |
| 4（最终） | 2026-10-26 | 审查记录 `.devflow/codegraph-development-freshness/review-final.md`（第 3 轮已收敛：无剩余 P0/P1/P2，四问通过）。主会话独立执行：插件 `npm run typecheck` 0；插件 `npm test` 389 tests / 371 pass / 18 skipped（按需下载的语法）/ 0 fail；插件 `npm run build` 0；`node scripts/plugin-gates.mjs plugins/plugin-codegraph` 0；`npm run check:graph` 0；`npm run check:suites:gate` 0；`node scripts/check-changeset.mjs --base HEAD` 0；`node --test test/recursive-delete-guard.test.mjs` 3 pass / 0 fail；root `npm test` 718 tests / 716 pass / 2 skipped / 0 fail；`npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz` 0（smoke all checks passed）；coder 另跑真实内核 probe 7/7 | **通过并收尾**：W1-W8 全部 `[x]`，Phases Gate `[x]`，Status `done`。第 3 轮无阻塞、四问（机制/最小性/新增风险/反例）通过；残余限制见审查记录「Residual limitations」，其中**真实模型会话未验证、交互式 `npm run dev` 未运行**，不得视为已验证 |

### Phase log 附注 — 反向验证与验证缺口
反向验证（每次只回退一处，跑完即恢复，最终树为修复后状态）：

第 1 轮：
- 删掉 `tools/result` 监听的触发（保留注册）→ `tests/freshness.test.ts` 2 个用例失败（未提交编辑、shell 路径），其余全绿。
- `importsCut` 固定为 false + `relationLabel` fallback 恢复为 implements → `tests/tool-text.test.ts` 5 个用例失败（imports 截断 2、关系标签 3）。
- `queue.invalidate` 的 `dirty` 记录删掉 → `tests/queue.test.ts` 3 个用例失败（补偿扫描、合并、上限）。
- `invalidate` 的 `exhausted` 判断删掉 → `tests/queue.test.ts` 1 个用例失败（上限后查询不得重启链条）。

第 2 轮：
- `queue.forget` 去掉 abort + await → `tests/queue.test.ts`「aborts the pass in flight and resolves only after it settled」失败（1 fail）。
- `queue.forget` 去掉 `removed` 墓碑 → `tests/freshness.test.ts`「does not re-create the directory when a pass was owed by a change during it」失败（1 fail，目录被重建）。
- `refresh.observe` 改回 `queue.markStale` → `tests/freshness.test.ts`「does not turn a current graph stale for read-only tool results」失败（1 fail）。
- `codegraph_impact` 去掉 `lists` → `tests/schema-validation.test.ts` 2 个用例失败（resolved target、imports/related 截断）。

第 3 轮：
- `projectChanged` 对 `truncated || rootUnreadable` 改回 `false` → `tests/indexer.test.ts` 2 个用例 + `tests/freshness.test.ts`「does not report a current, complete graph when the project root cannot be read」失败（3 fail）。
- 去掉 phase 2 yield 后的 `checkAborted()` → `tests/indexer.test.ts`「stops phase 2 at its next batch boundary」失败（abort 后仍写入 reference 边）。
- phase 2 catch 去掉 `isAborted` 守卫（恢复无条件 `forgetStatCache`）→ 同一用例失败。
- `queue.dispose` 去掉 `await Promise.allSettled(running)` → `tests/indexer.test.ts`「dispose waits for the pass to settle before resolving」失败。

真实内核覆盖（`.devflow/codegraph-development-freshness/probe-real-kernel.mjs`，从解压的 `runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz` 启动真实 `cordis` + `ToolRuntime` + 插件 `lib/index.js`）：
- R1 真实 pass 后 `codegraph_find` 返回 `current`；R2 内核确实以 `tools/result` 发出事件且 `exec.agent.session.header.cwd` 为项目根；R3 非 codegraph 调用同样到达事件；R4 未提交编辑 + `shell` 结果后新符号可见且回到 `current`；R5 旧声明消失；**R6 15 次只读结果后全程未出现 `stale`、最终 `current`**；**R7 真实 impact 答案带 `lists` 的 shown/truncated**。7/7。

未验证项（明确缺口，不编造）：
- 真实**模型**驱动的完整会话（模型自行决定调用 `write`/`shell` 再查 codegraph）未自动驱动：`npm run verify` 的 suite smoke 不驱动模型，只断言路由/激活/工具挂载；event probe 只证明事件路径、索引结果与只读流状态，不证明模型行为。
- 失败/卸载路径在真实内核下的时序（listener 已被内核 containment 覆盖，插件侧只保证不 throw）：仅由 fake Context 用例覆盖。
- 删除项目在真实内核下的并发窗口：由 `tests/freshness.test.ts` 的两条端到端用例覆盖（真实索引器 + 真实路由），未在打包 runtime 里跑删除。
- `npm run dev` 交互式会话未运行（需要桌面窗口与人工操作）。
