# plugin-memory 主题卡化改造设计（L1–L4）

> 状态：Phase 1–2 已实现（2026-09-15），待实测 · Phase 3（L4）观望
> 范围：`plugins/plugin-memory` 全量（store / tools / prompt / distiller / curator / routes / client）
> 目标读者：本仓库维护者；实施前请先读 §0 根因与 §7 迁移
> 加固与可恢复性改造另见同目录 [`OPTIMIZATION.md`](OPTIMIZATION.md)（含回归台账）

## 0. 背景：为什么现在是流水账

当前每个作用域（global / 每 project）只有**一个 append-only 的 `memory.md`**，条目形态为
`- [category] YYYY-MM-DD content`（`src/memory-store.ts:245-256`）。两条写入路径
（`memory_save` 工具、后台 distiller）的 prompt 都已明令禁止工作日志，但流水账仍然累积，
根因是结构性的，不是 prompt 力度不够：

1. **存储模型本身就是时间线**。条目自带日期前缀、按追加顺序排列，没有主题归并、没有
   update 语义——纠错只能 `memory_forget` + `memory_save` 两步走，近重复去重为零
   （仅精确内容匹配，`src/memory-store.ts:309-316`）。日期前缀出现在正文里，物理上就
   在邀请"某月某日发生了某事"的写法。
2. **写快清慢**。distiller 每轮对话后 60s 静默即可追加最多 5 条
   （`src/distiller.ts:44,126`）；curator 要同时满足"≥8 条 + hash 变化 + 10 分钟冷却 +
   触发会话存活"才运行（`src/curator.ts:53,59,289-303`）。绝大多数条目终生未被整理。
   `stripCommitIds`、`repairDoublePrefix` 这类事后补丁的存在本身证明违规落盘是常态。
3. **写入时全局可见性差**。注入有预算截断（global 1200 / project 2800 字符，
   `src/prompt.ts:26-29`），模型写入前只能看到配额选出的一小撮近期条目，与旧条目撞车
   时双方互相看不见。

**非目标**：不上向量检索 / embedding。条目量级为每作用域几十条、注入预算 2800 字符，
索引 + 相似度规则足够，embedding 是该规模下的过度设计。

## 1. 总体方案

范式转移：**从"每作用域一条时间线"改为"每主题一张卡 + 一行索引 + upsert"**，对齐本
harness 自带的记忆系统形态（每主题一文件 + MEMORY.md 一行索引 + 同主题覆盖更新）。

| 层 | 内容 | 状态 |
|---|---|---|
| L1 主题卡化 | 存储模型、upsert、索引、注入渲染、迁移 | 本期核心 |
| L2 写入时合并 | 近重复检测（跨卡）、save/distill 写入路由 | 本期 |
| L3 curator 常态化 | 轻量 sweep（无 LLM，每次写入后）+ 重量 sweep（卡操作化改造） | 本期 |
| L4 召回结构化 | 注入只放索引、正文按需 recall | **观望**，触发条件见 §8 |

三道防冗余闸（对应主题卡模型的新失败模式"主题边界重叠"）：

1. **写入路由**：save 强制 topic 键；宿主对全部卡做相似度检测，命中即拒绝并指向既有卡。
2. **hook 质量规范**：`summary` 为必填且 ≤40 字符，索引行必须足以让写入方判断覆盖范围。
3. **curator reindex**：轻量 sweep 每次写入后重建索引、标记孤儿卡与高重叠卡对。

## 2. L1 存储模型

### 2.1 目录布局

```
<root>/                                      # $DSH_HOME/storages/dsh-app-plugin-memory
├── index.md                                 # 全局索引（宿主重建，勿手改）
├── topics/<topic-key>.md                    # 全局主题卡
├── memory.legacy.md                         # 迁移后保留的旧文件（不删，只读归档）
├── config.json                              # enabled / distill / pinned(按 topic 键) / storeVersion
├── distill-state.json                       # 不变
├── llm-audit.json                           # 不变
└── projects/<slug>/
    ├── index.md
    ├── topics/<topic-key>.md
    ├── memory.legacy.md
    └── project.json                         # 不变
```

### 2.2 主题卡格式

```markdown
---
name: pnpm11-allowscripts
category: lesson
summary: pnpm 11 构建白名单必须写进 pnpm-workspace.yaml
created: 2026-09-06
updated: 2026-09-12
---

正文，1–3 行，≤400 字符，用户语言。可用 [[other-topic]] 互链。
```

字段约束（宿主校验，不合法即拒绝并给出原因）：

- `name`（topic 键）：ASCII kebab-case，`^[a-z0-9][a-z0-9-]{0,47}$`，即文件名。模型给中文
  主题时由 save 工具描述要求自行翻译为英文键。
- `category`：沿用现有五分类 `preference | convention | decision | lesson | fact`
  （`src/types.ts:10`），不扩。
- `summary`：≤40 字符，创建时必填、更新时可选；它是索引行和写入路由的判据。
- 正文：`MAX_TOPIC_BODY_CHARS = 400`（约两条旧条目；curator 现行 merge 上限
  prompt 写 500 而代码强制 200（`src/curator.ts:141` vs `src/curator.ts:437`），本次
  统一为 400，顺带修掉这处不一致）。
- 日期只存在于 frontmatter（`created` / `updated`），**正文不再出现日期前缀**——从物理
  上消除日志感。`stripEntryPrefix` / `repairDoublePrefix` 随之退役（仅迁移期使用），
  `stripCommitIds` 保留。

### 2.3 写入语义：upsert

`memory_save` 新 schema：

| 参数 | 必填 | 说明 |
|---|---|---|
| `topic` | 是 | 主题键（kebab-case）。同键 = 同一事实的演进，覆盖更新 |
| `category` | 是 | 不变 |
| `summary` | 创建时必填 | ≤40 字符索引钩子；更新时可省略（沿用旧的） |
| `content` | 是 | 正文，≤400 字符 |
| `scope` | 否 | 不变（project 默认 / global） |

行为：

- 键不存在 → 创建卡，返回 `{saved: true, op: 'created'}`。
- 键存在 → **覆盖正文**、bump `updated`、保留 `created` 与 pin 状态，返回
  `{saved: true, op: 'updated'}`。纠错从"forget + save 两步"变为"同键再 save 一次"，
  GUIDELINES 相应改写（`src/prompt.ts:52-54` 的 CORRECT 段）。
- 键合法化：宿主做 slugify + 截断兜底，减少模型重试。
- 现有防护全部保留并移到卡粒度：凭据过滤（`containsCredential`）、长度上限、
  作用域由宿主按 cwd 决定（`src/tools.ts:124-131` 的纪律不变）。

Pin 从"归一化内容键"（`src/memory-store.ts:376-379`，内容一改就失配）改为**按 topic 键**
存于 `config.json.pinned`，天然 survives 内容更新。`dropPinsFor` 的清理逻辑简化为
"卡删除时删键"。

### 2.4 索引（index.md）

- 每作用域一份，**宿主从卡 frontmatter 重建**，格式一行一卡：
  `- [category] topic-key — summary`。
- 任何写卡/删卡/迁移操作后同步重建（轻量 sweep 的一部分，见 §4）；手改卡文件后
  下一次写入也会扶正索引。
- 索引是当前注入与未来 L4 召回的共用底座。

### 2.5 注入渲染（prompt.ts）

L1 阶段保留"正文注入"，渲染源从时间线改为卡集：

1. 注入索引全文（30 卡 ≈ 30 行，约几百字符，恒在）——写入方的全域地图，这是写入
   可见性的根本改善。
2. 卡正文选择策略平移现有规则：pinned 优先 → 每 category 配额内按 `updated` 新→旧
   （替代"文件尾部=最新"这一随时间线消亡的启发式，`src/prompt.ts:86-93`）→ 预算
   global 1200 / project 2800 字符不变。
3. 手改的 malformed 卡（缺 frontmatter）按现"非标准行"待遇：原文注入、跳过校验
   （`src/prompt.ts:110-113` 的 handNotes 语义平移）。

### 2.6 distiller 提案 schema

提案从 `{category, content}` 扩为 `{topic, summary, category, content}`
（`src/distiller.ts:128-133`）：

- 宿主校验键格式；`resolveScope` 的宿主定址纪律不变（`src/distiller.ts:144-146`）。
- 提案命中既有键 → 进入 L2 的更新门控（§3）；未命中 → 创建。
- prompt 输入从"两个文件全文"改为"索引 + 卡正文（截断 12000 字符规则不变，
  `src/distiller.ts:49-64`）"，"Skip anything already covered"规则因索引可见而更可执行。
- 空 entries 合法、MAX_DISTILL_ENTRIES=5、MIN_NEW_MESSAGES/CHARS 门控全部不变。

### 2.7 recall / forget

- `memory_recall(scope, query?, topic?)`：新增 `topic` 精确读单卡（L4 的按需展开原语，
  本期即提供）；`query` 匹配范围扩为键 + summary + 正文；无参返回索引 + 全部卡
  （50k 字符上限不变，`src/tools.ts:32`）。
- `memory_forget`：语义改为**删除**，`match` 先按 topic 键精确命中，退化为内容子串
  （现规则）；返回删除的卡键列表。纠错不再走 forget（见 §2.3）。

## 3. L2 写入时合并（防冗余闸一）

纯宿主侧规则检测，不新增 LLM 调用：

- **相似度**：对 `normalizeForMatch` 后的文本取字符 bigram 的 Jaccard 系数。
  （阈值 τ 为 L3 推断，需实测标定：起始 τ_dup=0.8、τ_rel=0.6，候选对记入
  distill-state 供调参，见 §9。）
- **save 路由**：
  1. topic 键精确命中 → upsert；
  2. 新键但内容与某卡 ≥τ_dup → 拒绝并返回 `{saved:false, reason:'duplicate-of', topic}`，
     引导模型改为 upsert 该键；
  3. [τ_rel, τ_dup) 区间 → 放行创建，响应带 `related: [keys]`，提示模型考虑合并或
     正文加 `[[link]]`。
- **distill 更新门控**（防震荡）：提案命中既有键时，相似度 ≥τ_dup 跳过（复读），
  <τ_dup 才接受为更新（确含新信息）。同一次运行内已接受的卡立即进入比对集
  （沿用 `src/distiller.ts:474-477` 的 seen 集语义）。
- LLM 仲裁（对 τ 区间内的候选对再问一次模型）**不在本期**——先观测规则检测的
  准确率，误判集中再升级。

## 4. L3 curator 常态化

### 4.1 轻量 sweep（新增，无 LLM，每次写入后必跑）

- 重建受影响作用域的索引（闸三）。
- 检测跨卡精确重复（手改卡可能引入）→ 直接合并，保留 `updated` 较新者。
- 计算并记录 ≥τ_dup 的高重叠卡对到 distill-state（供重量 sweep 优先处理 + §9 调参）。
- 校验 summary 非空、卡 frontmatter 完整；问题卡记入状态页。
- 零模型成本，无冷却、无门槛——纠正"写快清慢"的频率失配。

### 4.2 重量 sweep（现有 curator 的卡操作化改造）

- **编辑协议从"逐字引用行"改为"引用 topic 键"**：`{op:'merge', topics:[k1,k2], target:{topic,summary,category,content}}`、`{op:'delete', topics:[k]}`、
  `{op:'rewrite', topic:k, content}`。宿主按键解析，现 `applyEdits` 的"引用行必须逐字
  存在"脆弱性（`src/curator.ts:406-417`）整体消失。
- 门控保留：10 分钟冷却、hash 变化检测、≥8 卡才处理——但计量从"行数"改为"卡数"，
  作用域预算改为 ≤30 卡 / ≤6000 字符（`src/curator.ts:77-80` 平移）。
- 新增 **restructure 模式**：对刚迁移的作用域（`restructured` 标记未置位）跑一次
  "把 legacy-* 卡归并成正常主题卡"的专门 prompt，完成后置标记。
- 输入为索引 + 卡正文（40k 截断规则平移）；pinned 卡不可编辑的纪律平移到键粒度。

## 5. 设置页与 API（routes / client / types）

- 条目列表 → 卡列表：每行显示 topic 键、category、summary、updated、pin 开关、删除；
  pin/删除均按键（`POST /pin`、`POST /forget` 的 body 从 content 改为 topic）。
- `MemoryStatus.globalList` / `MemoryEntriesResponse` 的 `{text, pinned}` 改为
  `{topic, category, summary, updated, pinned}`（`src/types.ts:50-53,75`）。
- 保留并改为"打开存储目录"的手改入口（原 filePath 展示语意升级为 topics 目录）。
- 条目统计 → 卡数 + 总字节；迁移状态（legacy 未迁移 / 待 restructure）在状态页可见。

## 6. 迁移（存量时间线 → 主题卡）

原则：**确定性迁移优先，LLM 归并后置**；不删任何用户数据。

1. **boot 时确定性转换**（无模型依赖，`config.json.storeVersion` 1→2）：
   旧 `memory.md` 每条目转为一张卡：`name: legacy-<contentHash8>`、`summary` = 内容前
   30 字符、`category` 沿用、`created` = 条目日期；旧文件改名 `memory.legacy.md` 保留。
   pin 按内容匹配映射到新卡键，失配的丢弃并记日志。
2. **首次重量 sweep 跑 restructure 模式**（§4.2），把 legacy-* 卡归并、重命名为正常
   主题键；完成前索引/注入照常工作（卡就是卡，只是键丑）。
3. 迁移期间新旧双读不做：转换是即时的，boot 完成后只存在新布局。

回滚：legacy 文件仍在；插件版本按套件纪律 bump（suiteVersion 只由插件版本号派生，
代码修复不 bump 投递不到）。

## 7. 兼容性影响

| 面 | 影响 | 处理 |
|---|---|---|
| 工具 schema | `memory_save` 新增必填 `topic`/`summary` | 工具描述每会话新鲜下发，无跨会话兼容问题；GUIDELINES 同步改写 |
| prompt 注入 | 格式从时间线变索引+卡 | 同会话内下一轮即生效 |
| config.json | pinned 改键控；新增 storeVersion | 迁移一次性处理，缺字段默认现行为 |
| 磁盘文件 | 新增 topics/、index.md；legacy 保留 | 用户手改入口改为目录 |
| 后台 pass | distill/curator prompt 与校验重写 | 审计、trace 格式不变 |
| 客户端 | 卡列表 UI | 随本期交付 |

## 8. 实施分期与验收

**Phase 1（L1 + L3 轻量 sweep）**
- store 卡 CRUD + 索引重建 + 键控 pin；tools upsert；注入渲染；boot 确定性迁移；
  设置页卡列表。
- 验收：单测覆盖 upsert/索引/迁移/pin 映射；迁移固件测试（条目数守恒、pin 守恒）；
  probe 实测"同键 save 两次 → 单卡更新"；设置页 pin/删除按键生效。

**Phase 2（L2 + L3 重量 sweep）**
- 相似度门接入 save/distill；curator 卡操作协议 + restructure 模式。
- 验收：近重复 save 被拒并指向既有键；distill 对既有键的更新/跳过门控用例；
  curator merge-by-keys 用例；legacy 卡 restructure 端到端固件。

**Phase 3（L4 评估，不默认实施）**
- 触发条件（满足任一即立项）：单作用域卡数持续 >40；注入预算长期吃满且 recall
  调用率低；用户反馈注入噪音。
- 内容：注入只放索引，正文一律 `memory_recall(topic=...)` 按需展开。

## 9. 风险与残余

| 风险 | 等级 | 缓解 |
|---|---|---|
| 相似度阈值误判（误拒/漏拦） | L3 推断 | 起始保守（τ_dup=0.8）；轻量 sweep 落全部候选对日志，跑两周真实数据后标定；必要时升级 LLM 仲裁 |
| 模型产出非法 topic 键导致保存失败循环 | L2 | 宿主 slugify 兜底 + 错误信息给出合法示例；GUIDELINES 给键命名示例 |
| 迁移丢 pin / 条目 | 可单测覆盖 | 固件测试断言条目数与 pin 守恒；legacy 文件保留 |
| distiller 对既有键的更新震荡（A→A'→A） | L3 推断 | τ_dup 门控 + updated 仅在内容实变时 bump；审计观察 rewrite 频率 |
| 索引与卡不一致（手改后） | 低 | 轻量 sweep 每次写入重建；malformed 卡降级为原文注入 |

## 10. 关键决策摘要（评审用）

1. 每主题一文件（md + frontmatter），不用 JSON 大文件——保留手改性与 greppable，
   对齐 harness 已验证范式。
2. upsert 以 topic 键为 identity；纠错 = 同键重写，不是 forget+save。
3. 日期从正文退到 frontmatter，物理消除日志形态。
4. L2 用规则相似度（bigram Jaccard），本期不引入 LLM 仲裁与 embedding。
5. 迁移 = 确定性 entry→card + curator restructure 后置，不依赖 boot 期有模型路由。
6. L4（纯索引注入）观望，设量化触发条件。
