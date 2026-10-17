# rewind 对齐 kimi-code undo：压缩边界、availability、参与者注册表

- Status: draft
- Plan date: 2026-10-17
- 前置：内核线 0.2.1-rc.1 的升级与 Office/模型页收敛先落地（`docs/kernel-0.2.1-rc.1-upgrade.md` §7）

## Goal

把 kimi-code `agent-core-v2` 的 undo 里**可移植的三件事**补进 `plugin-rewind`：
压缩边界处的显式停点与稳定原因码、撤回上限语义、参与者注册表。
存储模型不移植——kimi-code 走 `wire.switchBranch`，DSH 的日志只追加，我们的 `surfaceOp` 替换
（`session.append('user/message', …, { surfaceOp })`）就是它在 DSH 里的对应物。

## Scope

- Must-have:
  - **W1 压缩边界**：撤回点截止到最新一个压缩检查点之后；越界请求给稳定原因码，不再静默少点。
  - **W2 availability**：宿主算出 `{ maxTurns, stoppedAtCompaction }`，`/rewind` 的选择器与命令共用同一份。
  - **W3 参与者注册表**：rewind 提供一个 service，其他套件插件注册 `reconcileAfterUndo()`，撤回后各自还原；
    rewind 自己的文件回退成为第一个参与者。
- Out of scope:
  - kimi-code 的分支切换 / 状态重放存储模型（与 DSH 追加日志冲突）；
  - 它的 `BugIndicatingError` / DI 基建；
  - 跨压缩自动重建上下文；
  - 给其他插件补撤回语义（只提供接缝，不替它们实现）。

## Approach

kimi-code 的三个参照点（`packages/agent-core-v2/src/agent/`）：

| 它的做法 | 位置 | 我们在 DSH 的对应实现 |
|---|---|---|
| `computeUndoCut` 从尾部往前扫，遇 `compaction_summary` 停并带出 `stoppedAtCompaction` | `contextMemory/contextOps.ts:249` | DSH 的检查点是**一条 `user/message`，其 `source.kind === 'compact-checkpoint'`**（`@deepseek-ai/dsh-compaction` 的 `checkpoint.ts:19-25`）。我们的 `listAnchors` 已经遍历 `surface.nodes`（`src/cut.ts:157`），边界前的点天然不出现；缺的是**说出来**：找到最新的 checkpoint 序号，作为边界返回给调用方 |
| `precheckUndo` 返回 `'empty' \| 'compaction_boundary' \| 'insufficient'` | `contextOps.ts:280` | 同样的三态，落成我们自己的稳定码 `rewind.reason.{empty,compactionBoundary,insufficient}`，走 `HostText` 由客户端字典出文案 |
| `availability(): { maxTurns, stoppedAtCompaction }` | `undo/undoService.ts:104` | 宿主算一份，命令结果与 picker 的注入面共用（`/rewind` 裸调用与 `/rewind n` 都读它） |
| `AgentConversationUndoParticipantRegistry` + `reconcileAfterUndo()` + `phase: 'after-flush'` | `contextMemory/conversationUndoParticipants.ts` | Cordis 的 `ctx.provide(name, value)`（`cordis/lib/types/reflect.d.ts:41`）提供 `dsh-app-rewind-participants`；消费方在自己的 `inject` 里声明它。注册返回 disposer，重复 id 抛错，与它一致 |

关键取舍：

1. **序号不变**：W1 只增加“边界原因”，不改变 anchors 列表本身（现状已经是 surface 遍历，边界前的点不在列表里）。
   因此 `/rewind <n>` 的历史语义不变，不需要版本化。
2. **参与者跑在写日志之后**：撤回的日志写入是权威动作，参与者是事后对账；某个参与者失败只记日志，
   不回滚撤回，也不阻断其他参与者——这与现有“文件回退失败降级为报告”一致。
3. **注册表是 opt-in 服务**：没有消费者时行为与今天完全一致；rewind 自己的文件回退先迁进去，
   用来证明接缝可用，而不是先改别人的插件。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P1 | 宿主：`cut.ts` 新增 `compactionBoundary(session)`（最新 `source.kind === 'compact-checkpoint'` 的 surface 序号）与 `availability(session)`；`index.ts` 的 `/rewind`、`/rewind plan` 用它判定越界并返回稳定码 | [ ] |
| W2 | P1 | 客户端：picker 在边界处显示一行说明（复用插件字典），命令结果按码出文案；`rewindView` 与 `listAnchors` 的等价性测试同步扩一条 | [ ] |
| W3 | P1 | 宿主：`provide('dsh-app-rewind-participants', registry)`，注册/注销/`reconcileAfterUndo()`，失败隔离与日志 | [ ] |
| W4 | P2 | 把现有的文件回退（`revertFiles`）注册成第一个 participant；撤回流程改为“写日志 → 跑参与者 → 汇总报告” | [ ] |
| W5 | P2 | 文档与交付：`plugins/README.md` 的 rewind 行、`docs/plans/rewind-undo-parity.md` 状态、版本 bump、`changesets/` 片段 | [ ] |
| W6 | OPT | 参与者 `phase: 'after-flush'`：只有当出现“必须在刷新之后跑”的消费者时才加 | [–] |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1, W2 | 边界用例 + availability 用例 PASS，插件 `tsc`/`build`/`npm test` 全绿 | [ ] |
| 2 | W3, W4 | 参与者用例 PASS，rewind 全量测试零回归 | [ ] |
| 3 | W5 | 根套件全绿，产物重建后 `verify --tgz` 通过 | [ ] |

## Affected behaviors

- `/rewind` 与 `/rewind <n>`：列表内容不变；越界时从“静默拒绝/少点”变为固定原因码。
- `/rewind plan <n>`：多返回 `stoppedAtCompaction` 与边界序号，客户端确认框据此显示一句边界说明。
- 撤回执行路径：写日志之后新增参与者对账；文件回退从“内联调用”变成“第一个参与者”。
- `src/projection.ts` 的 `rewindView` 与 `src/cut.ts` 的 `listAnchors` 必须继续逐字节等价
  （`tests/anchors.test.ts` 交叉校验）。
- 新增 service 名 `dsh-app-rewind-participants`：消费方需要在 `inject` 里声明；不声明的插件不受影响。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 边界前的 prompt 不可撤回 | 构造 surface：prompt A → checkpoint → prompt B | anchors 只含 B；`availability().stoppedAtCompaction === true` | `npm test`（新用例） | pending |
| 2 (W1) | 越界给稳定码 | 同上 surface，`/rewind 2` | `rewind.reason.compactionBoundary`，不写日志 | `npm test` | pending |
| 3 (W1) | 无压缩时行为不变 | 普通 surface，`/rewind 1` | 与今天一致，`stoppedAtCompaction === false` | 现有 `anchors.test.ts` + 新断言 | pending |
| 4 (W2) | picker 与宿主同源 | 同一 surface 分别调 `rewindView` 与 `listAnchors` | 序号、条数、边界一致 | `tests/anchors.test.ts` 扩一条 | pending |
| 5 (W3) | 参与者收到一次对账 | 注册两个 fake participant，执行一次撤回 | 各一次 `reconcileAfterUndo()` | `npm test` | pending |
| 6 (W3) | 重复 id 与注销 | 同 id 注册两次；注销后撤回 | 第二次抛错；注销后不再收到 | `npm test` | pending |
| 7 (W3) | 参与者失败隔离 | 第一个 participant 抛错 | 第二个仍跑；撤回保持成功；日志含失败原因 | `npm test` | pending |
| 8 (W4) | 文件回退仍是参与者 | 撤回含文件改动的轮次 | 文件还原 + 隔离区记录与今天一致 | 现有 `revert.test.ts` / `quarantine.test.ts` | pending |
| 9 | 全量回归 | `plugins/plugin-rewind` 17 个测试文件 | 0 fail | `npm test` | pending |
| 10 | 真机 | 在有压缩记录的会话上 `/rewind` | 列表止于边界，确认框有边界说明 | `npm run dev` + 手工 | pending |

## Verification commands

```
cd plugins/plugin-rewind && npx tsc --noEmit && node build.mjs && npm test
cd ../.. && npm test
npm run check:graph && npm run check:slots
npm run runtime:build && npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-<ver>.tgz
```

## Rollback

- 代码：三处改动彼此独立（W1/W2 只读会话、W3/W4 只加接缝），按条目回滚即可；不涉及日志格式迁移。
- 数据：撤回本身仍只做 surface 替换 + 隔离区移动，不删日志；本项目从未写过新的事件类型，
  所以旧会话在新旧版本之间都可读。
- 若 W4 的参与者在真机上出问题：把文件回退改回内联调用（保留注册表但先不迁），撤回主流程不变。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
（未开工）
