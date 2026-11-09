# memory 插件机制化改造：把约定变成机制

- Status: done
- Plan date: 2026-11-09
- Risk: medium

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。

## Goal / Why

`plugin-memory` 的去重、淘汰、召回、置信度四件事今天靠模型每次自觉执行，规模一涨就退化成「热门域卡片越堆越多、低价值卡永不退场」。本计划把它们改成代码里**可测量、可拒绝、可观测**的机制。

**本轮目标已定为「可读性 / 可见性」**，不是「把卡数压下去」。依据：合并的算术上限是每域 −1 张（6 张同域卡正文 1798 字符 ÷ 单卡 400），全库理论最多 −14 张（192→178，−7.3%）。若把压卡数当成目标是达不到的，需另行谈取舍。

**已定决策**（2026-11-09，用户拍板）：

| 决策 | 结论 |
|---|---|
| Q0 卡片 frontmatter 增加可选 `domain` | **接受**。缺失即从 topic key 推导，存量卡零迁移 |
| Q1 `DOMAIN_CAP` 取值 | 先只度量不设闸，D 批次落地后按真实分布再定 |
| Q2 `ROT_DAYS` 与是否进注入 | 只进 `/status` 与 curator，**不进注入** |
| Q3 合并候选由谁产生 | 代码产候选（同域 + 同前缀/同 summary 主题词），模型只裁决 |
| Q4 400 字符上限 | 不动 |

## 前置改动（已完成，未提交）

上一轮不是按本计划做的，而是对**移动/迁移路径做正确性收口**：四轮复审共 8 条必须改，已全部修复并验证（`219/219`、`tsc exit 0`、A/B 有红）。

- 这些改动是本地基：`src/card-file.ts` 的三态探测是 D1/D2 直接复用的模块；移动的串行与补偿语义会被后续涉 store 的改动复用。**不要回滚。**
- 详细清单、验证证据、未提交文件列表与接手建议见 `.devflow/memory-mechanization.md`（不入库）。

## 现状基线（L1，本机真实 store 实测）

探测脚本：`probe-memory-baseline.mjs` / `probe-memory-baseline2.mjs`（只读）。测量窗口 2026-11-09 09:44–09:52，期间另一会话写入 1 张卡（192→193）。

| 指标 | 实测 | 含义 |
|---|---|---|
| 21 个 store / 192 张卡 | — | 样本规模 |
| 注入总字符 均值 / 最大 | 5704 / 8650 | — |
| guidelines 固定成本 | 3174（36.7%） | 不可预算约束的固定开销 |
| 索引 | 2536 字符 / 26 行 | — |
| 正文注入 | 2758 字符 / 8 张 | 受 `MAX_PROJECT_CHARS`=2800 约束 |
| 被丢正文（最大 store） | **18 / 26** | 真正每天发生的损失 |
| 卡数上限触顶（30） | 0 / 21 | 最大 28 张 |
| 索引行上限触顶（50） | 0 / 21 | 最多 29 行 |
| 相似度 ≥0.3 的对 | **1054 对中 0 对** | 相似度闸无法分辨同域/异域 |
| 正文 >400 字符 | 0 / 192 | 400 上限不是当前瓶颈 |
| 含版本号/路径/sha/行号 | 20 张 / 43 处 | 会腐烂的实证 |
| 卡龄 p90 / 最大 | 50 / 55 天 | 库只有 55 天，>90 天为 0 |
| 多词查询命中（现状 vs token-AND） | 7/180（4%）vs 18/180（10%） | 召回确实漏 |
| curator 产出 | 20 merge / 29 delete / 39 rewrite | 维护机制在跑 |

**实测发现的新缺陷**：`test-956819a6` 索引 29 行、磁盘 28 张卡，幽灵话题 `playwright-cli-motion-measurement` 被注入该项目的每个会话；归档无副本、台账无删除记录，说明文件在插件之外消失。根因是「索引每次写入后重建」只是约定，没有对账机制 → W2。

## Scope

- Must-have:
  - **测量的载体**：只读健康度量脚本（B1）、注入丢卡与索引溢出的计数（B2）、相似度与召回两份语料（B3、B4）。
  - **域成为一等结构**：`domainOf` 推导（D1）、卡片可选 `domain` 字段（D2）、`memory_save` 接受并回报同域上下文（D3）、索引按域分组（D4）。
  - **一致性守卫**：索引与卡集对账（W2），漂移则 reindex 并记事件。
  - **召回**：token-AND 替换纯子串（R1），超集不变。
- Out of scope:
  - 自动合并（代码只产候选与计数，合并仍走 curator 既有校验链）
  - 淘汰/衰减算法、`SIM_DUPLICATE`/`SIM_RELATED` 调参、`DOMAIN_CAP` 设闸、`ROT_DAYS` 进注入
  - embedding / 向量库 / 任何外部服务
  - 400 字符上限、`MAX_PROJECT_CHARS`、`MAX_INDEX_LINES`、`CURATE_MAX_CARDS` 的调整
  - UI 改动、跨项目迁移、新增 LLM 调用入口、为 `domain` 写迁移脚本

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 自动聚簇合并（代码直接合并同域卡） | 合并需要语义裁决；且算术上限仅每域 −1 张，收益与风险不匹配 |
| 按文本相似度分组 | 实测 1054 对中 ≥0.3 为 0，无法区分同域与异域 |
| 按 topic key 前缀分组 | 6 张同域卡被切成 5 组；`dsh` 前缀会把 16 张不相干的卡糊成一组 |
| 用 prompt 让模型自己聚簇/淘汰 | 这正是要消除的「约定」；本轮硬约束是不改 prompt |
| 调 `SIM_*` 阈值 | 没有评测语料前，两个方向的差异都无法证伪（先做 B3） |
| 上 embedding / 语义检索 | 成本高于收益，且离线无法验证增益；R1 的 token-AND 已把多词命中从 4% 提到 10% |
| 新建淘汰/衰减算法 | curator 已落地 20 merge / 29 delete / 39 rewrite，两个上限从未触顶 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| B1 | P0 | `scripts/memory-health.mjs`：每 store 一行指标（cards/pinned/indexLines/indexChars/bodyChars/bodiesInjected/droppedCards/atCap/rotMarkers/maxPairwiseSim/domains/overBudget），支持 `--snapshot` 冻结快照并首行打印 cards/fingerprint；只读，无 `--fix` | [x] |
| B2 | P1 | 注入指标补 `droppedCards` 与 `indexOverflowLines`；`InjectionMetricsRing.summary()` 均值含两者；`/status` 透出（客户端不改） | [x] |
| B3 | P0 | `tests/fixtures/similarity-corpus.json`（≥60 对，dup/related/distinct 各 ≥20）+ 报告用例，只断言结构合法与分布可打印，不断言分离度 | [x] |
| B4 | P0 | `tests/fixtures/recall-queries.json`（≥30 条，含 ≥5 负例）+ 现状命中记录用例，作为 R1 的改前基线 | [x] |
| D1 | P0 | `domainOf(card)`：有 `domain` 用它，否则取 topic key 第一段；返回 `declared`/`inferred` 两态；只读不落盘 | [x] |
| D2 | P0 | `TopicCard.domain?: string`；`parseCard` 容忍缺失、忽略未知键且不判 malformed；`renderCard` 仅在有值时输出；`cardFingerprint` 纳入；`validateCardInput` 校验形状。**`upsert` 判等需纳入 domain，否则「只改域」被判 unchanged 静默丢弃** | [x] |
| D3 | P1 | `memory_save` 增加可选 `domain`（缺省按 D1 推导，不落盘）；返回值增 `domain:{key,src,cards,summaries(≤5,每条≤40字)}` 与 `domainOver`（Q1 未定时恒 false）。**只加参数与返回值，不改工具描述文本** | [x] |
| D4 | P1 | `indexLine` 渲染域前缀；`reindex` 先按域、域内按 category→updated；`/status` store 行增 `domains` 与 `maxDomainCards` | [x] |
| D5 | P2 | curator：`serializeStore` 卡分节头标 `(domain X, refs N)`；`buildCuratePrompt` 增加域级指令；台账 `MemoryLedgerRow.domain?` 用于归因 | [x] |
| D6 | P2 | light-sweep 统计域卡数，超 `DOMAIN_CAP` 写 `distill-state.json` 的 `domainOver`（FIFO 上限 50，旧文件读成 `[]`） | [x] |
| R1 | P1 | `search()` 改 token-AND：ASCII 按词边界、CJK 按子串；空查询语义不变；`memory_forget` 的文本扫描共用同一函数 | [x] |
| S1 | P1 | `src/card-rot.ts`：`rotMarkers(body)` 统计版本号/路径/sha/行号四类；纯函数无 I/O | [x] |
| S2 | P2 | `/status` store 行增 `rotCards`、`staleCards`；`ROT_DAYS` 为常量并标注「未启用门控」；**注入文本字符数一个都不变** | [x] |
| S3 | P2 | curator 输入：卡分节头加 `(refs N)`，prompt 要求 `refs>0` 的卡要么补失效条件要么按陈旧删除——判定依据是宿主算好的数字 | [x] |
| W1 | P1 | 分级预警：24/30 卡（80%）与索引 40/50 行（80%）为黄线，触发计数进 `/status`；不裁剪、不改注入 | [x] |
| W2 | P1 | `indexDrift()`：挂载时与 `/status` 时对账 `index.md` 行与 `topics/*.md` 集合，漂移则 reindex 并记事件 | [x] |
| T1 | P0 | 兼容性用例：219 条既有用例全绿；`/status` 只增字段；`distill-state.json` 旧文件可读；存量卡字节不变 | [x] |
| T2 | P2 | 版本 bump（`plugins/AGENTS.md` §5 规则）+ changeset 片段 + `docs/memory-topic-cards/OPTIMIZATION.md` 追加一节 | [x] |

状态流转（就地更新，不得跳级）：`[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过；`[?]` 审查不通过；`[–]` 本轮不做；`[!]` 待用户决定。

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 1 测量与守卫 | B1, B3, B4, S1, W2 | 条目全 [x]；B1 在真实根目录跑出 21 行 store + 合计行；W2 对 `test-956819a6` 能报出漂移并修复 |
| 2 指标可见 | B2, W1 | 26 卡 store 的 `droppedCards===18`；构造 51 行索引得到 `indexOverflowLines===1` |
| 3 域结构 | D1, D2, D3 | round-trip 逐字段相等；只改 domain 返回 `updated`；同域 3 卡时返回值含 3 条摘要 |
| 4 域机制 | D4, D5, D6 | 同域索引行相邻；curator 输出带 domain；`domainOver` FIFO 至 50 条 |
| 5 召回 | R1 | B4 语料中所有 `expectTopics` 命中且超集不变 |
| 6 陈旧信号 | S2, S3 | `/status` 两份数字与 B1 一致；注入 `totalChars` 与改前相同 |
| 7 收尾 | T1, T2 | 219 条全绿 + 新用例；门禁 typecheck/test/build/check:graph 全过 |

阶段闸门：任一条目处于 `[~]`/`[?]`/`[!]` 时不得开始下一阶段。条目转 `[x]` 前必须回答四问（主张复核、最小性、新风险、反例）。

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| 卡片文件格式可含可选 `domain:` | added | `plugins/plugin-memory/src/card-file.ts` |
| `memory_save` 参数与返回值增域上下文 | modified | `plugins/plugin-memory/src/tools.ts` |
| 索引行格式与排序 | modified | `plugins/plugin-memory/src/memory-store.ts` |
| 召回匹配（子串 → token-AND） | modified | `plugins/plugin-memory/src/memory-store.ts` |
| `/status` 增加指标字段 | modified | `plugins/plugin-memory/src/routes.ts` |
| 索引与卡集对账 | added | `plugins/plugin-memory/src/memory-store.ts` |
| curator 输入与台账字段 | modified | `plugins/plugin-memory/src/curator.ts` |
| 注入指标（丢卡、索引溢出） | added | `plugins/plugin-memory/src/prompt.ts`、`src/injection-metrics.ts` |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (B1) | 真实根目录跑健康脚本 | `node scripts/memory-health.mjs --root <真实根>` | 21 行 store + 1 行合计；`cards` 合计等于当时快照卡数 | 命令退出码 0 + 输出核对 | pass · 21 行 store + 合计行，exit 0，snapshot `cards=193 / fingerprint=b849f9ce40b2` |
| 2 (B1) | 空目录不抛错 | 对空临时目录跑同一命令 | 0 行，退出码 0 | 同上 | pass · 空目录 0 行 + 合计行，exit 0 |
| 3 (B2) | 丢卡计数 | 26 卡 store 组装 | `droppedCards===18` | `npm test` 新用例 | pass · 26 卡夹具：`cardCount 8 / droppedCards 18` |
| 4 (B2) | 索引溢出计数 | 构造 51 行索引 | `indexOverflowLines===1` | 同上 | pass · 51 行索引：`indexOverflowLines 1` |
| 5 (B3) | 语料结构 | 读语料并校验 | 每类 ≥20、`a!==b`、label 闭合 | `npm test` | pass · 66 对，dup/related/distinct 各 22 |
| 6 (B4) | 语料被真正读取 | 条目数断言 | `===30` 或实际条数 | `npm test` | pass · 38 条（30 正例 + 8 负例） |
| 7 (D1) | 存量卡域推导 | 对 192 张卡跑 `domainOf` | 全部非空、`inferred` 占 100% | `npm test` | pass · 语料 20 个 key 全部非空且 `inferred`；真实 193 张卡的域见 B1 `domains` 列 |
| 8 (D2) | round-trip | `parse(render(card))` | 逐字段相等 | `npm test` | pass · 有无 domain 都逐字段相等 |
| 9 (D2) | 未知键不判 malformed | 带额外键的卡 | `malformed===false` | `npm test` | pass · `malformed === false`，非法 domain 读作缺失 |
| 10 (D2) | 只改域落盘 | 仅改 `domain` 后 upsert | 返回 `updated`，文件含新域 | `npm test` | pass · `updated`，文件出现 `domain: desktop-shell` |
| 11 (D3) | 新建带域 | 传 `domain` 保存 | 文件含 `domain:` 行，返回值 `domain.cards` 正确 | `npm test` | pass · 文件含 `domain:`，`domain.cards` 正确 |
| 12 (D3) | 更新继承域 | 更新不传 `domain` | 旧值保留，`src` 不变 | `npm test` | pass · 旧值保留，`src` 仍是 `declared` |
| 13 (D3) | 摘要上限 | 同域已有 7 卡 | 返回值最多 5 条摘要 | `npm test` | pass · 同域 7 卡 → 5 条摘要，每条 ≤40 字 |
| 14 (D4) | 同域相邻 | 多域 store reindex | 同域行相邻，跨域不交错 | `npm test` | pass · `agent-loop / dsh-second / dsh-first / windows-one`，域内按 category |
| 15 (D4) | 索引字符增量 | B1 改前/改后 | 增量 ≤ 卡数 × 8 | `--snapshot` 对比 | 实测：推导域增量 **0**（用例断言相等）；若每行都带前缀则 194 行 × 8.02 = 1555 字符 > 194 行 × 8 = 1552 的预算，故改为仅声明域渲染（§4.12） |
| 16 (D6) | 域超限 FIFO | 连续 51 次超限 | 保留最近 50 条 | `npm test` | pass · 连续 51 次 → 保留 50 条，newest first；统计取 sweep **之后**的卡集（9 卡含 1 对重复 + 1 张 malformed → 记 8） |
| 17 (D6) | 旧状态文件兼容 | 无 `domainOver` 的旧文件 | 读成 `[]` | `npm test` | pass · 旧状态文件读成 `[]`，其余键仍可读 |
| 18 (R1) | 多词命中 | `"memory 召回"` 等 B4 用例 | `expectTopics` 全部命中 | `npm test` | pass · 语料 `expectTopics` 全部命中，含 `memory 召回` / `memory召回` / `召回memory` 三种写法；纯 CJK 复合词（`索引漂移`）不分词，边界由专门用例记下 |
| 19 (R1) | 超集不变 | B4 全部查询 | 改前 ≥1 张的，改后仍 ≥1 张 | `npm test` | pass · 旧整句子串 16/38 → token-AND 30/38，无丢召 |
| 20 (R1) | 负例仍为空 | B4 负例 | 0 张 | `npm test` | pass · 8 条负例全为 0 |
| 21 (S1) | 四类标记计数 | 真实 192 张卡 | 与基线 20 张 / 43 处一致（差异写入台账） | 探测脚本 | 实测 `53 张 / 89 处`（body 口径）。与基线 20/43 的差异来自模式定义，逐类记在 §4.12 |
| 22 (S1) | 不误报 | 纯数字 / 短 hex / 中文句 | 计数为 0 | `npm test` | pass · 纯数字 / 短 hex / 中文句 → 0；另加一组「形似但不是」：host:port、IPv4、BLE UUID、两个文件名并列、纯字母 hex、`L2` |
| 23 (S2) | 注入不变 | 改前/改后组装 | `totalChars` 完全相同 | `--snapshot` 对比 | pass · `guidelinesChars 3174`，`totalChars === text.length` |
| 24 (W2) | 漂移可检出 | `test-956819a6` store | 报出 index 29 / cards 28 并 reindex | `npm test` + 真实 store | pass · 真实 store `1/21` 漂移：`index 29 行 / 28 卡 / ghost playwright-cli-motion-measurement`；重复行与缺失行在夹具上各自可检出并被重建（修复交给插件挂载或 `/status`，本轮不从工作区写用户的真实 store） |
| 25 (T1) | 既有用例全绿 | `npm test` | 219 条通过 | 命令 | pass · `npm test` 281/281（219 基线 + 62 新增） |

## Verification commands

```bash
cd plugins/plugin-memory
npx tsc --noEmit
npm test
npm run build

# 基线（只读，务必用 --snapshot，并在报告里带时点/卡数/指纹）
node scripts/memory-health.mjs --root "C:/Users/Administrator/.dsh/storages/dsh-app-plugin-memory" --snapshot

# 仓库根门禁
npm run typecheck
npm test
npm run check:graph
```

**测量纪律**：store 是活的（本计划测量窗口内 192→193）。任何「改前/改后」对比必须在同一 `--snapshot` 上取，并附带时点、卡数、指纹；否则并发写入会把差值伪装成改动效果。

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 自动聚簇合并 | 收益上限每域 −1 张，且需语义裁决 | 域字段落地且有评测语料后，若同域卡数仍增长 |
| `DOMAIN_CAP` 设闸 | 真实域分布未知（推导域 23 组，最大 16 张混合 5 个主题） | D2 落地后重跑 B1 拿到声明域分布 |
| `SIM_DUPLICATE`/`SIM_RELATED` 调参 | 现状 ≥0.3 命中 0，两个方向都无法证伪 | B3 语料 + 分离度报告出来之后 |
| `ROT_DAYS` 进注入 | 库龄 55 天，任何 ≥60 天阈值今天 0 命中 | 出现 >90 天卡或用户反馈记忆过期 |
| 400 字符上限调整 | 0/192 超限、0/192 断句 | 贴顶卡（≥395）占比 >10%，或出现断句卡，或用户反馈装不下 |
| `/pin` 与 `memory_recall` 区分 unreadable | 不写数据，改动会碰对外 API 形状 | 与「对外语义统一」批次一起做 |
| UI 展示域与预警 | 客户端本轮不改 | 服务端字段稳定后 |

## Rollback

- 每个阶段独立提交，回滚即 `git revert` 该阶段提交；`domain` 是可选字段、无迁移脚本，删字段即回退行为。
- `distill-state.json` 的 `domainOver` 为新增键，旧代码读到未知键需忽略（T1 覆盖）。
- 召回切换（R1）是行为变更，若出现漏召回归，单独 revert R1 提交即可恢复子串匹配。
- 已知坑：store 是活的，回滚验证也要用 `--snapshot` 对比；`test-956819a6` 的幽灵索引需在 W2 落地时一并修复，勿手工删 `index.md`（会丢排序）。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 测量与守卫 | 2026-11-09 | B1 在真实根跑出 21 行 + 合计，exit 0；空目录 0 行；W2 在真实 store 报出 `1/21` 漂移（29 行 / 28 卡 / ghost `playwright-cli-motion-measurement`）；夹具用例覆盖 ghost / 重复行 / 缺失行三种漂移 | 通过（不完整）：闸门里「并修复」这一半只在夹具上跑通。真实 store 的修复由插件自己的挂载与 `/status` 完成，**本轮没有从工作区写用户的真实 store**（一次尝试被自动化审查拒绝）。注：`domainOf` 因 B1 的 `domains` 列而提前落地（只读推导，无写路径），D 批次复用它 |
| 2 指标可见 | 2026-11-09 | 26 卡夹具 `droppedCards 18`；51 行索引 `indexOverflowLines 1`；环形缓冲均值含两项；`/status` 透出 | 通过 |
| 3 域结构 | 2026-11-09 | round-trip 逐字段相等；只改 domain 返回 `updated`；同域 3 卡返回 3 条摘要、7 卡封顶 5 条；存量卡字节不变 | 通过 |
| 4 域机制 | 2026-11-09 | 同域索引行相邻（域内按 category）；curator 分节头 `(domain X, refs N)`；`domainOver` FIFO 至 50；索引增量 0（推导域） | 通过，含一处对 D4 的调整（索引域前缀只在声明域与 key 第一段不同时渲染），理由与实测见 `docs/memory-topic-cards/OPTIMIZATION.md` §4.12 |
| 5 召回 | 2026-11-09 | B4 语料 30 条正例全部命中；旧 16/38 → 新 30/38；8 条负例仍为空；超集不变 | 通过 |
| 6 陈旧信号 | 2026-11-09 | 真实库 `rotCards 53 / rotMarkers 89 / staleCards 0`；`/status` 的 store 行与审计对同一 store 得到同值（用例）；`guidelinesChars 3174` 与改前相同，`totalChars === text.length` | 通过 |
| 7 收尾 | 2026-11-09 | `npx tsc --noEmit` exit 0；`npm test` **281/281**（219 基线 + 62 新增）；`npm run build` 两半均产出；`plugin-gates` 四关全过；根 `npm run typecheck` / `npm test`（731 tests，729 pass / 2 skip）/ `npm run check:graph` / `check:suites:gate` 全过 | 通过（三轮评审与修复见下一节） |
| — | 根 `npm test` 的一次异常 | 本轮共跑 7 次根测试，其中**一次**报 1 条失败；那一轮的失败名未被捕获，之后 6 次均为 729 pass / 0 fail。本轮改动没有任何根用例覆盖的路径，未能复现 → 记录为未解释，不当作已解决 |

## Review log

| 轮次 | 审查者 | 结论 | 处置 |
|------|--------|------|------|
| 1 | 独立审查 subagent ×2（宿主半区逻辑 / 用例与文档口径） | 部分不通过：宿主 5 条真缺陷、用例侧 11 条真缺陷（含 3 条「不可能失败的断言」）。**两者均未跑命令**（只读代码），所以它们的结论是读出来的，本轮所有修复的验证仍以我这里实跑的输出为准 | 全部处置，见下方「复审修复」 |
| 2 | 独立审查 subagent（只审第 1 轮的修复 diff） | 7 条里 3 条 SOUND、4 条 PARTIAL，另有 1 条新引入的真缺陷：回滚无法**清除**声明域（`upsert` 的缺省语义是继承）；`/status` 与审计仍会经 `metrics()` 调用严格的 `indexText()`；`host:port` 仍被当行号 | 全部处置：`upsert` 接受 `domain: null` 表示「无声明域」，回滚与 overwrite 都用它；新增私有的 `indexTextForCount()`（吞掉读取失败，仅供计数），严格版留给注入；行号不再认 `.ext:NN`（与 `host:port` 形状不可分，文件本身已计入路径类） |
| 3 | 外部审查（雪洛，只读 + 定向探针） | **REQUEST_CHANGES**：6 条 P2 + 1 条 P3，其中 3 条有 L1 定向复现。均不是机制缺失，而是「声称的行为与实测不符」：R1 没拆紧邻的 ASCII/CJK；W2 放过畸形索引行（而它会原样注入）；D6 记的是去重前、过滤 malformed 后的卡数；D5 的 `domain` 未进共享台账类型；B2 的 `/status` 透出无用例；S2 的「注入未变」只有空 store 证据；健康脚本对不存在的 root 绕过 `--json`/`--snapshot` | 全部处置，逐条见 R-15…R-21 |

### 复审修复（第 1 轮，全部已改并实跑）

| # | 缺陷 | 修法 |
|---|------|------|
| R-1 | `indexDrift` 用 Set 比集合，重复行不算漂移（同一张卡被注入两次） | 改成 multiset 比较，新增 `duplicatedKeys` 字段并计入健康行的 `indexGhosts` |
| R-2 | 「挂载时对账很便宜」这句是假的：`reconcileIndexes` 走 `listProjects` → `metrics()` → `list()`，等于全量读卡 | `reconcileIndexes` 改从 `projects/` 目录枚举 slug（不读 `project.json`、不读卡）；`storeHealth` 也只读一次卡并喂给 `metrics(cards)` |
| R-3 | `indexDrift` 号称不抛错，但 `indexText()` 与 `unreadableKeys()` 都裸露在外，EACCES 会让 `/status` 回 500、让插件挂载失败 | 两处分别 try/catch，失败回答 `undefined`（=「不知道就不动」） |
| R-4 | `memory_forget` 的文本扫描被 token-AND 放宽，一个拼错的 key（`dsh-config`）会删掉所有同时含两个词的卡；而工具描述写的是子串语义 | `textMatchesQuery` 增 `mode`：key 形状的输入走 `phrase`（历史规则），非 key 形状走 `full`。用例会用两张卡区分两者 |
| R-5 | 声明域在 move / 补偿 / curator rename 上被丢弃（目标端没有旧值 → 静默按 key 推导） | 三处都把 `domain` 带上；curator 只在「被引用的卡只有一个声明域」时跟随，跨域合并不猜 |
| R-6 | 快照指纹哈希的是**计数**（cards/bodyChars/indexChars），同长度改写读不出变化 | 新增 `cardsFingerprint(cards)`，健康行与合计行都基于内容；用例用「同长度改写」验证 |
| R-7 | `indexLine` 注释写「存量索引字节完全不变」，而 `reindex` 已改成按域排序 | 改为「行内容不变、行序变了」 |
| R-8 | `card-rot`：纯字母 hex 被当 sha（`deadbeef`），`localhost:3000` 被当行号，`L2` 被当行号 | sha 要求同时含数字与字母；行号只认 `line N` / 中文行号（`.ext:NN` 与 `L2` 这两种形式后面因误报被删，见 R-14） |
| R-9 | `/status` 的 `cardsAtCap` 用 `>`，健康脚本的 `atCap` 用 `>=`，正好在第 30 张卡上分歧 | 两处统一为 `>=`（`overBudget` 仍是 `>`，含义不同且各带注释） |
| R-10 | 用例侧：1 条自我比较的断言、2 条不可能失败的断言、1 段死夹具、1 条过宽的代价断言 | 全部改成能否证伪的断言（作用域标签用 `projectSlug()`、空目录看行数、CLI 断言 slug 行、`maxPairwiseSim > 0 && < 1`、推导域增量断言**等于 0**） |
| R-11 | 文档口径：用例数拆分错（6/17/24）、测试计划 #22 声称覆盖了 IPv4/UUID/文件名并列但没用例、阶段 6 的「/status 与 B1 一致」无用例、阶段 1 的「并修复」未实际执行 | 拆分改为实测；新增「形似但不是标记」用例；新增 `/status` vs 审计同值用例；阶段 1 结论改写为「修复路径由夹具验证，真实 store 的修复在插件下次挂载或刷新状态页时发生，本轮未从工作区写用户的真实 store」 |
| R-12 | 第 2 轮：回滚恢复 `domain: undefined` 的快照时会**继承**失败移动刚写的域，失败的操作因此改变了目标端的注入 | `upsert` 的 `domain` 接受 `null` =「无声明域」；move 的目标写入与补偿分别用 `card.domain ?? null` / `replaced.domain ?? null` |
| R-13 | 第 2 轮：`/status` 与审计经 `metrics()` 调严格的 `indexText()`，一个 EACCES/EISDIR 的 `index.md` 仍能让路由 500 | 新增私有 `indexTextForCount()`（失败→`undefined`，计数按 0 行），严格版留给注入；新增 EISDIR 用例 |
| R-14 | 第 2 轮：`host:port`（`api.github.com:443`）仍被当行号；`LINE 42` 大写不认 | 行号不再认 `.ext:NN`（与 host:port 形状不可分，文件本身已计入路径类），只留 `line N` / 中文行号并加 `i` |
