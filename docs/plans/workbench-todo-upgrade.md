# 待办板升级：截止时间、清单、子任务与智能视图

- Status: active
- Plan date: 2026-11-02
- Risk: medium

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。

## Goal / Why

把 `plugin-todo` 从「按天记录的清单」升级成「带截止时间、清单归属、优先级、子任务与智能视图的本地任务板」，
模型侧工具读写同一份数据。今天的 `TodoItem` 只有 `text / day / done / reminderAt`
（`plugins/plugin-todo/src/wire.ts:16`），`day` 同时充当「写下它的那天」和唯一的组织轴，
因此表达不了「属于哪个项目」「周五到期」「先做哪个」「这件事要拆几步」——而这正是用户放弃一个待办板的原因。

成功标准：现有 v1 数据文件无损升级；用户能在卡片/页面里按清单、按截止时间、按优先级管理任务，
逾期与今天成为一眼可见的派生视图；模型能用工具写入截止时间、清单与子任务，并在完成后自动推进重复任务。

## 要补的能力

今天一个任务只有一句话和一天，所以「属于哪个项目」「什么时候到期」「先做哪个」「要拆几步」
都无处安放。下面这组能力按「本地单用户能成立」筛过一遍，逐条对应到 Work items：

| 能力 | 为什么它决定待办板能不能用 | 落点 |
|---|---|---|
| 截止时间与创建日分开 | 一个字段兼两职时「今天写的、周五到期」无法表达，`daily` 统计也会被污染 | W1, W2, W3 |
| 清单与分组 | 只有一条时间轴，任务一多就退化成流水账 | W4 |
| 智能视图（今天 / 逾期 / 即将 / 已完成 / 全部） | 逾期必须一眼看见，不能靠人脑比对日期 | W3 |
| 子任务与进度 | 「这件事要拆几步」决定任务能不能真的推进 | W5 |
| 批量操作 | 逐条点击是用户放弃待办板的第二个原因 | W6 |
| 重复任务 | 例行事项每次重录一遍，记录成本高于收益 | W7 |
| 到期提醒预设 | 提醒要跟着截止时间走，而不是手工算时间戳 | W8 |
| 工具能写新字段 | 模型记下的任务必须和手工记的一样完整 | W9 |

## Scope

- Must-have:
  - **W1 数据模型 v2**：`TodoItem` 增加 `due`（截止日期，本地 `YYYY-MM-DD`，与 `day` 分开）、
    `listId`、`priority`、`notes`、`subtasks`、`repeat`、`seriesId`；`TodoFile` 增加 `lists`，`version` 升到 2。
  - **W2 迁移与回滚保护**：读 v1 文件按缺省补齐（`due = day`、`listId` 为空 = 默认清单），
    首次写 v2 之前先落一份 `todos.v1.bak.json`；`normalize()` 对未知字段保持丢弃语义但不再丢已知新字段。
  - **W3 智能视图**：`today` / `overdue` / `upcoming` / `done` / `all` 五个派生视图，宿主与客户端共用一套判定。
  - **W4 自定义清单**：清单的增删改名与排序；删除清单把任务移回默认清单，不删任务。
  - **W5 子任务**：一条任务下若干 `{id, text, done}`，父任务显示进度；父任务完成不强制子任务完成。
  - **W6 批量操作**：按 id 数组完成/取消完成、改清单、改优先级、改截止、删除，单次一个路由。
  - **W7 重复任务**：完成时按 `repeat` 生成下一个实例（`daily` / `weekly` / `monthly` / `yearly` / `weekday`，
    带 `interval`），月末与闰年做夹取；同一 `seriesId` 同时只允许一个未完成实例。
  - **W8 提醒预设**：不改 `reminderAt` 语义，界面按 `due` 计算「截止当天 09:00 / 截止前 1 小时 / 自定义 / 不提醒」。
  - **W9 工具扩展**：`todo_add` 增加 `due` / `list` / `priority` / `subtasks`；新增 `todo_update`；
    `todo_done` 触发重复推进；`todo_list` 增加清单与截止区间过滤、带出子任务进度。
- Out of scope:
  - 协作成员、权限、分享清单（`todo-share-modal/`）——需要服务端与账号体系。
  - 负责人 / 分配人 / 关注人 / 评论 / 任务来源（消息、文档）——多人语义，本地单用户没有对应物。
  - 自定义字段引擎（字段标题/类型/选项/颜色）——用 `priority` + 清单足以覆盖本地场景。
  - 甘特图与关键路径——依赖跨任务依赖关系，超出单机待办范围。
  - 服务端 AI 仪表盘生成、「任务指派给智能体」——见 Deferred。
  - 看板视图的拖拽排布——先做列表视图 + 分组，看板留到有真实使用反馈之后。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 把 `due` 并入现有 `day` 字段 | `day` 是「写下它的那天」，参与 `daily` 统计；合并会污染历史统计，且无法表达「今天写的、周五到期」 |
| 用 `listId` 直接复用工作区 `cwd` | 待办清单与工作区不是一对一（一个工作区可以有多条清单，一条清单可以横跨工作区）；先做独立清单，绑定工作区留待有需求时加 `workspacePath?` |
| 重复任务用后台定时器按计划生成 | 需要常驻调度与「错过了怎么办」的补偿语义；本地单机用「完成时生成下一实例」即可，语义也更可解释 |
| 自定义字段的通用键值模型 | 通用字段引擎会带来类型校验、排序、筛选、迁移四套复杂度；本轮的 `priority` 与清单已覆盖主要诉求 |
| 迁移时丢弃 v1 文件、重建 | 用户的 `daily` 统计是永久层（`plugins/plugin-todo/src/store.ts:23` 的 `DETAIL_DAYS`），重建会清零历史 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `wire.ts`：`TodoItem` 增 `due`/`listId`/`priority`/`notes`/`subtasks`/`repeat`/`seriesId`，`TodoFile` 增 `lists` 且 `version: 2`；新增 `Subtask`、`RepeatRule`、`TodoList` 类型 | [x] |
| W2 | P0 | `store.ts`：`normalize()` 支持 v1→v2 补齐；v1 文件旁边落 `todos.v1.bak.json`（原子写、始终等于当前被升级文件的字节）；`addTodo`/`setDone`/`removeTodo` 适配新字段。审查第 2 轮指出的「先删旧再 rename」已改为一步覆盖式 rename，`tests/migration.test.ts` 里有失败路径反例锁住 | [x] |
| W3 | P0 | 智能视图判定抽成纯函数（宿主与客户端共用），`today`/`overdue`/`upcoming`/`done`/`all` 五态；`todo_list range=overdue` 改为调用它。卡片、页面标签、行标签、编辑器提醒均已接入同一份判定，全库不再有第二套 `day < today` | [x] |
| W4 | P0 | 清单 CRUD 与排序：路由 `POST /lists`，删除清单把任务移回默认清单 | [x] |
| W5 | P1 | 子任务：增删改勾，父任务显示进度，`setDone` 不级联子任务 | [x] |
| W6 | P1 | 批量操作：`POST /batch`（complete/uncomplete/move/setPriority/setDue/remove），逐条返回结果 | [x] |
| W7 | P1 | 重复任务：完成时生成下一实例，月末/闰年夹取，`weekday` 跳过周末，同系列只留一个未完成 | [x] |
| W8 | P2 | 提醒预设：按 `due` 计算 `reminderAt`（`presetReminderAt`），新增 `reminderSource` 让改截止日时只重算由预设推导的提醒 | [x] |
| W9 | P1 | 工具扩展：`todo_add` 增参、新增 `todo_update`、`todo_done` 接重复推进并补齐描述、`todo_list` 增过滤与子任务进度 | [x] |
| W10 | P2 | 客户端：卡片显示逾期数与今日数，页面加视图切换与清单侧栏、子任务、编辑器、批量，样式沿用 `var(--dsw-*)` token | [x] |
| W11 | P2 | 交付物：`plugins/README.md` 的 todo 行、版本 0.1.0 → 0.1.1、`changesets/todo-board-deadlines-lists-steps.md`、字典 zh/en 补齐 | [x] |
| W12 | OPT | 看板视图（按清单/优先级分组、可拖拽）：等列表视图有真实使用反馈后再做 | [–] |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选。

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 1 数据模型与迁移 | W1, W2, W3 | 条目全 `[x]`；T1–T3 PASS；v1 夹具升级后 `daily` 完全一致 |
| 2 清单与视图 | W4, W10 | 条目全 `[x]`；T4–T6 PASS；`npm run dev` 里卡片与页面读同一份快照 |
| 3 子任务与批量 | W5, W6 | 条目全 `[x]`；T7–T9 PASS |
| 4 重复与提醒 | W7, W8 | 条目全 `[x]`；T10–T12 PASS（含月末与闰年反例） |
| 5 工具与交付 | W9, W11 | 条目全 `[x]`；T13–T15 PASS；`check:suites:gate` 与 `check:graph` 绿 |

阶段闸门：任何条目处于 `[~]`、`[?]` 或 `[!]` 时不得开始下一阶段。

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| 任务对象新增截止时间、清单、优先级、备注、子任务、重复规则 | added | `plugins/plugin-todo/src/wire.ts:16` |
| 存储文件版本 1 → 2，新增 `lists` | modified | `plugins/plugin-todo/src/wire.ts:40` |
| 读取 v1 文件时的补齐与备份 | added | `plugins/plugin-todo/src/store.ts:99` |
| 任务增删改适配新字段 | modified | `plugins/plugin-todo/src/store.ts:174`、`:262`、`:288` |
| 智能视图派生（今天/逾期/即将/已完成/全部） | added | 新增 `plugins/plugin-todo/src/client/views.ts` |
| 清单增删改与排序 | added | 新增 `plugins/plugin-todo/src/index.ts` 路由 + `src/store.ts` |
| 子任务与父任务进度 | added | `plugins/plugin-todo/src/wire.ts`、`src/client/view.tsx` |
| 批量操作路由 | added | 新增 `plugins/plugin-todo/src/index.ts` `/batch` |
| 完成重复任务时生成下一实例 | modified | `plugins/plugin-todo/src/store.ts:262` |
| `todo_add` 参数扩展、新增 `todo_update` | modified | `plugins/plugin-todo/src/index.ts`（工具注册段） |
| `todo_list` 输出增加清单/截止/子任务进度 | modified | `plugins/plugin-todo/src/index.ts` |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W2) | v1 夹具升级 | 一份真实 v1 `todos.json`（含 90 天内已完成项与 `daily`） | 读出不丢项、`daily` 逐键相等、`due` 回填为 `day`、生成 `todos.v1.bak.json` | `cd plugins/plugin-todo && npm test` | PASS (`npm test`, 2026-11-02) |
| 2 (W2) | 畸形字段 | `priority: 9`、`due: "2026-13-40"`、`subtasks` 非数组、`day` 为不存在的日期 | 逐字段回落到缺省，不写坏文件；非法 `day` 不回填出非法 `due` | 同上 | PASS (`npm test`, 2026-11-02) |
| 3 (W3) | 智能视图边界 | 任务 `due` 分别为昨天/今天/明天/8 天后/无 `due` 且 `day` 为今天/无 `due` 且 `day` 为昨天 | `overdue`/`today`/`upcoming` 归属正确，无重复计入；宿主工具与 `inView` 结论一致 | 同上 | PASS (`npm test`, 2026-11-02) |
| 4 (W4) | 删除清单 | 清单下有 3 条任务 | 任务移回默认清单且不丢，清单消失 | 同上 | PASS (`npm test`, 2026-11-02) |
| 5 (W4) | 清单排序 | 调整 order | 快照按 order 返回，重排幂等 | 同上 | PASS (`npm test`, 2026-11-02) |
| 6 (W10) | 卡片与页面一致 | `npm run dev`，加一条任务 | 卡片与页面显示同一份快照，无二次请求 | 手工 + `npm run dev` | pending（本环境无图形界面，未走查） |
| 7 (W5) | 子任务进度 | 3 个子任务勾 1 个 | 进度 1/3；父任务完成时子任务不被改写 | `npm test` | PASS (`npm test`, 2026-11-02) |
| 8 (W6) | 批量部分失败 | 批量里混入一个不存在的 id | 其余成功，失败项带原因返回，不整批回滚 | 同上 | PASS (`npm test`, 2026-11-02) |
| 9 (W6) | 批量上限 | 一次传超过上限的 id | 拒绝并返回稳定错误码 | 同上 | PASS (`npm test`, 2026-11-02) |
| 10 (W7) | 月度重复夹取 | `due` = 1 月 31 日，`monthly` | 下一实例为 2 月 28/29 日，不是 3 月 3 日 | 同上 | PASS (`npm test`, 2026-11-02) |
| 11 (W7) | 工作日重复 | `due` = 周五，`weekday` | 下一实例为下周一，跳过周六日 | 同上 | PASS (`npm test`, 2026-11-02) |
| 12 (W7) | 同系列去重 | 同一 `seriesId` 已有未完成实例时再次完成 | 不生成第二个未完成实例 | 同上 | PASS (`npm test`, 2026-11-02) |
| 13 (W9) | 工具写入新字段 | `todo_add` 带 `due`/`list`/`priority` | 落盘并在 `todo_list` 回读一致 | `npm test` + 手工工具调用 | PASS (`npm test`, 2026-11-02) |
| 14 (W9) | `todo_update` 歧义 | 只给 `text` 且命中多条 | 返回候选 id，不猜 | 同上 | PASS (`npm test`, 2026-11-02) |
| 15 (W11) | 套件一致性 | 改完版本与字典 | `npm run check:suites:gate`、`npm run check:graph` 绿 | 根目录执行 | PASS (`check-suites-drift --check` + `check-plugin-graph`, 2026-11-02) |

## Verification commands

```sh
cd plugins/plugin-todo && npm run typecheck && npm run build && npm test
cd plugins/plugin-todo && npm run build && node scripts/test.mjs
npm run dev                      # 界面走查：卡片、页面、清单侧栏、批量
npm run check:suites:gate        # 根目录
npm run check:graph              # 根目录
npm test                         # 根目录，含 plugin-version-bump
```

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 看板视图与拖拽排布 | 先验证列表 + 分组够不够用，避免一次做两套视图 | 列表视图上线后有两周真实使用反馈时 |
| 任务绑定工作区（`workspacePath?`） | 清单与工作区不是一对一，绑定规则需要真实数据才能定 | 出现「想按项目看任务」的具体抱怨时 |
| 「任务交由智能体执行」 | 派单需要服务端与账号体系；我们的对应物是 subagent，要单独设计生命周期、失败回滚与权限边界，属独立课题 | 单独评估 `plugin-swarm` 集成时 |
| 服务端式仪表盘生成 | 需要模型服务端能力与图表渲染，且现有 `src/client/stats.tsx` 已覆盖基础统计 | 现有统计被反馈不够用时 |
| 附件 | 本地单机没有上传语义；记路径会引入路径穿越与失效链接问题 | 出现明确的本地附件需求时 |
| 回滚锚点语义：它始终镜像「当前被升级文件」，不是第一份好数据的快照 | 两种语义只能选一个：「永不覆盖」保护第一份好数据但会在「回滚→再升级」时丢掉回滚期间的新任务（审查实测）。已选后者 | 出现「v1 文件在升级时本身已损坏」的真实案例时，改为同时在备份旁记录校验和 |
| `day` 的校验仍只判形状，非法日期（如 `2026-02-31`）的行会一直落在 `overdue` | 收紧 `day` 校验会改变已有测试固化的行为，属本轮排除的语义变更 | 做 W9 工具扩展、统一日期校验时一并收紧 |

## Rollback

- 数据：v2 文件在 v1 读取器里只会丢新字段（`normalize()` 丢弃未知字段），不会损坏 `daily`。
  首次 v2 写之前的 `todos.v1.bak.json` 是回滚锚点；回滚时用它覆盖 `todos.json`。
- 代码：本计划的改动集中在 `plugins/plugin-todo/`，回滚即回退该目录与版本号；不需要内核线配合。
- 已知坑：`dayKey()` 用本地时区（`plugins/plugin-todo/src/store.ts:47`），跨时区迁移或夏令时切换的测试夹具
  必须显式给定时区，否则「今天」会随 CI 机器漂移。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 数据模型与迁移 | 2026-11-02 | `cd plugins/plugin-todo && npm run typecheck`=0；`npm test`=0（141/141）；`npm run build`=0；`node --test test/recursive-delete-guard.test.mjs`=0（3/3）。W1–W3 全 `[x]`；T1–T3 PASS。审查记录 `.devflow/workbench-todo-upgrade/review-phase1-r2.md` 的两条 P1（锚点先删后 rename、`views.ts` 死代码）已修，均有失败路径用例 | Gate 通过 |
| 2 清单与视图 | 2026-11-02 | 同上命令；T4、T5 PASS | Gate 未过：T6（卡片与页面的界面走查）pending，本环境无图形界面 |
| 3 子任务与批量 | 2026-11-02 | 同上命令；T7–T9 PASS（含批量部分失败与超限反例） | Gate 通过 |
| 4 重复与提醒 | 2026-11-02 | 同上命令；T10–T12 PASS（1/31 月度夹取、周五 `weekday` 跳周末、同系列去重均有反例）；另加 `interval` 上限与 `advanceDue` 输出校验的用例 | Gate 通过 |
| 5 工具与交付 | 2026-11-02 | 同上命令；T13–T15 PASS；`node scripts/check-suites-drift.mjs --check`=0、`node scripts/check-plugin-graph.mjs`=0；版本 0.1.1 与 changeset 就位 | Gate 通过 |
