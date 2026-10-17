# rewind 撤回语义对齐：压缩边界、availability、参与者注册表

- Status: active
- Plan date: 2026-10-17
- 前置：内核线 0.2.1-rc.1 的升级与 Office/模型页收敛先落地（`docs/kernel-0.2.1-rc.1-upgrade.md` §7）

## Goal

把一份同类编码 Agent 的 undo 实现里**可移植的三件事**补进 `plugin-rewind`（下称「参照实现」）：
压缩边界处的显式停点与稳定原因码、撤回上限语义、参与者注册表。
存储模型不移植——参照实现走分支切换，DSH 的日志只追加，我们的 `surfaceOp` 替换
（`session.append('user/message', …, { surfaceOp })`）就是它在 DSH 里的对应物。

## Scope

- Must-have:
  - **W1 压缩边界**：撤回点截止到最新一个压缩检查点之后；越界请求给稳定原因码，不再静默少点。
  - **W2 availability**：宿主算出 `{ maxTurns, stoppedAtCompaction }`，`/rewind` 的选择器与命令共用同一份。
  - **W3 参与者注册表**：rewind 提供一个 service，其他套件插件注册 `reconcileAfterUndo()`，撤回后各自还原；
    rewind 自己的文件回退成为第一个参与者。
- Out of scope:
  - 参照实现的分支切换 / 状态重放存储模型（与 DSH 追加日志冲突）；
  - 它的错误基建与依赖注入框架；
  - 跨压缩自动重建上下文；
  - 给其他插件补撤回语义（只提供接缝，不替它们实现）。

## Approach

参照实现的三个做法：

| 它的做法 | 我们在 DSH 的对应实现 |
|---|---|
| 从尾部往前扫，遇压缩摘要停下并带出「停在了压缩边界」 | DSH 的检查点是**一条 `user/message`，其 `source.kind === 'compact-checkpoint'`**（`@deepseek-ai/dsh-compaction` 的 `checkpoint.ts:19-25`）。我们的 `listAnchors` 已经遍历 `surface.nodes`（`src/cut.ts:157`），边界前的点天然不出现；缺的是**说出来**：找到最新的 checkpoint 序号，作为边界返回给调用方 |
| 撤回前预检返回三个原因码（空 / 压缩边界 / 数量不足） | 同样的三态，落成我们自己的稳定码 `rewind.reason.{empty,compactionBoundary,insufficient}`，走 `HostText` 由客户端字典出文案 |
| `availability()` 给出可撤回条数与是否停在压缩边界 | 宿主算一份，命令结果与 picker 的注入面共用（`/rewind` 裸调用与 `/rewind n` 都读它） |
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
| W1 | P1 | 宿主：`cut.ts` 新增 `compactionBoundary(session)`（最新 `source.kind === 'compact-checkpoint'` 的 surface 序号）与 `availability(session)`；`index.ts` 的 `/rewind`、`/rewind plan` 用它判定越界并返回稳定码 | [x] |
| W2 | P1 | 客户端：picker 在边界处显示一行说明（复用插件字典），命令结果按码出文案；`rewindView` 与 `listAnchors` 的等价性测试同步扩一条 | [x] |
| W3 | P1 | 宿主：`provide('dsh-app-rewind-participants', registry)`，注册/注销/`reconcileAfterRewind()`，失败隔离与日志 | [x] |
| W4 | P2 | 把现有的文件回退（`revertFiles`）注册成第一个 participant；撤回流程改为“写日志 → 跑参与者 → 汇总报告” | [x] |
| W5 | P2 | 文档与交付：`plugins/README.md` 的 rewind 行、`docs/plans/rewind-undo-parity.md` 状态、版本 bump、`changesets/` 片段 | [x] |
| W6 | OPT | 参与者 `phase: 'after-flush'`：只有当出现“必须在刷新之后跑”的消费者时才加 | [–] |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1, W2 | 边界用例 + availability 用例 PASS，插件 `tsc`/`build`/`npm test` 全绿 | [x] |
| 2 | W3, W4 | 参与者用例 PASS，rewind 全量测试零回归 | [x] |
| 3 | W5 | 根套件全绿，产物重建后 `verify --tgz` 通过 | [ ] |

## Affected behaviors

- `/rewind` 与 `/rewind <n>`：列表内容不变；越界时从“静默拒绝/少点”变为固定原因码。
- `/rewind plan <n>`：多返回 `stoppedAtCompaction`，客户端确认框据此显示一句边界说明（边界序号不进这条负载：没有消费方需要它，
  `compactionBoundary()` 仍可从宿主侧直接读）。
- 撤回执行路径：写日志之后新增参与者对账；文件回退从“内联调用”变成“第一个参与者”。
- `src/projection.ts` 的 `rewindView` 与 `src/cut.ts` 的 `listAnchors` 必须继续逐字节等价
  （`tests/anchors.test.ts` 交叉校验）。
- 新增 service 名 `dsh-app-rewind-participants`：消费方需要在 `inject` 里声明；不声明的插件不受影响。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 边界前的 prompt 不可撤回 | 构造 surface：prompt A → checkpoint → prompt B | anchors 只含 B；`availability().stoppedAtCompaction === true` | `npm test`（新用例） | PASS — `tests/anchors.test.ts`「a prompt older than the newest checkpoint…」+「availability counts what the boundary leaves」 |
| 2 (W1) | 越界给稳定码 | 同上 surface，`/rewind 2` | `rewind.host.compactionBoundary`，不写日志 | `npm test` | PASS — 命令层：`tests/revert.test.ts`「a prompt after the checkpoint lists with the boundary and refuses past it by code」（驱动真实 `Session` + handler，断言 `code` 与 `params`）；单元层：`tests/cut.test.ts`「planCut names the compaction boundary…」 |
| 3 (W1) | 无压缩时行为不变 | 普通 surface，`/rewind 1` | 与今天一致，`stoppedAtCompaction === false` | 现有 `anchors.test.ts` + 新断言 | PASS — `tests/cut.test.ts`「availability reports…」、`tests/anchors.test.ts`「with no checkpoint…」 |
| 4 (W2) | picker 与宿主同源 | 同一 surface 分别调 `rewindView` 与 `listAnchors` | 序号、条数、边界一致 | `tests/anchors.test.ts` 扩一条 | PASS — `assertAgree` 现在同时比较序号与 `stoppedAtCompaction` |
| 5 (W3) | 参与者收到一次对账 | 注册两个 fake participant，执行一次撤回 | 各一次 `reconcileAfterRewind()` | `npm test` | PASS — `tests/participants.test.ts`「every participant reconciles once…」、`tests/revert.test.ts`「the file revert is the first participant…」 |
| 6 (W3) | 重复 id 与注销 | 同 id 注册两次；注销后撤回 | 第二次抛错；注销后不再收到 | `npm test` | PASS — `tests/participants.test.ts`「a duplicate id throws…」「unregistering removes…」 |
| 7 (W3) | 参与者失败隔离 | 第一个 participant 抛错 | 第二个仍跑；撤回保持成功；日志含失败原因 | `npm test` | PASS — `tests/participants.test.ts`（throw + reject 两条）、`tests/revert.test.ts`「a participant that throws…」 |
| 8 (W4) | 文件回退仍是参与者 | 撤回含文件改动的轮次 | 文件还原 + 隔离区记录与今天一致 | 现有 `revert.test.ts` / `quarantine.test.ts` | PASS — `revert.test.ts` 原有 5 条全部通过，新增一条断言报告字段与旧内联调用一致 |
| 9 | 全量回归 | `plugins/plugin-rewind` 的测试文件 | 0 fail | `npm test` | PASS — 18 个文件（含新增 `participants.test.ts`）177 条，0 fail（审查轮补了 4 条：命令层边界 2 条、参与者超时 1 条、上限规则 1 条） |
| 10 | 真机 | 在有压缩记录的会话上 `/rewind` | 列表止于边界，确认框有边界说明 | `npm run dev` + 手工 | pending — 本轮未做真机验证；**必须包含“先 `/compact` 再 `/rewind`”这一形态**，它是 `retainTokens = 0` 的唯一真实入口 |
| 11 (W1) | 压缩吃掉全部 prompt | `/compact` 后的 surface：checkpoint + 最后一个节点 | 裸 `/rewind` 与 `/rewind 1` 都答 `rewind.host.compactedAll`，不是 `empty` | `npm test` | PASS — `tests/revert.test.ts`「after /compact leaves no prompt…」 |
| 12 (W3) | 参与者挂住 | 一个永不 settle 的参与者 + 一个正常参与者（deadline 注入 20ms） | 撤回照常结束；挂住的 id 不在报告里；后一个仍跑；日志含原因 | `npm test` | PASS — `tests/participants.test.ts`「a participant that never settles is cut off…」 |
| 13 (W1) | 上限截断不算压缩 | `planCut(session, 2, 1)` 与 `planCut(session, 2, 50)` | 前者 `outOfRange`，后者 `compactionBoundary` | `npm test` | PASS — `tests/cut.test.ts`「a list truncated by the caller's cap…」 |

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
| 1（W1+W2） | 2026-10-17 | 插件 `npx tsc --noEmit` exit 0；`npm run build` exit 0（`lib/index.js` + `lib/client.js`）；`npm test` exit 0（18 个文件 / 173 tests / 0 fail）；边界与 availability 用例：`tests/anchors.test.ts` 4 条 + `tests/cut.test.ts` 3 条 + `tests/projection.test.ts` 3 条 + `tests/popup.test.ts` 3 条 + `tests/locales.test.ts` 1 条 | 主张复核：「越界不再是静默少点」由三处同一份 `availability` 支撑（命令列表、越界原因、picker 的 wire 标记），交叉校验测试同时比较序号与 `stoppedAtCompaction`，两侧从同一 surface 事实推出。判断：`n=0/-1/1.5` 仍报 `outOfRange`（参数错误不该借用「压缩过」这个真实事实）；picker 的说明放在宿主弹层的 group 标题上（选项形状没有禁用行，插件也不自绘弹层）。 |
| 2（W3+W4） | 2026-10-17 | 同上的 typecheck/build/test；`tests/participants.test.ts` 6 条（顺序、重复 id、throw、reject、注销、空表）；`tests/revert.test.ts` 新增 2 条端到端（`file-revert` 是第一个参与者且报告字段与旧内联调用一致；抛错参与者不影响撤回与后一个参与者，失败原因进日志），原有 5 条全过；根 `npm test` exit 0（681 tests / 679 pass / 0 fail / 2 skipped）；`node --test test/type-escape-ratchet.test.mjs test/plugin-version-bump.test.mjs` 4/4（`plugin-rewind` 的 `as unknown as` 仍为 0） | 主张复核：文件回退真的在 `reconcileAll` 里跑——由「后注册的参与者读到已还原的字节」直接观测，不靠日志推断。判断：参与者失败被注册表吞掉后，报告的 `unrestorable[0].reason` 只剩稳定串（原始错误在插件日志里，而该字段本就不进用户文案）；撤回的日志写入仍是权威动作，参与者跑在其后，因此替换失败时不再先改文件。残余：`fileRevertOf` 的兜底分支没有能强制 `revertFiles` 抛错的用例（现有实现内部自捕获），只能由注册表层的隔离用例间接覆盖。 |
| 3（W5） | 2026-10-17 | 已做：版本 0.1.4 → 0.1.5、`changesets/rewind-undo-parity.md`（`parseFragment` 解析通过：`shell: none` / `plugins: ["plugin-rewind"]` / 两行正文）、`plugins/README.md` 行、根 `npm test` 681/679/0/2。 | 门禁的产物部分见下一行。`shell: none` 是审查后的更正：本次没有 `src/**` 改动，按 `changesets/README.md` 的口径纯插件改动标 `none`。 |
| 3（产物） | 2026-10-17 | `npm run runtime:build` 在 rewind 改动后**无法重建**：上游把 `next` 移到了 `0.2.1-rc.2`（2026-10-17T08:36Z），`^0.2.1-rc.1` 的子包规格解析到 rc.2，而本地产物钉 rc.1 → 守卫报 `lockfile resolved …@0.2.1-rc.2, but this runtime ships dsh 0.2.1-rc.1`；钉 `DSH_VERSION=0.2.1-rc.1` 也一样，因为子包是范围规格。**未打勾。** | 产物闸门被上游移动阻塞，不是代码问题。此前（rewind 改动前）的 rc.1 产物仍在 `runtime-dist/`，`verify --tgz` 曾全过，但它不含 0.1.5。补全路径：下一轮把 spec 与检出一起升到 rc.2（改 spec → 清装 → 重跑门禁 → 重建产物 → `verify --tgz`），或给构建加“精确钉住子包版本”的模式。 |
| 审查轮 | 2026-10-17 | 独立 reviewer（只读、无 shell）逐行读内核源码后给出一条 P1、四条 P2、八条 P3。P1 已复现并修复：`/compact` 在 `retainTokens = 0` 时只留最后一个节点，压缩后**锚点数为 0**，于是“边界”四句话在用户刚压缩完时全部不可达 —— `planCut` 与 list 分支改为先看边界，新增 `rewind.host.compactedAll`，并补了命令层用例（第 11 条）。同时修：参与者加 30s 超时（可注入，第 12 条）、预览路径不再第三次遍历 surface、上限截断不误报压缩（第 13 条）、客户端在被拒的预览里读 `payload.reason` 而不是恒读 `rewind.host.plan`、`availability` 的注释不再声称 picker 用同一个 `max`、`compactionBoundary` 的注释写明“只对从 surface 头部开始的压缩成立”、参与者上下文注明实际是活的 `Session`、re-export 的注释改为“无 `.d.ts`，消费方自行声明”、`cut.test.ts` 的 `sessionOf` 注明它只建模 append。 | 仍未验证：**真机压缩会话**（第 10 条）；**服务在真实 cordis 下的跨插件可达性**——本套件此前没有 `ctx.provide` 先例，测试用的是三行 stub，兄弟插件 `inject` 能否被唤醒没有证据；`fileRevertOf` 的兜底分支没有能强制 `revertFiles` 抛错的用例（其内部自捕获）；“文件回退只在参与者里发生”没有被独立证明（`revert.test.ts` 的顺序断言在“改回内联”时同样成立），已在用例注释里写明。 |
