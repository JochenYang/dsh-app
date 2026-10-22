#[x]plugin-codegraph

-[x]Status:[x]active
- Plan date: 2026-10-22
- Risk: medium

## Goal

一个套件插件，为每个项目自动维护可增量更新的代码知识图谱，并提供三个模型工具，让「这个仓库由什么组成」「我改这里会影响谁」「这个符号的上下文是什么」变成可查询的事实，而不是靠模型反复读文件。

成功标准：在 dsh-app 自身（808 个 TS/JS 文件）上冷启动索引 ≤ 60s、增量 ≤ 3s，三个工具都能返回正确结果，且索引状态对用户和模型都可见。

## Scope

- Must-have:
  - tree-sitter wasm 解析，语言按需加载
  - `node:sqlite` 存储（Node 内置，零第三方依赖）
  - 每项目一个 DB，按 cwd 的 sha256 隔离
  - 后台自动建图 + 增量更新 + 状态可见
  - 三个工具：`codegraph_find` / `codegraph_impact` / `codegraph_context`
  - 设置页：语言包下载/卸载、每项目索引状态
- Out of scope:
  - 语义搜索 / embedding / LLM 索引
  - 变量级数据流分析
  - 跨仓库、跨服务、基础设施关联
  - 图谱可视化 UI
  - CBM 集成

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | 插件骨架：package.json / tsconfig / build.mjs / cordis.patch.yml / 五份 roster 登记 | [x] |
| W2 | P0 | sqlite schema + 迁移入口：files / symbols / edges / meta 四张表 | [x] |
| W3 | P0 | 语言加载器：随包 8 种 + 按需下载，未安装返回 LANGUAGE_NOT_INSTALLED | [x] |
| W4 | P0 | 解析器：tree-sitter 提取 file/symbol 节点与 contains/imports 边（先 ts/js/python 三语言验证通路） | [x] |
| W5 | P0 | 调用边提取：call_expression 等节点 → references 边（不做数据流） | [x] |
| W6 | P0 | 增量索引：mtime+size+hash 比对，只重解析变化文件，删除级联 | [ ] |
| W7 | P0 | 后台索引队列 + 状态机（unindexed/indexing/current/stale），并发上限 1 | [ ] |
| W8 | P0 | 三个工具：find / impact / context，含 stale 与 INDEXING 语义 | [ ] |
| W9 | P0 | host 路由：走 `ctx.connection.fetch.register`，路径 `/api/plugins/dsh-app/codegraph/*` | [ ] |
| W10 | P0 | 设置页：语言下载、项目状态列表，全部用 primitives 组件 | [ ] |
| W10b | P0 | 设置页按项目切换：`SegmentedTabs` 列出每个已索引项目，切换显示该项目自己的状态与操作 | [ ] |
| W10c | P0 | 会话页顶部「图谱」视图：注册 `conversation.view`，渲染当前项目的图谱（文件→符号分层，`<svg>` 手绘，不引图形库） | [ ] |
| W11 | P1 | documents 边：把 docs/ 与 AGENTS.md 的段落关联到符号 | [ ] |
| W12 | P1 | 读时 HEAD 校验：落后时返回 stale:true 并触发后台重建 | [ ] |
| W13 | P2 | 其余 28 种语言接入 | [ ] |
| W14 | P2 | 设置页序号登记进 docs/agents/settings-rail-order.md | [ ] |
| W15 | P2 | 文档：docs/agents/codegraph.md + AGENTS.md 阅读表一行 | [ ] |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选。

状态流转（就地更新，不得跳级）：`[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过；`[?]` 审查不通过；`[–]` 本轮不做（写明理由）；`[!]` 待用户决定。

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 骨架与存储 | W1, W2 | 插件能被内核加载，schema 建表成功 | [x] |
| 2 解析通路 | W3, W4, W5 | ts/js/python 三语言能提取符号与调用边 | [x] |
| 3 增量与队列 | W6, W7, W12 | 二次索引走增量，状态机四态可观测 | [ ] |
| 4 工具与路由 | W8, W9 | 三个工具在真实会话中可用，路由过 Connection 围栏 | [ ] |
| 5 设置页 | W10, W10b, W14 | 语言下载可用，项目可切换，序号表已更新 | [ ] |
| 6 文档与扩展 | W11, W13, W15 | documents 边可用，文档落盘 | [ ] |
| 7 会话页视图 | W10c | 图谱视图在会话标签栏可切换，真实项目能渲染 | [ ] |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。Gate 通过 = 该阶段验证项全 PASS 且 review 无阻塞发现。

## Affected behaviors

- `plugins/dsh-app.patch.yml`：新增一行 `codegraph`，影响 suite roster 五份副本（`scripts/kernel-line.mjs`、`src/main/brand-suite.ts`、`scripts/smoke-suite.mjs`、`.github/workflows/release.yml`）
- 设置页：新增一个 `settings.section`，占用一个 order 值，必须同步 `docs/agents/settings-rail-order.md`
- 内核启动：新增一个后台队列，若实现不当会拖慢启动
- `$DSH_HOME/storages/`：新增目录，需确认 safe mode 下不创建

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W2) | schema 建表幂等 | 同一 DB 连续两次 initialize | 不抛错，表结构不变 | `npm test` | pending |
| 2 (W3) | 未安装语言 | 解析 .rb 文件且未装 ruby | 返回 LANGUAGE_NOT_INSTALLED | `npm test` | pending |
| 3 (W4) | 符号提取 | 一个已知 TS 文件 | 符号名与行号正确 | `npm test` | pending |
| 4 (W5) | 调用边 | A 调用 B | references(A→B) 存在 | `npm test` | pending |
| 5 (W6) | 增量跳过 | 改一个文件后重建 | 只重解析该文件 | `npm test` | pending |
| 6 (W7) | 状态机 | 索引进中查询 | 返回 INDEXING | `npm test` | pending |
| 7 (W8) | impact 正确性 | diffRulerMarks | 返回 git-tab.tsx | `probe-codegraph.cjs` | pending |
| 8 (W9) | 路由围栏 | 无 cookie 请求 | 401 | `probe-codegraph.cjs` | pending |
| 9 (W10) | 语言下载 | 设置页勾选 ruby | .wasm 落盘，状态变已安装 | 手工 + 路由断言 | pending |
| 10 (W12) | stale 语义 | 提交后首次查询 | stale:true 且后台开始重建 | `probe-codegraph.cjs` | pending |
| 11 (W11) | documents 边 | docs/agents/security-invariants.md | 关联到相关符号 | `npm test` | pending |

## Verification commands

```sh
cd plugins/plugin-codegraph && npm run typecheck && npm test
node scripts/probe-codegraph.cjs
node scripts/plugin-gates.mjs plugins/plugin-codegraph
npm run check:suites:gate
npm run check:slots
npm test
```

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 变量级数据流 | 成本高一个数量级，vibe coding 场景用不到 | 出现「这个值的来源」这类反复查询时 |
| 语义搜索 | 需要 embedding 与索引成本，精确引用先解决 80% | 需要「按意图找代码」时 |
| 跨仓库关联 | 当前每个项目独立建图已够 | 出现 monorepo 或多服务追踪需求时 |
| CBM 集成 | 1.8G 引擎换 10% 场景，watcher 还需重写 | 需要 162 语言或基础设施关联时 |
| 图谱可视化 | 工具已能回答，可视化是锦上添花 | 用户明确要求看架构图时 |
| 「schema 建表成功」的加载期证据 | 阶段 1 的 `apply()` 是空实现，`store.ts` 不在产物里，所以没有 DB 在插件加载时被创建。单测证明的是模块行为，不是插件加载行为 | 阶段 2 把 `openGraph` 接进 `apply()` 时，用一条加载期断言闭合（`npm run verify` 或探针） |
| `web-tree-sitter` 的打包归属 | 现在只在 `devDependencies`，会被打进 bundle，而它运行时需要 `.wasm`。放 bundle 还是走 peer 必须定死 | W3 开工前决定，同时决定 `grammars/*.wasm` 随包还是按需下载 |
| 插件源码的 `rmSync` 已改用 `unlinkSync` | 只删三个具体文件，不涉目录 | 若将来需要删整个项目目录，改走 `plugins/<plugin>/src/remove-tree.ts` 的走查器 |

## Rollback

- 插件本身：从 `plugins/dsh-app.patch.yml` 移除 `codegraph` 行，五份 roster 同步移除，重启即恢复
- 数据：删除 `$DSH_HOME/storages/dsh-app-plugin-codegraph/` 整个目录，无残留
- 不触碰内核、不改 profile、不动 `bundled-kernel`

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 | 2026-10-22 | `npm run typecheck` 干净；`npm test` 13/13；`plugin-gates` 四道全过；`check:suites:gate` 18 份一致；根 `npm test` 714 通过 / 2 跳过 / 0 失败 | 通过。独立审查发现 3 个 P1（入边误删、资源文件缺失、缺 changeset）与 6 个 P2，全部修复后复验。**「schema 建表成功」在插件加载路径上尚未验证**——`apply()` 仍为空，`store.ts` 不在产物里，见 Deferred。四问：主张成立（13 条测试含 3 条针对审查发现的缺口）；最小（无多余抽象）；新风险已消除（入边误删是本次引入且已修）；反例已覆盖（存活符号的重索引、文件级 imports） |
