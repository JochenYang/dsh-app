# plugin-memory 加固方案与回归台账

> 状态：方案定稿，未实施（2026-09-19）
> 范围：`plugins/plugin-memory`（store / distiller / curator / light-sweep / prompt / routes / client）
> 上游：`DESIGN.md` 定义主题卡模型；本文只定义**加固与可恢复性**改造，不改变模型
> 用途：实施前是方案，实施后是回归台账——每条改动有 ID、验收命令、证据行

> **Superseded in part — 2026-09-21, commits `cfe0484` / `472f554`, cleanup
> recorded as `J` in §4.8.** The global scope is retired and the extractor that
> distilled a quiet session's conversation is gone: memory is now what the model
> itself saves through `memory_save`, and the background pass only consolidates
> cards that already exist. §1's judgment 9 and §5's not-do rows still stand as
> decisions — no capture on every turn (and none at all) — but the gates they
> cite (`src/distiller.ts:60,146,156`) no longer exist. Rows A–I below are the
> ledger of what was built and why; §4.8 records the retirement cleanup, which
> measurements were re-run, and what was removed.

## 0. 维护约定

- 每条改动一个 ID（A–G），状态标记：📄 待实施 / 🚧 实施中 / ✅ 已完成 / ⛔ 已否决 / 👀 观望。
- 实施任何一条时**必须**在同一提交里更新本文的「§4 回归台账」，补上：改动文件、验证命令、实测证据、插件版本号。
- 完成项的证据必须是**执行结果**（测试输出、实际文件内容、日志行），不是「代码看起来对」。
- 只记录可独立成立的工程结论：每条要求的理由都要能独立读懂，不依赖任何外部材料——读者不必访问别的仓库就能判断这条要求是否成立。
- 语言：与同目录 `DESIGN.md` 一致使用中文。代码注释与 JSDoc 仍按仓库约定用英文。

## 1. 逐条判定表

本模块按五个面（存储模型、捕获、整合、注入、检索）逐条判定，含否决与观望——否决项同样入库，否则下一轮会重复讨论。

| # | 改进点 | 判定 | 落点 |
|---|---|---|---|
| 1 | 输入限额：未读完的条目留到下次，而不是丢掉尾部后照常操作 | **采纳**（我方实现有反向缺陷） | §3 A |
| 2 | 拿锁后复检门控，防抢占者已整合 | **部分采纳**：多进程场景已被单实例锁排除，重定义为「写入侧过期检测」 | §3 C |
| 3 | 失败不关闸：只有成功/无事可做才提交水位 | **已基本满足**，缺显式化与测试 | §3 F |
| 4 | 删之前先归档原始证据，带保留期 | **采纳**（我方零归档） | §3 B |
| 5 | 注入只放索引，正文按需读 | **观望**，触发条件见 §3 G1 | §3 G1 |
| 6 | 禁止在记忆正文里写元叙述（"我查了记忆库…"） | **采纳**（低成本） | §3 E |
| 7 | 完整事务化流水线（状态库 + 租约 + 操作状态机 + 计划哈希 + 孤儿收养） | **否决**（规模不匹配，理由见 §5），借「确定性 id / 内容哈希」两点 | §3 A、C |
| 8 | 不可变证据层（原始观察与策划笔记分离） | **观望**；轻量替代为「变更台账」 | §3 D、G2 |
| 9 | 每轮对话结束调一次模型做捕获 | **否决**（我方 60s 静默 + 双门控在"不打断用户"上更优） | §5 |

**结论**：采纳 1/4/6，重定义后采纳 2，补强 3，观望 5/8，否决 7/9。其中 1 与 2 修的是**可能损坏用户数据**的问题，优先级最高。

## 2. 现状核对

每条都给出代码位置，便于实施时对照与实施后复核。

| 能力 | 我方实现 | 位置 |
|---|---|---|
| 存储 | 主题卡 `topics/<key>.md` + frontmatter，`index.md` 由宿主重建 | `memory-store.ts:265-278`、`memory-store.ts:560-578` |
| 卡片排序 | category 序 → `updated` 新到旧 → key | `memory-store.ts:399-402` |
| 写入（模型） | `memory_save` upsert，按 cwd 定作用域 | `tools.ts:97-233` |
| 写入（后台） | distiller：静默 60s + `MIN_NEW_MESSAGES=2` + `MIN_NEW_CHARS=4000` | `distiller.ts:60,146,156` |
| 写入时防重 | bigram Jaccard，`τ_dup=0.8` 拒绝、`τ_rel=0.3` 报 related | `memory-store.ts:71-72`、`tools.ts:199-208` |
| 轻量维护 | 每次写入后无模型跑：精确重复合并 + 嫌疑记录 + 索引重建 | `light-sweep.ts:36-93` |
| 重量维护 | curator：≥8 卡 + 指纹变化 + 10 分钟冷却，按键引用的 merge/delete/rewrite | `curator.ts:55,61,346-359` |
| 注入 | 索引全文（≤50 行）+ 按 category 配额选正文，global 1200 / project 2800 字符 | `prompt.ts:33,36,192`、`prompt.ts:114-185` |
| 检索 | `memory_recall`：topic 精确 / query 子串，无索引无 embedding | `tools.ts:259-336` |
| 归档 | **无**。删除即 `removeTree` | `memory-store.ts:452-463`、`memory-store.ts:508-527` |
| 变更台账 | **无**。只有 token 审计与 saved 计数 | `memory-store.ts:998-1006`、`memory-store.ts:1013-1025` |
| 进度语义 | distiller 先 apply 再 `advanceDistill`，失败不推进 | `distiller.ts:493-497` |
| 单实例 | `app.requestSingleInstanceLock()`，一个应用实例 = 一个内核子进程 | `src/main/index.ts:1503` |

## 3. 实施方案

### A. curator 截断安全（最高优先，正确性）

**问题**。`serializeStore` 超 `MAX_INPUT_CHARS = 40000` 时丢掉卡片列表尾部（`curator.ts:124-141`），但**索引仍然全文下发**——索引每卡一行，含 topic key 与 summary。于是模型看得见全部 key，却只看得见部分正文，可以对一张**从未读过正文**的卡提出 `delete` / `merge` / `rewrite`，而 `applyEdits` 的 `claim()` 只校验 key 存在、未 pinned、未重复引用（`curator.ts:462-473`），不校验"这张卡的正文被下发过"。后果是**不可逆的内容丢失**：`delete` 直接删文件，`merge` 用模型新写的正文覆盖，`rewrite` 同理。

`truncated` 标记目前只用于阻止 `recordCurated`（`curator.ts:425`），拦不住破坏性操作。

**对照**。distiller 的同类截断（`distiller.ts:78-97`）**不构成此问题**：它只提案新增/更新，宿主写入门控 `store.get` / `hasContent` / `findSimilar` 针对**全量 store** 执行（`distiller.ts:552-567`），截断只让模型少看上下文，不会造成破坏。两处截断风险等级不同，不要一起改。

**改动**。

1. `serializeStore` 返回实际下发的 key 集合与其内容哈希：`{ text, truncated, seen: Map<string, string> }`。
2. `claim()` 增加一条：`seen` 中不存在该 key → 拒绝整条编辑（跳过，不致命于其他编辑）。
3. 被拒绝的编辑计入日志与台账（§3 D），便于观察真实发生率。

**附带的饥饿问题与解法**。只做 1–3 会引入新的死锁：`list()` 的排序是确定性的（`memory-store.ts:399-402`），被截断的尾部**每次都相同**，那批卡永远进不了任何一次 pass，而它们恰好是最旧、最该被清理的。因此同一条改动还要：

4. 在 `distill-state.json` 里为每个作用域存一个 `cursor`；截断发生时按 `included` 前进并在下次从该偏移起序列化（环形），使每个卡最终都被审阅。未截断时 `cursor` 归零。

**验收**。
- 单测：构造 >40000 字符的 store，注入一个对未见 key 的 `delete`，断言该卡存活、其余编辑照常生效。
- 单测：连续两次截断 pass 后，`cursor` 前进且第二次下发的卡集合与第一次不同。
- 单测：未截断时 `cursor` 为 0。
- 手工：日志出现 `skipped N edit(s) citing cards beyond the input cap`。

**风险**。`cursor` 是新增状态字段，旧 `distill-state.json` 缺该字段必须按 0 处理（`readDistillState` 已是宽容解析，见 `memory-store.ts:1039-1060`）。

### B. 记忆归档（可恢复性）

**问题**。删除是**不可逆**的，而删除有三个自动来源：curator 的 `delete`/`merge`（`curator.ts:494-506, 576-581`）、light-sweep 的精确重复合并（`light-sweep.ts:56-65`）、以及 `memory_forget` 工具（`tools.ts:338-394`）。一次模型误判（把两张不同主题的卡判为近重复）就永久丢失内容，用户没有任何挽回手段。

**改动**。

1. `MemoryStore` 增加 `archiveDir = <store>/archive/`。
2. `remove()` 与 `forget()` 在 `removeTree` 之前，把卡片**原样**（`renderCard` 输出）写入 `archive/<YYYY-MM-DD>/<topic>.md`。写入走现有 `atomicWrite`（`memory-store.ts:321-325`）。
3. `remove()` 增加一个 `reason` 参数（`'forget' | 'curate-delete' | 'curate-merge' | 'light-sweep-dup'`），只用于台账，不写进归档文件——归档文件保持可直接复制回 `topics/` 的形态。
4. 保留期：每次写入归档时按年龄清理（默认 30 天）并对总量设上限（默认 200 个文件，按 mtime FIFO）。**不引入定时器**——清理挂在写入路径上，符合"无后台常驻任务"的既有纪律。
5. `clear()` 是用户显式的完全重置，同时清空 `archive/`（在 JSDoc 里写明）。
6. `archive/` 不在 `topics/` 下，`list()` 只读 `topics/*.md`（`memory-store.ts:384-404`），因此归档**天然不参与注入、检索、相似度门控**——不需要额外的排除逻辑。
7. 客户端：状态页显示归档条数；`POST /api/plugins/dsh-app/plugin-memory/restore` 把一张归档卡放回 `topics/`（同名已存在则拒绝并返回 `HostText` 错误码）。新增文案走插件自己的字典与 `HostText { code, params }`，宿主不下发散文。

**验收**。
- 单测：`forget` 一张卡后，`archive/<date>/<key>.md` 内容与删除前 `renderCard` 逐字相同。
- 单测：light-sweep 合并精确重复后，被删的卡可在归档中找到。
- 单测：超过保留期的归档文件在下次写入时被清理，未过期的保留。
- 单测：restore 把卡放回后 `list()` 能读到、`index.md` 重建、同名冲突被拒绝。
- 手工：删一张卡 → 设置页归档数 +1 → 恢复 → 卡片回到列表。

### C. 写入侧过期检测（正确性）

**问题（更正后的判断）**。多进程并发**不是**当前风险：应用持单实例锁（`src/main/index.ts:1503`），且 `sweep()` 在第一个 `await` 之前就同步设好 `lastSweepAt`（`curator.ts:329`），所以 `runAfterDistill` 的冷却判定在进程内不会交错。

真实风险是**同进程内的丢更新**：`curate()` 先把 store 序列化（`curator.ts:363`），再 `await` 一次模型调用——`DIRECT_TIMEOUT_MS` 上限 180 秒（`llm-direct.ts:80`），实际 8k token 输出可达百秒级。这期间：

- `memory_save` 工具可以 upsert 同一张卡（`tools.ts:225-231`）；
- distiller 可以在同一作用域写入（`distiller.ts:552-568`）；
- light-sweep 可以删卡（`light-sweep.ts:60`）。

`applyEdits` 之后确实读的是**当前** store（`store.get` / `store.list()`），所以不会写坏文件；但**模型是在旧视图上做的决定**。于是一次 `delete` 可能删掉刚刚被修正的卡，一次 `rewrite` 可能用旧内容覆盖刚写入的新内容。这是可达的静默数据丢失，且没有任何机制能发现。

**改动**。

1. 复用 A 的 `seen: Map<key, hash>`（哈希取 `contentHash(renderCard(card))`，与 `fingerprint()` 同源，`memory-store.ts:581-584`）。
2. `claim()` 增加一条：`seen.get(key) !== 当前哈希` → 拒绝该条编辑。语义是"这条编辑的依据已经过期"，与 A 的"从未看过"共用同一处拒绝逻辑，只是原因不同。
3. 拒绝计数写入日志与台账（区分 `unseen` 与 `stale` 两种原因）。
4. 不做全局"指纹变了就整轮放弃"：那会浪费一整次模型调用，且 per-key 拒绝已足够精确。

**验收**。
- 单测：serialize 之后、apply 之前修改被引用的卡 → 该条编辑被拒、卡内容保持修改后的版本、其余编辑生效、台账记录一条 `stale`。
- 单测：未被修改的卡不受影响（不误伤）。
- 手工：日志出现 `skipped N stale edit(s)`（需要构造，不必常态出现）。

### D. 变更台账（可追溯性）

**问题**。现在无法回答"这张卡为什么没了"。`recordLlmAudit` 只记 token 与状态（`memory-store.ts:1013-1025`），`recordDistill` 只记 saved 计数（`memory-store.ts:998-1006`）。删除/合并/重写的**具体对象**没有任何持久记录。与 §3 B 合起来才构成完整答案：**能解释，且能恢复**。

**改动**。

1. `distill-state.json` 增加有界数组 `ledger`（沿用 `activity` / `suspects` 的既有模式与 `atomicWrite`，上限 200 条 FIFO）。
2. 条目形状：`{ at, scope, pass: 'curate' | 'light-sweep' | 'forget', op: 'merge' | 'delete' | 'rewrite', keys: string[], target?: string, reason?: 'unseen' | 'stale', session?: string }`。
3. 写入点：`curator.applyEdits` 的每次成功应用与每次拒绝、`lightSweep` 的每次合并、`forget` 的每次删除。
4. 客户端：设置页「最近整理」列表（扩展现有 activity 区块），显示时间、作用域、操作、涉及 key。与 B 的归档入口放在一起，使"看到被删的卡"和"把它找回来"在同一个界面完成。

**验收**。
- 单测：一次含 merge+delete 的 curate pass 后，`ledger` 有对应条目且 keys 正确。
- 单测：`ledger` 超过上限时按 FIFO 截断。
- 单测：旧 `distill-state.json` 无 `ledger` 字段时解析为 `[]`，不抛错。

### E. prompt 纪律（低成本）

**问题**。三处 prompt 都没有禁止模型在**记忆正文**里写元叙述。一旦模型写出"根据记忆库中 X 卡…"或"我已把这条存入记忆"，这段文字会随卡片再次注入未来每个会话，污染上下文，且被后续 pass 当作事实继承。

**改动**。在下列三处各加一条规则：

- `prompt.ts:45-74`（`GUIDELINES_TEXT`）：正文只陈述事实本身，不提及记忆系统、索引、卡片、工具、本会话或保存动作。
- `curator.ts:158-204`（`buildCuratePrompt` 的 system）：merge/rewrite 的产物同样不得包含上述元叙述。
- `distiller.ts:195-252`（`buildDistillPrompt` 的 system）：同一条。

同时补一条与现有 `stripCommitIds` 呼应的正向要求：正文不引用会话、日期、提交号等会腐烂的标识。

**验收**。
- 单测：三个 prompt 构造函数产出的文本包含该规则（防止后续编辑误删）。
- 手工：跑一轮真实 distill，检查落盘卡片正文无元叙述。

### F. 进度语义的显式化与测试（补强）

**现状**。distiller 的语义已经正确：`applyEntries` 完成后才 `advanceDistill`（`distiller.ts:493-494`）；模型调用失败直接返回、不推进（`distiller.ts:489-492`）；`applyEntries` 抛异常则冒泡到 `distill()` 的 catch，进度保持、下轮重试（`distiller.ts:405-407`）。curator 的 `recordCurated` 只在未截断且达到预算目标时调用（`curator.ts:425-433`）。

**问题**。这条不变量只存在于代码顺序里，没有测试钉住，也没有写进 JSDoc——后续重构很容易把 `advanceDistill` 提前到模型调用之前，那会造成"内容没落盘但进度已推进"的静默丢失。

**改动**。

1. 在 `distiller.ts` 与 `curator.ts` 的模块 JSDoc 里写明这条不变量及其理由。
2. 补测试：模型调用失败 → 进度不推进；`applyEntries` 中途抛错 → 进度不推进且下次重跑同一段增量；curator 截断 → 不记录已整理。
3. 复核 `applyEntries` 部分成功后的重入安全性：已写入的卡在下轮会被 `hasContent` / `findSimilar` 拦住（`distiller.ts:566-567`），该性质写进测试。

**验收**。上述测试全绿，且故意把 `advanceDistill` 提前时测试必须失败（验证测试真的钉住了行为）。

### G. 观望项与触发条件

#### G1. 注入只放索引、正文按需 recall

**现状**。注入 = 索引全文（≤50 行）+ 按 category 配额选正文，global 1200 / project 2800 字符（`prompt.ts:33,36,192`）。

**为何现在不做**。索引条目之所以能保持短，与卡正文上限有关：正文上限 400 字符（`memory-store.ts:54`），全文注入的边际成本本来就低。**触发条件应与实测注入量挂钩，而不是卡数**。

**触发条件**（满足任一即立项）：
- 单作用域注入文本常态超过预算的 80%（global 960 / project 2240 字符）；
- 单作用域卡数持续 >40 且 `memory_recall` 调用率低；
- 用户反馈注入噪音。

**度量方式**：在 `renderMemoryText` 加一个不含内容的长度埋点（只记字符数，不记文本），随现有审计落盘。

#### G2. 不可变证据层

**现状**。distiller 直接把提案写成卡片，**没有证据层**。提案出错只能靠 curator 或人工删。

**为何观望**。完整证据层（原始捕获与策划笔记分离、各自的生命周期与保留策略）是架构级变更，牵动 distiller、curator、注入、迁移与客户端，且当前卡量（实测 5 与 7 张）远未到需要它的规模。

**先做的是 D**：变更台账 + 归档已经能回答"这张卡为什么没了、怎么找回来"，覆盖了证据层最迫切的收益，成本低一个数量级。

**重新评估的触发条件**：单作用域卡数持续 >40；或出现一次"无法判断某张卡为何被删"的真实事故。

## 4. 回归台账

实施时逐行填写。**证据列必须是可复核的**（命令 + 关键输出，或文件路径 + 行号）。

| ID | 状态 | 改动文件 | 验证命令 | 证据 | 插件版本 | 日期 |
|---|---|---|---|---|---|---|
| A 截断安全 | ✅ | `src/curator.ts`、`src/memory-store.ts`、`tests/background.test.ts` | `npm run typecheck` · `npm test` · `npm run build` · `npm run check:graph` · `node --test test/plugin-version-bump.test.mjs` | 见 §4.1 | 0.8.5 | 2026-09-19 |
| B 归档 | ✅ | `src/memory-store.ts`、`src/types.ts`、`src/routes.ts`、`src/client/memory-section.tsx`、`src/client/locales.ts`、`tests/core.test.ts`、`tests/routes.test.ts` | 同 A，另加 `node --test test/recursive-delete-guard.test.mjs` | 见 §4.2 | 0.8.5 | 2026-09-19 |
| C 过期检测 | ✅ | 同 A（`seen` 哈希比对同时覆盖 unseen 与 stale 两因） | 同 A | 见 §4.1 | 0.8.5 | 2026-09-19 |
| D 变更台账 | ✅ | `src/memory-store.ts`、`src/curator.ts`、`src/light-sweep.ts`、`src/routes.ts`、`src/types.ts`、`src/client/memory-section.tsx`、`src/client/locales.ts`、`tests/*.test.ts` | 同 A | 见 §4.3 | 0.8.5 | 2026-09-19 |
| E prompt 纪律 | ✅ | `src/card-discipline.ts`（新）、`src/prompt.ts`、`src/distiller.ts`、`src/curator.ts`、`src/tools.ts`、`tests/core.test.ts`、`tests/background.test.ts` | 同 A | 见 §4.4 | 0.8.5 | 2026-09-19 |
| F 进度语义 | ✅ | `src/distiller.ts`、`src/curator.ts`、`tests/background.test.ts` | 同 A | 见 §4.5 | 0.8.5 | 2026-09-19 |
| G1 注入瘦身 | 👀 | — | — | — | — | — |
| G2 证据层 | 👀 | — | — | — | — | — |
| H 改名 op | ✅ | `src/curator.ts`、`src/memory-store.ts`、`src/types.ts`、`src/client/*`、`tests/background.test.ts` | 同 A | 见 §4.6 | 0.8.5 | 2026-09-19 |
| I 删除流程收敛 | ✅ | `src/routes.ts`、`src/types.ts`、`src/client/memory-section.tsx`、`src/client/locales.ts`、`tests/routes.test.ts` | 同 A | 见 §4.7 | 0.8.5 | 2026-09-19 |
| J 退役收尾 | ✅ | `src/distiller.ts`（删除）、`src/routes.ts`、`src/types.ts`、`src/memory-store.ts`、`src/tools.ts`、`src/card-discipline.ts`、`src/llm-direct.ts`、`src/curator.ts`、`src/index.ts`、`src/light-sweep.ts`（注释）、`src/client/*`、`tests/*.test.ts`、`scripts/check-plugin-graph.mjs`（Han 白名单）、`docs/memory-topic-cards/*`、`docs/ARCHITECTURE.md` | `cd plugins/plugin-memory && npm run typecheck && npm test` · `npm run build` · 仓库根 `npm run check:graph` · `npm test` | 见 §4.8 | 0.8.10 | 2026-09-21 |

> **版本号说明**：A–F 是同一个**未提交**改动集，因此共用一次补丁号提升：**已发布的 0.8.4 → 0.8.5**。（实施过程中一度按工作树的中间状态记成了 0.8.6，那是把未提交的递增当成了已发布版本；已按「已提交基线是 0.8.4」校正。）`suiteVersion` 由插件版本号派生，未提交前这个数字只是"提交时必须带上的号"，不代表已经投递。

### 4.1 A + C 的实施记录（2026-09-19）

**实际范围超出原方案**：原 §3 A 只要求「截断时禁止破坏性编辑」，实施中经两轮独立审查发现并修复了三个方案未预见的问题。

**实现要点**

1. `serializeStore` 返回 `seen: Map<key, 哈希>`（正文实际下发的卡）、`omitted: string[]`、`nextAnchor?: string`、`blockedBy?: string`。
2. `applyEdits(store, parsed, seen)` 的 `claim()` 增加读前校验，拒绝原因分三类：`unseen`（正文从未下发）、`stale`（下发了但内容已变）、`invalid`（形状/存在性/pin/引用上限）。计数 `skippedUnseen` / `skippedStale` 返回并打日志。
3. **旋转锚点用 key 而非偏移量**。原方案写的是偏移量 `nextCursor`；审查指出截断 pass 的常态就是删掉刚读过的卡，删 d 张会让后续卡片前移 d 位，偏移量仍按旧坐标前进 → 每轮跳过 d 张未读卡，最坏情况是幸存下来的恰好是从未被审阅的那批。改为 `nextAnchor = omitted[0]`（第一张未下发的卡的 key）：该卡必然不在 `seen` 中，故本轮任何编辑都无法 claim 它，编辑结束后仍可定位。
4. **`blockedBy` 兜底**：单张卡超过整个输入预算时（手改文件不校验读取长度，`parseCard` 不执行 400 字符上限），`included === 0`，锚点会永远指向同一张卡。此时返回 `blockedBy` 并清空旋转、记 warn，而不是记一个会导致死循环的锚点。
5. **零进展兜底**：截断 pass 且 `touched === 0` 时累加 `curateStalls[scope]`，达到 `CURATE_STALL_LIMIT = 2` 即 `recordCurated` 并清计数、记 warn——否则「永远 due 且永远零进展」会形成每 10 分钟一次全价调用且无上限的烧钱循环。有进展时 `clearCurateStall`。
6. **`cardFingerprint`（时钟无关）**：`seen` 的哈希原用 `contentHash(renderCard(card))`，而 `renderCard` 含 `created`/`updated`，手改卡缺 frontmatter 时这两个字段回落到 `todayStamp()` → 跨午夜会把同一内容误判为 stale。新增导出 `cardFingerprint(card)`，只取 `name|category|summary|body|malformed`。
7. **prompt 同步**：`buildCuratePrompt` 增加 `opts.omitted`，system 半加禁止引用规则，user 半加 `--- Cards omitted from this pass (never cite these keys) ---` 清单——否则越预算指令会命令模型去编辑它看不见的卡，编辑被结构性拒绝后 store 永远收缩不到预算内。
8. **文档修正**：`upsert` 的 JSDoc 原称「body/summary/category 变化都会 bump `updated`」，实际只在 body 变化时 bump，与 `cardFingerprint` 的注释矛盾，已改正。

**验收证据（执行结果）**

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过，无输出 |
| `npm test` | `tests 137 / pass 137 / fail 0`（改动前 116，新增 21） |
| `npm run build` | `built @dsh-app/plugin-memory: lib/index.js + lib/client.js` |
| `npm run check:graph` | `plugin graph: 17 plugins, followed line ^0.1.6-alpha.2 / ok — no violations` |
| `node --test test/plugin-version-bump.test.mjs` | `pass 1 / fail 0` |
| 产物核验 | `lib/index.js` 含 `cardFingerprint` ×4、`blockedBy` ×6、`curateStalls` ×10、`recordCurateStall` ×2 |

**变异测试（证明测试真的钉住了行为，而非同义反复）**

| 变异 | 结果 |
|---|---|
| 删掉 `unseen` 分支 | 3 个测试失败 |
| 删掉 `stale` 比对 | 1 个测试失败 |
| `blockedBy` 恒为 `undefined` | 2 个测试失败 |
| 对照断言：偏移量语义 vs key 锚点 | 断言 `notEqual` 成立，证明偏移量会跳过锚点 |

**两轮独立审查的结论与处置**

- 第一轮（reviewer 子智能体）：无严重项；指出 M1（偏移量锚点会跳卡）、M2（越预算指令与 unseen 守卫互相拆台导致永久空转）、m2（哈希含日期字段跨午夜误判 stale）、以及「`serializeStore` 未导出导致核心逻辑无法测试」。**全部已修**。
- 第二轮（针对修复本身）：确认 key 锚点不被任何编辑路径破坏（三条路径 + merge target 两道锁全部封闭）、`cardFingerprint` 不削弱 stale 检测、`start` 无越界路径、对照断言不脆弱；指出 M2 只把死锁从「必然」降到「可能」（已由 `CURATE_STALL_LIMIT` 兜底）、`included === 0` 时新围栏把零进展变成确定零进展（已由 `blockedBy` 兜底）、M2 修复无测试覆盖（已补 3 个）、以及一条同义反复的旧测试（已替换为真实状态迁移测试）。

**残余风险**

| 风险 | 说明 |
|---|---|
| `omitted` 清单随 store 无界增长 | 已下发全文索引之外再重复一遍 key；550 张卡时约 14k 字符。当前实测卡数 5–7，暂不触发。若卡数增长需限长或改为就地标注 |
| `upsert` 仍非原子 | `claim` 校验与 `remove`/`upsert` 落盘之间仍有一个微任务窗口，理论上仍可丢一次并发写入。窗口已从「模型调用时长（最长 180s）」收窄到「微任务 + 一次 I/O」 |
| `topics/<key>.md` 存在但不可读 | `store.get()` 读失败返回 `undefined`，merge target 的碰撞守卫会放行并覆盖。需模型恰好猜中一个不在索引里的 key，概率极低，且该路径既有 |
| 真实卡数远低于所有门控阈值 | A/C 在真实使用中难以触发，行为由单测构造验证。实施后应观察日志中 `skippedUnseen` / `skippedStale` / 零进展的实际计数 |

### 4.2 B 的实施记录（2026-09-19）

**范围**：`src/memory-store.ts`（归档核心）、`src/types.ts`（常量与 wire 类型）、`src/routes.ts`（两个新路由）、`src/client/memory-section.tsx` + `locales.ts`（设置页区块）、`tests/core.test.ts` + `tests/routes.test.ts`。

**实现要点**

1. `<scope>/archive/<YYYY-MM-DD>/<key>.md` 保存被删卡片的 `renderCard` 输出。归档在 `remove()` 与 `forget()` 的 `removeTree` 之前发生，**三个自动删除源**（curator 的 delete / merge、light-sweep 的重复合并、`memory_forget` 工具）全部覆盖；`remove()` 增加 `reason` 参数（`forget` / `curate-delete` / `curate-merge` / `light-sweep-dup`），仅用于诊断日志，不写进归档文件——归档文件与 `topics/<key>.md` 逐字节相同，可直接拷回。
2. `archive/` 在 `topics/` **之外**，因此天然不参与注入、`list()`、索引、相似度门控、统计与迁移；`stats().sizeBytes` 也不含归档。
3. **保留期与数量上限**：`ARCHIVE_RETENTION_DAYS = 30`、`ARCHIVE_MAX_FILES = 200`（声明在 `types.ts`，因为 client 半要渲染这两个数字，而 client 是浏览器 bundle，不能 import `memory-store.ts` 的 `node:fs`；`memory-store.ts` re-export）。清理挂在归档写入路径上，不引入定时器。
4. `clear()` 一并清空归档（用户显式重置 = 干净状态）。
5. 客户端设置页新增归档区块：列出条目、逐条恢复、超过 5 条折叠、归档写入失败时显示告警；恢复与清空后刷新面板。
6. 路由 `GET /archive`（scope 从 query string 取）与 `POST /restore`（body 带 `day`/`file`/`topic`），失败按 `occupied` / `missing` / `invalid` 返回不同 `HostText` 错误码。

**验收证据（执行结果）**

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | `tests 151 / pass 151 / fail 0`（B 开始前 146，新增 5） |
| `npm run build` | `built lib/index.js + lib/client.js` |
| `npm run check:graph` | `ok — no violations` |
| `node --test test/recursive-delete-guard.test.mjs` | `pass`（见下 S1） |
| `node --test test/plugin-version-bump.test.mjs` | `pass 1 / fail 0` |
| 产物核验 | `lib/client.js` 不含 `node:fs` / `node:crypto`（浏览器半未被污染） |

**独立审查（reviewer 子智能体）的发现与处置**

| 严重度 | 发现 | 处置 |
|---|---|---|
| 严重 | **S1**：`pruneArchive` 用 `rmSync`/`rmdirSync` 触发仓库硬门禁 `test/recursive-delete-guard.test.mjs` 变红——审计器不区分是否 recursive，插件源码新增 sync 删除必须走插件自己的 walker 或进 AUDIT 名单。**已实测复现**（该测试报 `memory-store.ts calls a sync recursive delete (2x) and is not on AUDIT`） | 改为走 `removeTree`（仓库唯一受认可的删除器），`archiveCard`/`pruneArchive` 转 async。门禁恢复绿 |
| 中等 | **M1**：同日同 key 二次删除保留第一份 → 永久丢掉**最新**那版内容，与"撤销"目的相反 | 同日冲突改为落 `<key>~<HHMMSS>.md` 并存；`archivedCards()` 返回 `file`（恢复句柄）与 `topic` 两个字段；`restoreArchived(day, file, topic)` 对 `file` 单独加正则围栏 |
| 中等 | **M2**：`/restore` 的四个失败码没进客户端映射表 → zh 用户看到英文诊断，字典里四条中文成死键，违反「宿主不下发散文」硬约定 | 四个 key 补进 `routeErrorCopy` |
| 中等 | **M3**：归档面板只覆盖 global scope；删除/清空后不刷新 | 删除与清空路径补 `loadArchive()`。**project scope 未做**——见下方残余风险 |
| 中等 | **M4**：归档失败被彻底吞掉，用户以为有归档实际没有 | `archiveCard` 记录 `lastArchiveFailure`，经 `/status.archiveError` 暴露，设置页显示告警；`pruneArchive` 移出归档写入的 try（prune 失败不再被误报为归档失败） |
| 中等 | **M5**：prune 的两条边界（保留期、数量上限）零覆盖 | 补 4 条测试：保留期边界（窗口内 1 分钟 vs 窗口外 1 分钟）、数量上限（205 条 → 剩 200，删最旧）、junction 不被走进、归档失败仍放行删除 |
| 轻微 | **L1**：`types.ts` 的 wire 类型无人使用，客户端自造同形接口 | 路由标注 `MemoryArchiveResponse`，客户端 import 该类型 |
| 轻微 | **L4**：`archivedCards()` 不过滤非法 topic，面板会出现点了必然失败的条目 | 列表阶段过滤 `isValidTopic` |
| 轻微 | **L3**：malformed 卡的归档不是逐字节原样（`renderCard` 重新拼 frontmatter） | 未改：内容不丢，形状会被规范化。已知边界 |

**变异测试（证明测试真的钉住了行为）**

| 变异 | 结果 |
|---|---|
| 关掉 `remove()` 的归档 | 1 个测试失败 |
| 关掉 `forget()` 的归档 | 6 个测试失败 |
| 数量上限差一（`- MAX` → `- MAX + 1`） | 1 个测试失败 |
| 保留期 cutoff 放宽一天 | 初次**未被捕获**（原测试回拨了整 1 天，边界太松）→ 收紧为「窗口内 1 分钟 vs 窗口外 1 分钟」后捕获 |

**残余风险**

| 风险 | 说明 |
|---|---|
| 归档面板只列 global scope | 项目作用域被自动合并/删除的卡写进了 `projects/<slug>/archive/`，但设置页列不出来。路由已支持 `?scope=project&slug=…`，缺的是客户端分节渲染。建议与 D 的台账界面一起做 |
| 归档不覆盖 `upsert` 覆盖 | curator 的 `rewrite` 与 merge 对 target 的覆盖走 `upsert`，不经归档——同样是不可逆覆盖，撤销覆盖不到。属本特性的边界，已在 §5 记录 |
| `console.warn` 未走插件 logger | 归档失败的诊断走 `console.warn` 而非 `ctx.logger`，不参与既有的日志脱敏/截断。当前 store 层拿不到 logger，改造面较大，暂记 |
| malformed 卡归档后被规范化 | 恢复出来的卡 frontmatter 会被重新生成（内容不丢）。见 L3 |

### 4.3 D 的实施记录（2026-09-19）

**范围**：`src/memory-store.ts`（LedgerEntry、recordLedgerBatch、attachLedger、forget/clear 落痕）、`src/curator.ts`（事件收集与批量落盘）、`src/light-sweep.ts`、`src/routes.ts`（`GET /ledger`）、`src/types.ts`、`src/client/memory-section.tsx` + `locales.ts`、`tests/*.test.ts`。

**实现要点**

1. `LedgerEntry` 记录**对象**而非计数：`{ at, scope, pass: 'curate'|'light-sweep'|'forget', op: 'merge'|'delete'|'rewrite', keys, target?, rejected?, session? }`。现有 `recordLlmAudit` 记 token、`recordDistill` 记 saved 计数，都不回答"哪张卡被动了"。
2. `applyEdits` 额外返回 `events`，成功与**被拒绝**（`unseen`/`stale`/`over-limit`）都收集；`invalid`（形状就不对）不记。由 `curate()` 一处落盘，带上 scope 与 session。
3. **`forget` 的台账下沉到 `MemoryStore.forget()` 内部**，而不是让每个调用方自己记——否则设置页路由的删除会漏。为实现这点新增 `MemoryStore.attachLedger(owner, scope)`，由 `MemoryRoot` 在 global / `projectFor` / `projectBySlug` 三处调用。
4. 客户端设置页新增台账区块；`/ledger` 返回最近 50 条。

**验收证据**

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | `tests 167 / pass 167 / fail 0`（D 开始前 159，新增 8） |
| `npm run build` | `built lib/index.js + lib/client.js` |
| `npm run check:graph` | `ok — no violations` |
| `node --test test/recursive-delete-guard.test.mjs test/plugin-version-bump.test.mjs` | `pass 4 / fail 0` |

**独立审查（reviewer 子智能体）的发现与处置**

| 严重度 | 发现 | 处置 |
|---|---|---|
| 严重 | **F1** 逐条 `recordLedger` 每次读写整个 state 文件；被拒事件数量不受限，一次几百条 `unseen` 会把真正的 merge/delete 记录挤出 200 条 FIFO，台账退化成噪音墙 | 新增 `recordLedgerBatch`（整批一次读写），`curate()` 改为批量落盘；被拒事件每轮最多记 `MAX_LEDGER_REJECTED_PER_PASS = 3` 条，其余只记日志计数 |
| 中等 | **F2** `clear()` / `removeProject` 完全不留痕——最彻底的删除反而零记录，且它们连归档一起删，事后无法解释也无法恢复 | 两者都改为**删除前**记录全部被删 key（`clear` 先读 key 再销毁） |
| 中等 | **F3** 台账写入失败会把「已完成的删除」变成对用户报错，并可能跳过 curator 的 stall/cursor 收尾 | `recordLedgerBatch` 整体 try/catch 并降级为 `console.warn`：诊断数据永不改变主操作的成败 |
| 中等 | **F4** project scope 的台账行在 UI 里既恢复不了也对不上项目（归档面板只列 global） | **未做**，见残余风险 |
| 中等 | **F5** 台账行只显示 `HH:MM`，跨天记录无法与归档的 `<YYYY-MM-DD>` 对上 | 新增 `fmtDayTime`（`MM-DD HH:MM`） |
| 轻微 | **F6** 台账条目无运行时校验，而客户端是唯一逐字段解引用它的面板（`keys.join` 遇非数组会崩） | 新增 `isLedgerEntry` 过滤，坏条目直接丢弃而非"修复" |
| 轻微 | **F7** 测试辅助函数返回类型漏 `events` | 补齐返回类型 |
| 轻微 | **F8** 撞 `MAX_CURATE_CITED_KEYS` 上限的拒绝**完全不可见**（不计数、不打日志、不进台账） | 新增 `over-limit` 拒绝原因，计入 `skippedOverLimit`、打日志、进台账、进客户端字典 |
| 轻微 | **F10** 恢复动作不在台账 | **未做**，见残余风险 |
| 轻微 | **F11** 台账为空时整个面板消失（字典里的 `empty` 是死键） | 空台账与空归档都渲染空态 |
| 轻微 | **F13** `LedgerEntry` 与 `MemoryLedgerRow` 手写重复 | **未做**（字段一致，仅风格隐患） |

**审查中「已排查、不成立」的三条**（记录以避免重复怀疑）：`attachLedger` 无遗漏（全仓 4 处 `new MemoryStore(` 都已覆盖，`listProjects` 内那处只读）；`ledgerOwner` 的循环引用不会泄漏（mark-and-sweep 可回收，且 `JSON.stringify` 从不触及 store/root）；同步读-改-写之间不会丢更新（所有 writer 都是完全同步的 RMW，没有跨 `await` 持有 state）。

**变异测试**

| 变异 | 结果 |
|---|---|
| 删掉 `forget` 的台账记录 | 2 个测试失败 |
| 删掉 `clear()` 的台账记录 | 1 个测试失败 |
| `ledgerEntries` 去掉同毫秒 tie-break | 1 个测试失败（**这次先由一次真实测试抖动暴露**） |

**测试抖动与随之发现的实际缺陷**：`ledger: entries are bounded` 在多次运行中偶发失败。定位为 `ledgerEntries()` 只按 `at` 排序——同一批事件共享毫秒时，稳定排序会保持插入顺序（最旧在前），与「newest first」的契约相反且不确定。已改为按 `at` 降序、同值按插入序倒序，并补测试钉住。这是本轮唯一由测试**自己**暴露的问题。

**残余风险**

| 风险 | 说明 |
|---|---|
| project scope 的台账行在 UI 里无法恢复、也对不上项目 | 归档面板只列 global（B 的遗留），台账却含 project 条目；且台账显示原始 slug 而项目区块显示 cwd basename。路由已支持 `?scope=project&slug=…`，缺客户端分节渲染与 slug→标题映射 |
| 恢复动作不在台账 | 恢复后台账仍写着"删除"，归档面板也仍列出那一份（再点报 `occupied`），两个面板在恢复后自相矛盾 |
| `cleanBody` / `cleanSummary` 等 `continue` 仍然静默 | 凭证、超长正文、目标键冲突等拒绝不计数也不进台账（F8 只修了 cited-keys 上限这一类） |
| `LedgerEntry` 与 `MemoryLedgerRow` 手写重复 | 字段今天一致，漂移需靠 `routes.ts` 的赋值检查兜底 |

### 4.4 E 的实施记录（2026-09-19）

**范围**：新增 `src/card-discipline.ts`；改 `src/prompt.ts`、`src/distiller.ts`、`src/curator.ts`、`src/tools.ts`；测试在 `tests/core.test.ts`、`tests/background.test.ts`。

**问题**：卡正文与索引摘要会被注入未来每一个会话。模型若在其中叙述"保存这个动作"（"我已把这条存入记忆"、"根据记忆库 X 卡…"），这段文字会被永久再注入，并被后续 pass 当成事实继承。

**实现要点**

1. **规则收敛为单一常量** `CARD_TEXT_DISCIPLINE`（新模块 `card-discipline.ts`），四个"要求模型写卡文本"的面共用：常驻 `GUIDELINES_TEXT`、distiller、curator、以及 `memory_save` 的工具描述（导出为 `SAVE_TOOL_DESCRIPTION` 以便测试）。同模块导出 `CARD_TEXT_SURFACES` 名册，测试遍历它——新增一个面而不带规则会失败。
2. **禁令作用在「行为」而非「词汇」**：初版写的是"不得提及 memory / cards / topics / the index"，审查指出这会**误伤本域合法内容**——本插件自己的开发记忆恰恰必须提到 topic key、索引、400 字符上限这些词。改为禁止"叙述保存动作"，并显式写明例外：卡片主题就是本记忆系统时，直接陈述其事实。
3. **覆盖 `summary`**：初版只说 body/content，而 `summary` 是**唯一注入时永不裁剪**的字段（索引全文下发，正文受配额与预算截断），是最不该藏元叙述的地方。常量开头即写明"BOTH the body/content AND the one-line summary"。
4. curator 的 delete 清单增加一类：正文在**叙述记忆动作**的卡（并明确"不要仅因提到本记忆系统就删"），让漏网的卡在下一轮被清掉。

**验收证据**

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | `tests 171 / pass 171 / fail 0`（E 开始前 167，新增 4） |
| `npm run build` | `built lib/index.js + lib/client.js` |

**独立审查（reviewer 子智能体）的发现与处置**

| 严重度 | 发现 | 处置 |
|---|---|---|
| 中等 | **E1** 禁令作用在词而非行为，误伤本域内容（"用本插件开发本插件"时任何关于 topic key / index 的卡都违规），叠加 curator 的 "when in doubt, delete" 有清掉系统自身知识卡的风险链 | 改写为禁止"叙述保存动作"并显式加例外从句（要点 2） |
| 中等 | **E2** 规则只覆盖 body/content，漏掉 `summary`——而它恰是唯一永不裁剪的注入字段 | 常量首句并列 body 与 summary，测试单独断言这一句（要点 3） |
| 中等 | **E3** 第 4 个 prompt 面（`memory_save` 工具描述）未覆盖，而它是最高频的写入路径 | 抽出 `SAVE_TOOL_DESCRIPTION` 并纳入 `CARD_TEXT_SURFACES` 名册（要点 1） |
| 中等 | **E4** 测试锁字面短语（换措辞即失效、挪位置仍通过），且注释自称"断言需求而非措辞"与实现相反 | 规则抽成单一常量；测试改为 ①对常量做语义守卫（正向形式 + 否定形式 + summary 并列 + 例外从句）②遍历名册断言每个面 `includes` 该常量。改措辞只改一处，漏一个面立刻变红 |
| 轻微 | **E5** curator 的删除清单没点名元叙述，宿主侧无任何机械拦截 | 补进 delete 清单（要点 4）。**不加词表硬拦**——与本域记忆正面冲突且易绕过 |
| 轻微 | **E6** 常驻 GUIDELINES 无尺寸上限，新增成本无人看账 | **未做**：估算 +440 字符（约 2.1k → 2.5k），相对整段注入（满库约 9–12k）占 3–5%，可接受。加 `MAX_GUIDELINES_CHARS` 守卫属可选优化，记入残余风险 |
| 轻微 | **E8** 示例正文含仓库文件名 `pnpm-workspace.yaml`，与既有"不许保存一次读取就能得到的内容"有表面摩擦 | 已随 E1 的重写移除该示例 |

**审查中「已排查、不成立」**：新规则未删除或削弱任何既有规则（纯追加、维度不同）；不与 "NEVER save …" 直接冲突；新文本不破坏结构也不误伤既有断言（既有注入断言全是 `includes` 正断言，唯一负断言查的是 `other-secret`）；关闭记忆时无"无规范但有写入"的窗口；三处新增文本全为 ASCII，未违反插件字典约定。

**变异测试**

| 变异 | 结果 |
|---|---|
| 从 `GUIDELINES_TEXT` 删掉规则 | 1 个测试失败 |
| 从 distiller 删掉规则 | 1 个测试失败 |
| 从 curator 删掉规则 | 1 个测试失败 |
| 从 `memory_save` 描述删掉规则 | 1 个测试失败（**这条正是 E3 之前无人保护的面**） |

**残余风险**

| 风险 | 说明 |
|---|---|
| 纯 prompt，无机械拦截 | 宿主侧只有 `stripCommitIds`（剥 7–12 位十六进制）与 `containsCredential`；日期、session id、元叙述都不拦。这是本轮的设计选择（§3 E 只要求 prompt 层），且 `DESIGN.md` §0 已记着上一次"prompt 明令禁止、违规照样累积"的教训——若真实数据里违规率不低，应升级为可观测（如复用 `recordSuspect` 记一条状态页可见的信号）而非词表硬拦 |
| 常驻规范无尺寸上限 | `GUIDELINES_TEXT` 现约 2.5k 字符，随每次 assembly 下发。再加规则前建议先做交换或加 `MAX_GUIDELINES_CHARS` 守卫 |
| 手工验收未执行 | 方案 §3 E 的第 2 条验收（真跑一轮 distill 检查落盘正文）需要真实模型调用，本环境无法执行。这是**未验证项**，不是"已验证" |

### 4.5 F 的实施记录（2026-09-19）

**范围**：`src/distiller.ts`、`src/curator.ts` 的 JSDoc 与调用点；`tests/background.test.ts` 新增 15 个测试。

**问题**：进度不变量只存在于代码顺序里——没有测试钉住，也没有写进 JSDoc。后续重构很容易把 `advanceDistill` 提前到模型调用之前，那会造成「内容没落盘但进度已推进」的静默丢失。

**实现要点**

1. `distiller.ts` 模块 JSDoc 增加「**Progress invariant — do not reorder.**」段落，说明游标即「此点之前都已判断过」的声明，并指出唯一的无调用推进点是 `runDistill` 的「材料太少」分支（那里推进正因为没有东西可丢）。`runDirect` 调用点加行内注释。
2. `curator.ts` 模块 JSDoc 增加对称说明：`recordCurated` 只在①编辑落盘后②看完整份卡列表后才跑；并**明确列出两个偏离「看完整份」的逃生舱**（超预算零改进、截断连续零进展达 `CURATE_STALL_LIMIT`），提醒读者不要把「有 hash」当成「全看过」的证明。
3. **修正一处真实缺陷**（见下）。
4. 15 个测试通过 stub 的 `ctx.llm.stream` 驱动**真实的 `runDirect` / `curate`**，覆盖两侧的不变量。

**审查发现的真实缺陷与处置**

| 严重度 | 发现 | 处置 |
|---|---|---|
| 中等 | **F1**「无 model route 也推进」会吃掉真实内容：`runDirect` 只在门控通过（确有新料）后才被调用，而 `request/header` 是在 step 内、dispatch 前追加的，一个 turn 可以无 step 关闭——于是存在「已有表面对话材料、但还没有 header」的窗口。这个分支把这段增量直接注销，且该跳过不进 `recordLlmAudit` 也不进 `recordDistill`，设置页完全看不到 | **改为不推进**：没有 route 可重试的代价只是一次 prompt 组装与一行日志，而丢掉的是真实内容。JSDoc 相应改写（原来的「唯一例外」论证对「暂时没有 route」不成立） |
| 中等 | **F2** JSDoc 把不变量写成「两个条件」，但代码里还有两条记录路径（超预算零改进、截断停滞退避），与 20 行后的实现矛盾 | 补成显式的「TWO deliberate escapes from whole list」，写明各自买到的边界与弱化了的保证 |
| 中等 | **F3**「编辑已落盘才记录」这半条零测试保护：4 个 curator 测试的模型回复全是 `{"edits":[]}`，把 `recordCurated` 上移或用 `finally` 记录会全部通过 | 补测试：把 `remove` 打桩成 reject → 断言 `curatedHashOf` 仍为 undefined。**变异验证**：`try/finally` 记录会被它捕获 |
| 中等 | **F4** `sweep()` 的 `selectTargets()` 在 per-target try 之外，`readdirSync` 的瞬时 EACCES/EPERM 会逃逸；两个调用点都是 `void`，而仓库没有 `unhandledRejection` 处理器 | `selectTargets()` 单独 try/catch；同时把 per-target 的日志「store untouched」改为不带这个断言（部分写入后该措辞是假的） |
| 轻微 | **F5** `recordDistill`/`onSaved` 在游标推进之后，它们抛错时外层 catch 会记「progress kept, will retry」——而此刻增量已被消费，这条日志是假话 | 把「点无返回之后」的两步包进自己的 try/catch，措辞改为「delta consumed and N card(s) written, but the trace/maintenance step failed」 |
| 轻微 | **F6** `clearCurateStall` 只在 `touched > 0` 时调用，陈旧的计数会跨过完整 pass 存活，让下一次提前退避 | 完整 pass 记录时一并清计数 |

**审查中「已排查、不成立」**（记录以避免重复怀疑）：实例属性打桩不污染其它测试（每个测试新建 `MemoryRoot`，`node:test` 顶层串行且每文件独立进程）；打桩未绕过真实路径（`runDirect` 只读 `this.root`/`this.log`/`this.abort` 与 `resolveLlm(ctx)`，`curate` 用真实 store 与真实 `serializeStore`）；9 个测试无一同义反复（若 stub 形状错，断言会以相反方向失败）→ 后经扩展为 15 个；`advanceDistill` 前的写入确实全部 await 且已 rename 落盘；`recordCurated` 之后只剩锚点写入，不构成「记录了完成却没跑完」；`foldRequestHeader` 只在从没有过 header 时返回 undefined，已 dispatch 的会话不会突然失去 route；新增测试不 flaky（`cardFingerprint` 有意排除日期）。

**验收证据**

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | `tests 182 / pass 182 / fail 0`（F 开始前 167，新增 15） |
| `npm run build` | `built lib/index.js + lib/client.js` |
| `npm run check:graph` | `ok — no violations` |
| `node --test test/recursive-delete-guard.test.mjs test/plugin-version-bump.test.mjs` | `pass 4 / fail 0` |

**变异测试（5 个，全部被捕获）**

| 变异 | 结果 |
|---|---|
| `advanceDistill` 移到 `applyEntries` 之前 | 1 个测试失败 |
| `distiller` 的无 route 分支改回「推进」 | 1 个测试失败 |
| curator 的 `if (!truncated)` 改成 `if (true)` | 1 个测试失败 |
| `recordCurated` 用 `try/finally` 包住编辑 | 2 个测试失败 |
| 空转计数不清除 | （由 F6 的修复覆盖，未单独变异） |

**残余风险**

| 风险 | 说明 |
|---|---|
| `applyEdits` 中途 I/O 失败会丢掉已落盘编辑的台账记录 | 事件在 `applyEdits` 返回后批量写，若第 3 条 `remove` 抛错，已删除的卡没有台账条目（归档文件仍在，但面板上"为什么没了"无答案）。修复需要把事件收集改为回调式，改动面较大，记入后续项 |
| 重试后 `saved` 计数会漏报 | 卡文件写成功但 `reindex()` 抛错时游标不推进（正确），重试时提案被写入门跳过 → `applied = 0` → 活动记录写「saved 0」且本轮不触发维护。仅影响诊断与维护延迟，数据一致 |
| 「第 3 条提案抛错」的状态未被测试覆盖 | 当前覆盖了「整轮写入失败」，未覆盖「部分成功后失败」；重试收敛性由写入门（`hasContent`/`findSimilar`）保证，但该保证只被「整条重跑」的用例间接验证 |
| `onSaved` 这条缝零覆盖 | 测试传 `parent = null` 且从不注入 `onSaved`，因此「推进后 onSaved 失败」的行为由代码推理而非测试保证 |

### 4.6 H 改名 op 与存量数据修复（2026-09-19）

**来源**：不是方案里的条目，而是复核「存量记忆写入是否正确」时发现的两个真实问题。

#### H1：协议无法给单张卡改名（代码修复）

**问题**。restructure 指令要求把 `legacy-*` 卡改成正常主题键（「a legacy key should not survive this pass」），但编辑协议只有 `merge` / `delete` / `rewrite` 三种 op：
- `rewrite` 保留 `card.name`，键不变
- `delete` 只删，且没有 create op 可以补回
- `merge` 要求 ≥2 个被引用键

于是**孤立的一张 legacy 卡在协议上无法改名**。实测：单卡 merge → 新键被整条拒绝（`merged=0`）；对照的两卡 merge → 新键成功。

**判定证据（存量 store）**：`test-956819a6` 记录的 `curated` 哈希与当前 `fingerprint()` 完全一致 → curator 确实审过含 legacy 卡的这份内容，却什么也没改。此前我把它归因为「模型判断该卡孤立、选择不改」——**归因错了**，是协议表达不了。

**修复**：`merge` 的目标键是新键时，允许只引用 1 张卡（即改名）。复用现有的目标键校验、碰撞守卫、幸存者查重。同时：
- prompt 新增 `rename` 规则与输出契约示例（否则模型不知道这个能力存在）
- restructure 指令改为「RENAME it when it stands alone, or MERGE it」
- 台账 `op` 增加 `'rename'`（客户端标签「改名」），让面板说的是「改名」而不是「合并」
- `ArchiveReason` 增加 `'curate-rename'`

**验收**：新增 5 个行为测试（单卡改名生效 / 改名也归档旧卡 / 单卡 merge 到自身仍被拒 / 不能落到已存在的未引用键 / 新键仍需合法）+ 2 个 prompt 契约测试。变异验证：把 `isRename` 恒置 `false` → 2 个测试失败。

#### H2：存量数据修复（两张卡）

**`wps-com-pptx-pdf`**：正文 738 字符（上限 400）、summary 47 字符（上限 40）——**全库唯一违反上限的卡**。两项上限在所有写入路径上都有校验，所以它不是从插件写入路径进来的（最可能是直接写文件）。内容是**两个主题**（选哪个工具 + 怎么驱动 WPS COM），且含会腐烂的值（版本号 `0.12.5`、`.tmp\` 临时脚本路径）。

处理：拆成两张合规卡，技术细节全部保留，去掉版本号与临时脚本路径；原卡经 `store.remove()` **归档**（可从设置页恢复）。

**`zcode-snapshot-upload-blocked`**：正文里有两处绝对日期，其中一处出现在「已用 icacls 锁定…」的叙述句中。

处理：只去掉叙述句里的日期。**备份目录名 `checkpoints-archived-2026-09-18` 里的日期保留**——那是标识符，去掉就找不到备份了。

**修复后核对**：该项目 9 张卡，超长正文 0、超长 summary 0；`index.md` 已由宿主重建（含两张新卡、不含旧卡）；归档里能找回被替换的原卡。

**顺带量化的一处**：`test-956819a6` 注入时丢掉 3 张、`kimicode-configure-6090a484` 丢掉 5 张——**不是**超长卡挤占，而是 `CATEGORY_QUOTA`（lesson 只取 2 张）与预算共同作用。这是设计内的行为（丢弃的卡仍可 `memory_recall` 取回），此前我把它当成超长卡的危害，测量后纠正。

#### 验收证据

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | `tests 188 / pass 188 / fail 0`（H 之前 182，净增 6） |
| `npm run build` | `built lib/index.js + lib/client.js` |
| `npm run check:graph` | `ok — no violations` |
| 仓库根 `node --test test/*.test.mjs` | `tests 269 / pass 269 / fail 0` |

#### 后续项（本轮未做）

| 项 | 说明 |
|---|---|
| 测试运行器会跑已删除测试的陈旧 bundle | `scripts/test.mjs` 按 `testsDir` 决定**打包**什么，却按 `readdirSync(outDir)` 决定**运行**什么，且从不清空 `.test-dist/`。删掉一个测试文件后它仍会执行（本轮实际发生：一个已删探针继续运行）。同套件的 `plugin-doc/pdf/ppt/sheet` 四个运行器都先清 `.test-dist`，plugin-memory 没有。修法：对齐这四个 `rmSync(outDir, { recursive: true, force: true })` + 在 `test/recursive-delete-guard.test.mjs` 的 AUDIT 里补一条 |

### 4.7 I 删除流程收敛（2026-09-19）

**来源**：用户在实际使用设置页后反馈。删掉一条记忆后，界面同时出现三处提示，但**没有一处能完成用户想做的事**。

#### I1 归档面板读错作用域（真实缺陷，B 的遗留）

**现象**：删掉一条项目记忆后，「已删除的记忆」显示 `（0）`，而副本**确实存在**于
`projects/test-956819a6/archive/2026-09-19/rsi-dev-disabled-rows.md`。

**根因**：`GET /archive` 不带 scope 参数时 `resolveStore` 落到 `root.global`，而全局一张卡都没有。这是 §4.2 里已经写下的残余风险（"归档面板只列 global scope"）——**当时记录为后续项而没有修，用户第一次用就踩中**。

**修复**：不带 scope 时返回**所有作用域**的归档，每行带 `scope`（`'global'` / `'project'`）与 `slug`（项目 slug），恢复时按同一组字段寻址——与 pin/forget 路由的 scope 词汇一致。打开面板即可看到 `已删除的记忆（N）` 与逐条「恢复」。

**回归测试**：新增 `GET /archive lists EVERY scope, not just global`，断言两个作用域的副本都列出、slug 正确、恢复后回到**原作用域**且不泄漏到 global。变异验证：把跨作用域分支关掉 → 2 个测试失败。

#### I2 手动删除混进「最近整理记录」

**现象**：用户删掉一条卡，它出现在「最近整理记录」里，而那是只增不改的审计列表——既不能移除也不能恢复。

**根因**：D 的台账把**手动删除**与**后台整理**记在同一处。手动删除是用户自己做的，不需要解释；而台账没有、也不该有删除入口。

**修复**：**移除台账面板**。删除这件事只在「已删除的记忆」里出现一次，且可操作。数据与 `GET /ledger` 路由保留（诊断用，客户端注释说明为何没有面板），字典里的 `memory.ledger.*` 17 个键随之删除——不留死键。

#### I3 提示不消失

**现象**：`已删除 1 条记忆` 一直挂在页面上。

**根因**：所有确认提示都只在**下一次操作**时被清空，没有定时器。它看起来像状态标签，而实际是瞬时反馈。

**修复**：`NOTICE_DISMISS_MS = 6000`，`useEffect` 定时清空，新提示重置计时。

#### 适用范围的取舍

用户反馈的原话是「这么多功能 一个记忆模块」。收敛后的设置页保留：两个开关、三个统计、目录、最近提炼（后台提炼进度）、**已删除的记忆**（唯一可操作的列表）、清空、项目列表。台账面板去掉后，页面从三条并列列表减到两条，且删除只出现在一处。

#### 验收证据

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm test` | `tests 189 / pass 189 / fail 0`（I 之前 188，新增 1） |
| `npm run build` | `built lib/index.js + lib/client.js` |
| `npm run check:graph` | `ok — no violations` |
| 仓库根 `node --test test/*.test.mjs` | `tests 269 / pass 269 / fail 0` |
| 产物核验 | `lib/client.js` 不含 node 内建；`grep -c ledger lib/client.js` = 0（客户端已无台账残留） |

#### I4 归档缺「永久删除」（用户追问后补）

**现象**：用户问「要完全手动删除就点那个清除全局记忆？」——答案是**不能**。`清空全局记忆` 只清全局作用域，那两条副本在 `projects/<slug>/archive/` 里，点了毫无影响。

**根因**：归档有恢复、有自动过期（30 天 / 200 份），但**没有「我现在就要删」的入口**（`clearArchive` 这类方法根本不存在）。唯一能连带清掉它的是「删除整个项目的记忆」，而那会把在用的卡片一起删——代价完全不成比例。一个回收站却没有「清空」。

**修复**（两条路都补，因为二者对应不同意图）：

| 入口 | 用途 |
|---|---|
| 每条副本一行「永久删除」 | 「这一条我确认不要了」 |
| 面板底部「清空已删除的记忆（N）」 | 「这些我都不留了」 |

- `MemoryStore.deleteArchived(day, file)`：单条永久删除，`file` 走与 `restoreArchived` 相同的正则围栏（防路径逃逸），删完顺手清掉空日期目录
- `MemoryStore.clearArchive()`：清空一个作用域的归档并返回条数
- 路由 `POST /archive-delete`（day + file + scope/slug）与 `POST /archive-clear`（无 scope = 全部作用域，与 `GET /archive` 同规则）
- 两者都走既有的二次确认弹窗（不用原生对话框），确认文案明确写「记忆列表不受影响」

**验收**：新增 1 个路由测试，覆盖——单条删除后另一条仍在、**在用卡片不受影响**、重复删除返回 409、`../survivor` 这类非法文件名被拒且不触及任何文件、`/archive-clear` 返回清掉的条数且列表完好。变异验证：让 `deleteArchived` 只返回 `true` 而不真删 → 测试失败。

**每次实施的通用步骤**（顺序不可颠倒）：
```sh
cd plugins/plugin-memory
npm run typecheck          # tsc --noEmit
npm test                   # 插件自有套件
npm run build              # esbuild 打包两半
# 回到仓库根
npm run check:graph        # 插件图与套件名册规则
```

- 任何 `plugins/` 下的改动都需要**补丁版本号 +1**（`plugins/AGENTS.md:88-90`）：`suiteVersion` 由插件 `package.json` 的版本号派生，不 bump 就投递不到任何安装。
- 若改动触及设置页文案，需要同步插件字典的 zh/en 两份，且宿主只下发 `HostText { code, params }`。
- 若新增路由，路径必须落在 `/api/plugins/dsh-app/plugin-memory/<name>`，段内不含 `@`，只用 GET/HEAD/POST。

### 4.8 J 退役收尾（2026-09-21）

**来源**：`cfe0484`（退役全局作用域 + 停用后台抽卡）与 `472f554`（移除设置页的全局区块）留下的是**兼容面与死代码**：路由仍能为退役作用域服务，`src/distiller.ts` 的抽取链路仍在源码里，`distill-state.json` 的游标/审计状态仍被读写，测试仍在固定这些主题，两份文档也仍按「双作用域 + 后台提炼」描述。本节记录把这三样一起收掉。

**删除清单**（逐项 grep 确认无消费者）

| 位置 | 删除内容 |
|---|---|
| `src/routes.ts` | `resolveStore` 的「无 scope 或 `scope:'global'` → root store」分支：scope 现在必填且只能是 `project`，否则 `route.scopeRequired` |
| `src/routes.ts` | `GET /status` 的 `cards` / `sizeBytes` / `storePath` / `globalList`（只服务已移除的全局区块）、`activity`（数据源随抽取链路删除）、`archiveError`（取自 root store，而它已不再接受归档写入） |
| `src/routes.ts` | `GET /entries` 的无 slug 分支（改为 `route.slugRequired`）；`POST /clear` 的「缺省 = 清全局」破坏性缺省；`GET /archive` 与 `POST /archive-clear` 对 root 作用域的枚举 |
| `src/distiller.ts` | 整个文件：`MemoryDistiller` 及其全部方法、`attach` 的 `session/event` 订阅与静默定时器、`buildDistillPrompt`、`renderExcerpt`、`memoryInput`、`messageText` / `blockText`、`ProposedEntry` 及只被它用的常量。仍被引用的 `SessionLike` 与 `directRouteOf` 迁入 `src/llm-direct.ts`（curator 仍在用） |
| `src/memory-store.ts` | `distillSeqOf` / `advanceDistill` / `ownSaveSeqOf` / `recordDirectSave` / `recordDistill` / `distillActivity` / `DistillProgress` / `DistillActivity` / `MAX_TRACKED_SESSIONS` / `MAX_ACTIVITY`，以及 `DistillState.sessions` / `.activity` 两个字段。**读取容错**：老文件里的这两个键被直接忽略，下一次写入顺手丢掉 |
| `src/types.ts` | `MemoryDistillActivity`（随面板一起死）；`MemoryArchiveRow.scope` 收窄为 `'project'`（`slug` 变必填）；`MemoryStatus` 只留 `enabled` / `distill` / `projects`；`MemoryLlmAuditRun.source` 收窄为 `'curate'`（历史行仍按文件原样透传） |
| `src/card-discipline.ts` | `screenCardText` / `SESSION_NARRATION` / `MIN_CARD_BODY_CHARS` / `MIN_CARD_SUMMARY_CHARS`——唯一调用方是被删的抽取链路；`CARD_TEXT_SURFACES` 去掉 `distiller` 一项（名册仍被 `core.test.ts` 遍历） |
| `src/tools.ts` | 保存路径上的 `recordDirectSave` 调用（只为已弃用游标服务） |
| `src/client/*` | 归档行的全局作用域标签分支与 `memory.scope.global`、归档失败提示（`memory.archive.failed`）、「最近整理」面板及其全部词条与 `fmtTime` / `formatBackend`（面板数据源已删）；`memory.host.scopeRequired` 文案改为「只能是 project」 |
| `scripts/check-plugin-graph.mjs` | Han 白名单里 `plugins/plugin-memory/src/distiller.ts` 的条目（文件已不存在）；`card-discipline.ts` 条目的理由改为「规则文本自身含中文标记」 |

**保留（有意不动）**：`root.global` 这个存储对象与 `migrateLegacyGlobalScope` / `moveRetiredGlobalArchive`（启动迁移照旧把卡片与归档一并搬进 `projects/legacy-global`，`config.json` 仍住在那层目录）、`memory.toggle.distill` 开关字段（现在只门控 curator）、`GET /llm-audit` 与 `GET /ledger` 路由、`distill-state.json` 这个**文件名**（改名会丢掉 curated 指纹、旋转锚点与台账）、`MemoryStore.clear()` / `lastArchiveError()` 等仍被迁移或测试使用的方法。

**删除/改写的用例**（主题消失，不是顺手削弱断言）

| 用例 | 为什么不再成立 |
|---|---|
| `background.test.ts`：`distill applyEntries: …` 14 条 | 主题（`MemoryDistiller.applyEntries`）整体删除 |
| `background.test.ts`：`buildDistillPrompt …` 2 条 | 提示词构建器随抽取链路删除 |
| `background.test.ts`：`progress: …` 6 条 | 固定的是 distill 游标语义（游标只在写成功后前进），而游标机制已删除 |
| `core.test.ts`：`ownSaveSeq` / `recordDirectSave` 2 条 | 同一套游标机制 |
| `core.test.ts`：名册用例里的 `distiller` 一项 | 该提示面不存在；其余三个面（guidelines / memory_save / curator）照旧断言 |
| `direct.test.ts`：`buildDistillPrompt …` 3 条 | 同上 |
| `e2e.test.ts`：`own-write marks its seq` / `the distill prompt …` 2 条 | 同上 |
| `routes.test.ts`：归档/恢复 与「列出每个作用域」2 条 | 主题仍成立，已**改写**为项目作用域版本，并补上：root 归档不再被枚举、`?scope=global` 被 `route.scopeRequired` 拒绝、无 scope 的 `/restore` 不再落到 root store |
| 新增 1 条 | `core.test.ts` 的 `distill-state: a file still carrying the retired extractor keys reads and rewrites clean`（容错契约的显式回归） |

**保留且仍被断言的契约**：不订阅 `session/event`（host apply 用例）、没有工作区的会话不产生任何卡片（三个工具的拒绝用例）、注入不含 root 作用域（`renderMemoryText` 用例）、curator 与 light-sweep 照旧（`applyEdits` / `serializeStore` / 旋转锚点 / 台账 / light sweep 用例全数保留）。

**验收证据（执行结果）**

| 命令 | 结果 |
|---|---|
| `cd plugins/plugin-memory && npm run typecheck` | 通过，无输出 |
| `npm test`（插件） | `tests 179 / pass 179 / fail 0`（改动前 207：删 29 条、新增 1 条） |
| `npm run build` | `built @dsh-app/plugin-memory: lib/index.js + lib/client.js` |
| 产物核验 | `lib/client.js` 无 `node:` 内建；`memory.activity` / `memory.backend` / `memory.scope.global` / `archiveError` / `MemoryDistillActivity` / `ownSaveSeqOf` / `recordDirectSave` / `distillSeqOf` / `advanceDistill` / `distillActivity` / `recordDistill` 在两个产物里均为 **0 次命中** |
| 仓库根 `npm run check:graph` | `plugin graph: 17 plugins, followed line ^0.1.6-alpha.2 / ok — no violations` |
| 仓库根 `npm test` | `tests 336 / pass 335 / fail 0 / skipped 1`（build 通过） |
| **迁移实测**（真实 store 的副本，原 store 只读） | 副本启动前：`topics/` 2 张卡 + `index.md`；一次启动后：`topics/` 0 张、`index.md` 消失、`projects/legacy-global/topics/` 2 张；`config.json` 的 sha256 前后一致；第二次启动仍为 2 张（幂等）；在该副本的 6 个会话（含无工作区会话与 5 个真实项目 cwd）上，迁移过来的 2 张卡在注入文本里 **0 次**出现，root store 卡数为 0 |
| **老状态文件容错**（同一副本） | 副本的 `distill-state.json` 仍带着 `sessions`（17 条旧会话进度）/ `activity`（20 条旧运行记录）：一次写入后这两个键消失、`curated` 保留、台账照常追加 |

**残余风险**

| 风险 | 说明 |
|---|---|
| 老 `distill-state.json` 里 `sessions` / `activity` 的字节会留到下一次写入 | 读取已忽略，写入即丢；在写入发生之前它们只是占位数据 |
| `GET /llm-audit` 仍可能有历史 `source:'distill'` 行 | wire 类型已收窄为 `'curate'`，读取端按文件内容原样透传（诊断用，客户端不渲染） |
| 台账仍以 `'global'` 标注 root store 的旧事件 | 这些事件来自退役作用域，改名会让新旧行不一致；等台账里不再有该 scope 的历史行再统一 |
| 归档失败提示随 `archiveError` 一起删除 | 该字段只反映 root store 的归档写入，而 root store 已不再接受写入。要覆盖**项目**归档需要按项目上报（新设计，不在本次范围） |
| 老版本客户端（更新的内核 + 旧页面） | 旧页面会请求已删除的 `/status` 字段并发送无 scope 的 `/pin`：字段缺失只影响渲染，无 scope 写入会被 `route.scopeRequired` 稳定拒绝——不会静默写到别处 |

### 4.9 L 读侧纪律、正文形状与索引增长策略（2026-09-21）

**来源**：一轮针对「记忆被怎么使用」的自查。此前注入侧只有写入纪律（怎么写一张卡），没有使用纪律（怎么用一张卡）；索引超过上限时也只是一句"还能用 memory_recall 取回"，没说模型该怎么让索引不再溢出。本节记录这三处补强，全部落在**「记忆怎么被使用」**而不是「记忆怎么被写入」。

| 位置 | 变更 |
|---|---|
| `src/prompt.ts` `cappedIndex` | 索引溢出提示从「还有 N 条，memory_recall 可列出」改成**完整的处置指令**：说明索引已超上限、在这里被截断；`memory_recall` 仍是按主题或关键词取回任何卡的路径；要停止溢出就**合并而不是新增**——一个主题一张卡、summary 保持在上限以内。两个数字取自 `MAX_INDEX_LINES` / `MAX_SUMMARY_CHARS` 常量（不再硬编码进文案），改了上限提示自动跟着变 |
| `src/prompt.ts` `GUIDELINES_TEXT` | 新增**读侧纪律**（此前只有写侧）：卡片是它被写下那一刻的快照，不是对现在的断言。点名了文件路径就确认文件还在；点名了函数、开关或配置键就先读或 grep；关于仓库现状的问题以仓库（或 git）为准；卡片与观察到的现状冲突时相信观察结果，用 `memory_save`（同主题）修正它、被彻底撤回的用 `memory_forget`，并说明改了什么，而不是照着过期正文行事 |
| `src/card-discipline.ts` | guidance 类卡（convention / lesson / decision）新增**正文形状**：先给规则或定下的选择，再给它成立的理由与它不覆盖的边界——一条孤立的规则没法拿来判断它没预见到的情况。理由必须是事实（约束、它能避免的失败），不是「当时怎么商定的」叙述。三处写入提示面（guidelines / `memory_save` 描述 / curator）共用这一常量，自动一起生效 |
| `src/prompt.ts` 模块头 | 更正一处过期描述：索引不再是「always whole」，改为「有上限，且上限会自己说明」 |

**新增用例 3 条**（`tests/core.test.ts`）：51 张卡的注入里索引恰好 50 行、提示点名上限与整理路径、且**恰好那一张超限的卡未被列出同时仍在 store 里**（这条是「recall 指针是否诚实」的回归）；读侧纪律的 5 个短语；正文形状的 3 个短语。

**版本**：插件 0.8.10 → **0.9.0**。本轮同时把版本号约定写成规则：补丁位是**单位数**，第十次改动进位到 minor（`0.8.9` → `0.9.0`），不出现 `0.8.10` 这类堆叠。规则落在 `plugins/AGENTS.md` §5 与 `docs/agents/build-and-release.md` §3。

**验收证据（执行结果）**

| 命令 | 结果 |
|---|---|
| `cd plugins/plugin-memory && npm run typecheck` | 通过，无输出 |
| `npm test`（插件） | `tests 182 / pass 182 / fail 0`（改动前 179，新增 3 条） |
| `npm run build`（插件） | `built @dsh-app/plugin-memory: lib/index.js + lib/client.js` |
| 仓库根 `node --test test/plugin-version-bump.test.mjs` | `tests 1 / pass 1 / fail 0`（0.9.0 高于最新发布标签，未被判为未升版） |
| 仓库根 `npm run check:graph` | `plugin graph: 17 plugins, followed line ^0.1.6-alpha.2 / ok — no violations` |
| 仓库根 `npm test` | `tests 336 / pass 335 / fail 0 / skipped 1`（build 通过） |
| 注入文本实测（临时脚本，51 张卡） | 索引恰好 50 行；尾行原文：`— 1 more topic is NOT listed above: the index is over its 50-line ceiling and is cut here. memory_recall reaches any card by topic or keyword. To stop the overflow, consolidate rather than add: merge the topics that cover one subject and keep every summary within 40 characters — one card per subject, the index a routing map.` |

**残余风险**

| 风险 | 说明 |
|---|---|
| 提示词纪律**无法用测试证明被模型遵守** | 用例只固定「文本在不在」，读侧纪律是否真的被执行只能在真实会话里观察；上一轮「模型会不会主动保存」同样仍是观察项 |
| 提示词改动要**重新构建并发布**才生效 | 当前运行中的内核仍带着旧插件版本，本轮改动在下次套件构建后才可见 |
| 索引溢出的根治仍依赖模型合并 | 提示词给的是处置指令；若模型不理，溢出的卡依然只存在于 `memory_recall` 的搜索可见面上（这是索引上限的固有代价，不是本轮引入） |

### 4.10 M 后台整理的任务说明与手动触发（2026-09-21）

**背景**：curator 此前只会「删」——合并近重复、删过期、删工作日志，规则之外没有别的动作。后果是两类知识在整理时被丢掉：工作日志里其实成立的教训（约束、根因、决定与理由），以及同一主题两张卡互相矛盾时没人裁决。同时整理只有自动门控（≥4 卡 + 指纹变化 + 冷却），用户想立刻整理时没有入口。本节记录把整理任务写清楚、并给用户一个手动入口这两件事。

**设计取舍（先说不做的形态）**：整理**只作用于已保存的卡片**，不从会话里读素材，也不做「整份文档覆盖写」。覆盖写会毁掉按键寻址、pin、删除前归档与恢复、台账与按需 recall——按卡编辑、落盘前校验、删除前归档是本模块已经建成的可恢复性，不能为一个更简单的实现让路。

**整理任务本身写进 curator 的 brief**（`curator.ts` 的 system 半边，六条）：

| 条 | 内容 | 我方原先的状态 |
|---|---|---|
| 矛盾卡以较新者为准 | 两张卡对同一主题说法不同时，**更新更晚的那张是当前状态**；合并成一张，或删掉被取代的那张，不留下两张并排被注入 | 只有"过期即删"，没有"同一主题两种说法"的处置 |
| 泛化而不是只删 | 工作日志卡里若含可复用教训（约束、根因、决定与理由）→ **改写成那条教训**，剥掉"发生了什么"的叙述；只有什么都不泛化时才删 | 只有"工作日志一律删" |
| 废话类别补全 | 在原清单上补：进度快照（"当前状态"/"下一步"/还剩什么）、工具输出噪声、消息或轮次计数 | 只列了会话做了什么、逐文件改动清单、commit id、任务总结 |
| 保留清单 | 定下的决定与理由、约束与坑、用户偏好、问题→解法对、指向某处的东西 | 只有"未来会话会照着做才留" |
| 自洽 | 未来会话没看过这次对话也必须能照着做；去掉"本次/上面/如前所述" | 未提 |
| 反捏造 | 合并与改写的正文只能用**被展示的那些卡里出现过**的事实、标识符与数字，缺口不许拿自己的知识补 | 未提（合并与改写此前无内容来源约束） |

**新增：手动触发（设置页的「立即整理」）**

| 位置 | 变更 |
|---|---|
| `curator.ts` `curateNow(slug)` | 一次用户要求的 pass。**绕过**：卡数下限、指纹、冷却、空转退避、后台整理开关（点击本身就是授权）。**保留**：总开关（记忆关掉就没什么可整理）、单飞（已有 pass 在跑就回 `busy`，不排队）、工程边界（一个 slug，不遍历全部 store）、以及全部落盘守卫（pin、未下发与陈旧、引用键上限、删除前归档、台账） |
| `curator.ts` `sweep()` | 加单飞标记：自动与手动共用同一个 curator 实例，谁在跑另一个就不启动（此前自动路径在极端情况下可以两趟重叠） |
| `curator.ts` `curate()` | 返回这一趟做了什么（`PassResult`）：自动 sweep 忽略它，手动触发据此回答用户 |
| `routes.ts` | 新增 `POST /curate`（`{scope:'project', slug}`），复用 `resolveStore` 校验；未知项目、坏 slug、缺 scope 都在任何模型调用之前拒绝 |
| `index.ts` | 手动钩子与保存触发器一样晚绑定：路由先挂载，agents/llm 服务晚到，钩子缺失时回答 `unavailable` 而不是假装成功 |
| `types.ts` | 新增 `MemoryCurateResult`（八种状态 + 四个计数），客户端按状态渲染自己的句子 |
| 客户端 | 项目行新增「整理」按钮（在「删除」之前），进行中显示「整理中…」并禁用；结果按状态提示，并刷新项目列表与整理记录 |

**没做的，以及为什么**

| 项 | 为什么没做 |
|---|---|
| 一次点击同时整理所有项目 | 一个 slug 一次的答案用户能预期（点了哪个项目就看哪个）；全量遍历会把一次点击变成不可预期的模型开销 |
| `split` 操作 | 一张卡覆盖两个无关主题时，现有 rename/merge/rewrite 表达不出拆分（`merge` 到新 key 只是整体改名）。卡有 400 字符上限，这种卡极少，等真实出现再议 |
| 整份计划级拒绝 | 我方是逐条拒绝并记台账（`an unseen rejection does not block other edits in the same pass` 固定了这一语义），比整体拒绝更宽容，也更可观测 |

**版本**：插件 0.9.0 → **0.9.1**（brief 六条）→ **0.9.2**（手动触发）。

**验收证据（执行结果）**

| 命令 | 结果 |
|---|---|
| `cd plugins/plugin-memory && npm run typecheck` | 通过，无输出 |
| `npm test`（插件） | `tests 190 / pass 190 / fail 0`（本轮共新增 7 条：1 条 brief 用例、5 条 `curateNow` 用例、2 条 `/curate` 路由用例） |
| `npm run build`（插件） | `built @dsh-app/plugin-memory: lib/index.js + lib/client.js` |
| 仓库根 `npm run check:graph` | `plugin graph: 17 plugins, followed line ^0.1.6-alpha.2 / ok — no violations` |
| 仓库根 `npm test` | `tests 336 / pass 335 / fail 0 / skipped 1` |
| 客户端产物 | `lib/client.js` 含新词条与 `/curate`；两张词条表的占位符集合一致（临时脚本核验后删除） |

**残余风险**

| 风险 | 说明 |
|---|---|
| brief 变长会挤占 curator 的输出预算 | 新增 6 条只落在 system 半边，不动 `CURATE_MAX_TOKENS`；若实测出现 JSON 截断再调 |
| 「泛化而不是只删」可能被模型当作保卡的借口 | 该条写明"只有什么都不泛化时才删"，且"存疑即删"仍在；真实发生率只能靠台账观察 |
| 反捏造是提示词级约束 | 测试只能固定"这条规则在不在"；能机械拦住的仍只有长度、日期与凭据 |
| 被拒的提案只在台账里可见 | 提示语只报「合并 / 删除 / 改写」三个计数；`refused` 虽随响应回来但未渲染，要看模型的越界提案得打开「最近整理记录」 |
| 手动 pass 期间整段设置页处于 busy | 与既有单飞语义一致（避免删除项目与 pass 交错），代价是这一两分钟内开关也点不动 |
| 客户端渲染没有自动化覆盖 | 本插件没有 DOM/React 测试面：按钮位置、进行中标签、结果后的刷新只有代码审查 + 类型检查 + 路由用例，出片前值得真机点一遍（分别在有会话与无会话时点，验证 `completed` 与 `no-route` 两种提示） |

## 5. 明确不做的事

| 不做 | 理由 |
|---|---|
| 引入 SQLite 状态库 / 租约 / 操作状态机 / 计划哈希 / 孤儿收养 | 这套机制面向"每轮捕获上百个观察、多进程并发编辑"的量级；我们的规模是每作用域几十张卡、单进程单实例，`DESIGN.md` §0 已判定该量级下索引 + 相似度规则足够。引入状态库意味着新依赖、新迁移、新崩溃恢复测试面。**其中两点留用**：内容哈希做身份（A/C 已用）、拒绝而非静默（A/C/D）。 |
| 每轮对话结束调模型做捕获 | 现有 60s 静默窗口 + `MIN_NEW_MESSAGES` + `MIN_NEW_CHARS` 双门控（`distiller.ts:60,146,156`）在"不打断用户"上更优；每轮调用是数据驱动的产品取舍，不是我们的目标。 |
| 只用普通文件工具替代语义化记忆工具 | 那要求模型自己理解目录布局、命名与去重，而且每条写入路径都要自证合规。语义化工具把写入收敛到一条校验过的路径（`memory_save`），并把拒绝理由结构化返回给模型，比让模型直接编辑文件更可控。 |
| 不覆盖 `upsert` 造成的覆盖 | curator 的 `rewrite` 与 merge 对 target 的覆盖走 `upsert`（原地重写，不是删除），归档只在删除前发生。为一次误判的 rewrite 也留副本需要把归档挂到写路径上，代价是每次保存都多一次磁盘写——当前不做，作为本特性的已知边界记录（见 §4.2 残余风险） |
| 向量检索 / embedding | 沿用 `DESIGN.md` §0 的判断：该量级下索引 + 相似度规则足够。 |

## 6. 残余风险

| 风险 | 等级 | 现状与缓解 |
|---|---|---|
| `cursor` 引入的环形序列化顺序与 `list()` 排序解耦后，可能让"最近更新的卡"延迟被审阅 | 中 | 仅截断时启用；未截断（当前全部实测 store）行为不变 |
| 归档目录增长 | 低 | 写入路径上的年龄 + 数量双清理；`clear()` 全清 |
| 台账条目被 FIFO 截断后丢失历史 | 低 | 上限 200 条；关键结论由归档文件本身承载，台账只是索引 |
| per-key 拒绝在极端并发下导致某次 pass 几乎无操作 | 低 | 该 pass 不记录已整理，下轮重试；拒绝计数进台账可观测 |
| 真实卡量（5 / 7 张）远低于所有门控阈值，A/C/D 在真实使用中难以触发 | 中 | 以单测构造触发条件；实施后观察台账中 `unseen` / `stale` 的实际计数 |

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-19 | 初稿。逐条判定表、A–G 方案、回归台账骨架 |
| 2026-09-19 | A + C 实施完成（插件 0.8.4 → 0.8.5），记录见 §4.1。实施中经两轮独立审查，修复了方案未预见的三个问题（偏移量锚点跳卡、零进展烧钱循环、单卡阻塞死循环） |
| 2026-09-19 | B 实施完成，记录见 §4.2。独立审查发现 1 个严重项（`rmSync` 触发仓库删除门禁，已实测复现）与 4 个中等项，全部处置 |
| 2026-09-19 | D 实施完成，记录见 §4.3。独立审查发现 1 个严重项（台账写入放大 + 被拒事件淹没有效记录）与 3 个中等项，全部处置。另由一次真实的测试抖动定位并修复了 `ledgerEntries` 的同毫秒排序缺陷 |
| 2026-09-19 | E 实施完成，记录见 §4.4。独立审查发现 4 个中等项，全部处置：规则从「禁词」改为「禁叙述行为」并加本域例外、覆盖面从 body 扩到 summary、补上第 4 个 prompt 面（`memory_save` 工具描述）、测试从锁字面改为「单一常量 + 名册遍历」 |
| 2026-09-19 | F 实施完成，记录见 §4.5。独立审查发现 4 个中等项与 2 个轻微项，全部处置，其中 **F1 是真实缺陷**：无 model route 的分支会把真实增量静默注销。A–F 全部完成，作为同一未提交改动集共用版本 0.8.5 |
| 2026-09-19 | H 实施完成（不在原方案内，来自复核存量记忆），记录见 §4.6：协议补 `rename`（此前孤立 legacy 卡无法改名）、修复两张违规/含腐烂值的存量卡。同日把版本号从误记的 0.8.6 校正为 **0.8.5**（已发布基线是 0.8.4） |
| 2026-09-19 | I 实施完成（来自用户实际使用反馈），记录见 §4.7：修复归档面板只读全局作用域（B 的遗留缺陷，删了项目记忆后显示「0」）、移除无法操作的台账面板（删除只在「已删除的记忆」出现一次且可恢复）、提示 6 秒自动消失。补跨作用域回归测试 |
| 2026-09-19 | I4 补完（用户追问「怎么永久删除」）：归档此前只有恢复与自动过期，没有「现在就删」的入口。补单条「永久删除」与「清空已删除的记忆」两条路径、两个路由，均走二次确认 |
| 2026-09-21 | J 退役收尾实施完成（插件 0.8.9 → 0.8.10），记录见 §4.8：删除只为退役全局作用域存在的路由/字段与客户端分支，删除 distiller 抽取链路（`src/distiller.ts` 整文件）与 distill 游标/审计状态，删掉主题已消失的 29 条用例（另改写 2 条作用域用例、新增 1 条老状态文件容错用例）。两份文档补 supersede 说明，`docs/ARCHITECTURE.md` 的插件行同步 |
| 2026-09-21 | L 读侧纪律与索引增长策略实施完成（插件 0.8.10 → 0.9.0），记录见 §4.9：索引溢出提示改为可执行的整理指令、guidelines 补「卡片是写入那一刻的快照」的读侧纪律、guidance 类卡补「结论 → 理由 → 边界」形状；新增 3 条用例。版本号约定改为补丁位单位数进位（`0.8.9` → `0.9.0`，不再堆叠 `0.8.10`），规则写入 `plugins/AGENTS.md` §5 与 `docs/agents/build-and-release.md` §3 |
| 2026-09-21 | M 后台整理的任务说明与手动触发实施完成（插件 0.9.0 → 0.9.1 → 0.9.2），记录见 §4.10：curator 的 brief 补六条整理任务（矛盾卡以较新者为准、工作日志里的教训改写而不是只删、废话类别补全、保留清单、自洽、反捏造），并新增**手动触发**——`curateNow()` 跳过程序性门控（卡数下限、指纹、冷却、空转退避、后台开关）但保留全部落盘守卫，`POST /curate` + 设置页项目行的「整理」按钮按状态回报结果，自动与手动共用一个单飞标记。新增 7 条用例（1 条 brief + 5 条 `curateNow` + 2 条路由） |
