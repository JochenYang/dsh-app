# 归档删除加固：可撤销、无残留、Windows 可靠

- Status: active
- Plan date: 2026-11-02
- Risk: high

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。

## Goal / Why

让 `plugin-archives` 的删除变成可撤销、可解释、无残留的操作。今天 `/delete` 直接
`rm(dir, { recursive: true, force: true })`（`plugins/plugin-archives/src/routes.ts:486`），
一次点击就是不可逆的磁盘删除；同时它只删会话目录，从不碰投影缓存，也没有子代理整树、
运行中会话、批量选择与重试。

成功标准：删除先进回收站、可还原；彻底删除时把该会话的投影缓存一并清掉；
路径包含校验挡住符号链接越界；Windows 上被杀软/索引器短暂占用时能退避重试而不是报 `io`。

## 要补的差距（逐条可核对）

删除这条路要同时满足四件事：**可撤销、无残留、越界删不到、Windows 删得掉**。下面十条按这四件事排。

| # | 差距 | 证据 |
|---|---|---|
| 1 | 删除不可撤销 | `plugins/plugin-archives/src/routes.ts:486` 直接 `rm`，没有任何副本 |
| 2 | 投影缓存永久残留 | `/delete` 只删会话目录；`/prune` 只删归档记录（`routes.ts:504`）。本机实测：`~/.dsh/sessions` 326 个会话目录，`~/.dsh/storages/session_projcache/sessions` 468 个分片，其中 **142 个无对应会话目录，合计约 26.8 MiB** |
| 3 | 路径包含只校验 basename | `routes.ts:478` 只比较 `basename(resolvedDir) === id`，`locatedSessionDir`（`routes.ts:384`）也只比对目录名与日志文件名；父目录若是符号链接，`rm` 会删到根外 |
| 4 | 运行中会话只能跳过 | `routes.ts:453-463` 的 `activity` 瀑布一旦非空就记 `live` 跳过，没有「先停止再删」的路径 |
| 5 | 没有子代理整树 | 只删一个会话目录；子代理会话是同级独立目录，删除父会话后其子代理日志成为孤儿 |
| 6 | Windows 删除无重试 | `rm(..., { force: true })` 失败即落 `io`（`routes.ts:489`），没有 EPERM/EBUSY 退避 |
| 7 | 没有批量选择 | 客户端 `archives-section.tsx` 逐行操作，没有多选与底部批量栏 |
| 8 | 没有保留策略与用量 | `/list` 只给分组与字节数，没有保留天数、启动清理、用量趋势 |
| 9 | 没有审计记录 | 删除/还原/清理都不留痕 |
| 10 | 「保留归档记录」是绕法 | 模块头（`routes.ts:33-38`）说明保留记录是为了挡住客户端陈旧快照的「删了又回来」；根因是没有广播移除事件 |

## Scope

- Must-have:
  - **W1 回收站存储层**：`$DSH_HOME/storages/dsh-app-plugin-archives/trash/<trashId>/metadata.json`
    + `payload/<n>/`（每个成员一个目录），原子写元数据；任一成员搬移失败把已搬的回滚并删条目目录。
  - **W2 `/delete` 改为移入回收站**，新增 `/purge` 做真删；`/delete` 的响应体新增 `trashId`。
  - **W3 `/restore-deleted`**：把条目搬回原路径（目标已存在则拒绝），并恢复归档/置顶记录。
  - **W4 投影缓存清理**：`/purge`、清空、过期清理时删 `storages/session_projcache/sessions/<id>.json`；
    移入回收站时**保留**（还原后标题与元数据可直接用）。
  - **W5 路径包含加固**：对父目录做 `realpath`，规范化后必须落在会话根内，否则拒绝；
    保留现有 `LITERAL_SEGMENT` 与 basename 校验作为第一道。
  - **W6 Windows 删除退避**：EPERM/EBUSY/EACCES 指数退避重试，只读属性先清再删。
- Should-have:
  - **W7 子代理整树**：删除根会话时把其子代理目录一并移入同一回收站条目；任一子代理运行中则整体拒绝。
  - **W8 先停止再删**：通过公开的 `workspace/session-stop` 瀑布停止，再等 `workspace/session-activity`
    归空后才继续；超时则拒绝并给出稳定原因码。
  - **W9 批量选择**：客户端多选 + 底部操作栏 + 确认框（数量、总大小、工作区分组、运行中/含子代理条数）。
- Nice-to-have:
  - **W10 保留策略**：7/15/30/90 天或永久 + 启动清理 + 用量统计。
  - **W11 审计日志**：`$DSH_HOME/logs/dsh-app-plugin-archives.log`，每次删除/还原/清空一行 JSON。
  - **W12 `api-session/removed` 广播**：删完广播，让侧栏即时消失，从而不再需要「保留归档记录」这个绕法。
- Out of scope:
  - 清理内容寻址附件与会话产出的工作区文件（与「删除会话」不是同一件事，误删风险高）。
  - 跨盘搬移的 copy→verify→delete（见 Ruled out）。
  - 会话搜索、归档列表本身的重构。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 用 `detachEntered` / `liveEntryFor` 摘除活体会话 | 这两个在 `@deepseek-ai/dsh-session` 的 `.d.ts` 里是 `private`（`lib/types/index.d.ts:459`、`:485`），只能靠 `as unknown as` 绕过类型门；内核线一动就静默失效，正是 AGENTS.md 记的「Upstream API drift」那条风险 |
| 跨盘搬移用 copy → 逐文件校验 → 删源 | 会话目录与回收站同在 `$DSH_HOME` 内，正常永远同盘；只有把 `DSH_HOME` 指到别的盘才可能触发 → 进 Deferred |
| 继续保留归档记录、只补一个「清理残留」按钮 | 那是把问题留给用户手动收尾；根因是缺少移除广播，W12 直接解决 |
| 删除前先备份整份会话日志到别处 | 与回收站是同一件事，回收站已经承担这个角色，两套会互相打架 |
| 在 `/delete` 里内联做回收站逻辑 | 会让 `deleteArchives`（`routes.ts:417`）继续膨胀；回收站独立成模块才能被 `/purge`、清空、过期清理复用 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | 新增 `plugins/plugin-archives/src/trash.ts`：条目布局、两阶段元数据、三态路径探测、搬入失败结算（回滚逐成员证明）、列出/还原/彻底删除。审查第 3 轮指出的「声明成员数参与判定」已重写为「磁盘事实是唯一真相」，终审确认贯彻 | [x] |
| W2 | P0 | `routes.ts`：`/delete` 改走回收站，新增 `/purge`，响应体加 `trashId`。`/purge` 授权已收紧到 `present`，`unknown` 一律拒绝 | [x] |
| W3 | P0 | `routes.ts`：新增 `/restore-deleted`；客户端「会话回收站」面板（列表、逐条还原、彻底删除、清空）。行上如实渲染 `restorableBlock`/`unverified`/`skipped.sessions`/`detail` | [x] |
| W4 | P0 | 新增投影缓存清理：`/purge`、清空、过期清理时删对应分片（两种命名都认）；移入回收站时保留 | [x] |
| W5 | P0 | `routes.ts` + `trash.ts`：真实路径包含校验（`realpath`），越界即拒绝并记稳定原因码。**提前到阶段 1 实现**；TOCTOU 已在模块头写明未消除 | [x] |
| W6 | P0 | 新增 `plugins/plugin-archives/src/fs-util.ts`：Windows 退避重试、只读属性清除 | [x] |
| W7 | P1 | 子代理整树：采集子代理目录、整体移入同一回收站条目、任一运行中则拒绝 | [x] |
| W8 | P1 | 先停止再删：`workspace/session-stop` + 等活动归空，超时给稳定码 | [x] |
| W9 | P1 | 客户端批量选择：多选、底部操作栏、确认框、失败项保留；并补上 `stopFirst` 勾选入口 | [x] |
| W10 | P2 | 保留策略与用量：保留天数、启动清理、用量统计。策略文件读不出时回落成「不删除」而不是产品默认 | [x] |
| W11 | P2 | 审计日志：删除/还原/清空/策略变更各一行 JSON | [x] |
| W12 | P2 | `api-session/removed` 广播，删掉「保留归档记录」的绕法与对应注释。**已实现后撤回**：终审穷举确认该事件在当前内核线没有任何订阅方，撤掉记录等于让会话弹回侧栏；恢复保留记录，广播仅作附加信息 | [–] |
| W13 | P2 | 交付物：`plugins/README.md` 的 archives 行 + 回收站磁盘布局、版本 0.2.4 → 0.2.5、`changesets/archives-trash-retention-audit.md`、zh/en 字典补齐 | [x] |

类目：P0 不做就走不通 · P1 静默失败或数据风险 · P2 清理与一致性 · OPT 可选。

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 1 回收站与可撤销 | W1, W2, W3, W5 | 条目全 `[x]`；T1–T4、T6、T7、T16 PASS；两个 subagent 独立审查无阻塞发现 |
| 2 安全与残留 | W4, W6 | 条目全 `[x]`；T5、T8 PASS（含只读文件反例） |
| 3 整树与运行中 | W7, W8 | 条目全 `[x]`；T9–T11 PASS |
| 4 批量与策略 | W9, W10, W11 | 条目全 `[x]`；T12–T14 PASS |
| 5 收尾 | W12, W13 | 条目全 `[x]`；T15 PASS；陈旧快照反例不再复现 |

阶段闸门：任何条目处于 `[~]`、`[?]` 或 `[!]` 时不得开始下一阶段。
本计划 Risk: high，按 skill 要求**每个阶段至少 2 个 subagent 独立审查**，结论冲突时按更严格的阻塞项处理。

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| `/delete` 语义从「真删」变为「移入回收站」 | modified | `plugins/plugin-archives/src/routes.ts:417` |
| 新增 `/purge`、`/restore-deleted` | added | `plugins/plugin-archives/src/routes.ts`（路由注册段） |
| 彻底删除时清投影缓存 | added | 新增 `plugins/plugin-archives/src/projcache.ts` |
| 删除前做 `realpath` 包含校验 | modified | `plugins/plugin-archives/src/routes.ts:478`、`:384` |
| Windows 删除失败改为退避重试 | modified | 新增 `plugins/plugin-archives/src/fs-util.ts`，替换 `routes.ts:486` |
| 删除根会话时一并处理子代理目录 | added | 新增 `plugins/plugin-archives/src/tree.ts` |
| 运行中会话从「跳过」变为「可先停止」 | modified | `plugins/plugin-archives/src/routes.ts:453` |
| 客户端从逐行操作变为可多选 | modified | `plugins/plugin-archives/src/client/archives-section.tsx:287` |
| 删除后广播移除事件 | added | `plugins/plugin-archives/src/index.ts` |
| 归档记录不再保留为可见性围栏 | removed | `plugins/plugin-archives/src/routes.ts:33-38`（注释）、`:417`（逻辑） |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 移入回收站 | 一条有日志目录的归档会话 | 目录搬到 `trash/<id>/payload/0`，元数据原子写入，原目录不存在 | `cd plugins/plugin-archives && npm test` | PASS (`npm test`, 2026-11-02) |
| 2 (W1) | 搬移中途失败 | 第二个成员的 `rename` 注入 EBUSY | 第一个成员被正面证明搬回原位，条目目录被删，返回错误 | 同上 | PASS (`npm test`, 2026-11-02) |
| 3 (W2) | 幂等 | 同一 id 连续两次 `/delete` | 第二次返回「已在回收站」，无副作用 | 同上 | PASS (`npm test`, 2026-11-02) |
| 4 (W3) | 还原 | 回收站条目还原 | 目录回到原路径，归档记录恢复；原路径已存在时拒绝 | 同上 | PASS (`npm test`, 2026-11-02) |
| 5 (W4) | 投影缓存清理 | 彻底删除一条会话 | `session_projcache/sessions/<id>.json` 不存在；移入回收站时该文件仍在 | 同上 | PASS (`npm test`, 2026-11-02) |
| 6 (W5) | 链接越界 | 会话父目录是指向根外的 junction | 拒绝删除与还原并返回稳定原因码，根外文件不受影响 | 同上（junction 夹具本轮真实执行） | PASS (`npm test`, 2026-11-02) |
| 7 (W5) | 非法会话 ID | `..`、含 `<>:"\|?*`、保留设备名 | 一律拒绝，不进入路径拼接 | 同上 | PASS (`npm test`, 2026-11-02) |
| 8 (W6) | 只读/占用文件 | 目录内文件置只读；模拟 EBUSY | 退避后成功；仍失败则返回 `io` 且给出残留路径 | 同上 | PASS (`npm test`, 2026-11-02) |
| 9 (W7) | 子代理整树 | 一个根会话 + 两个子代理会话 | 三个目录进同一个回收站条目，还原时三个都回来 | 同上 | PASS (`npm test`, 2026-11-02) |
| 10 (W7) | 子代理运行中 | 任一子代理有活动 | 整体拒绝，不留下半棵树 | 同上 | PASS (`npm test`, 2026-11-02) |
| 11 (W8) | 先停止再删 | 运行中的会话 + `stopFirst: true` | 停止后活动归空再删；超时则拒绝并给稳定码 | 同上 + `npm run dev` 手工 | pending（自动化半已 PASS；`npm run dev` 手工半未跑） |
| 12 (W9) | 批量部分失败 | 批量里混入一个已不存在的 id | 其余成功，失败项带原因保留在选择里 | `npm test` + 手工 | PASS (`npm test`, 2026-11-02) |
| 13 (W10) | 保留天数 | 保留 7 天，制造 8 天前的条目 | 启动清理与「立即清理」都只删过期项 | `npm test` | PASS (`npm test`, 2026-11-02) |
| 14 (W11) | 审计日志 | 做一次删除 | 日志追加一行 JSON，含操作、id、结果、字节数 | 同上 | PASS (`npm test`, 2026-11-02) |
| 15 (W12) | 陈旧快照不再复现 | 删除后不刷新页面 | 侧栏行立即消失，不出现「删了又回来」 | `npm run dev` 手工 | N/A（W12 已撤回：`api-session/removed` 在当前内核线无消费方，保留归档记录才是成立的机制） |
| 16 (W3) | 回收站面板 | `npm run dev`，归档一条会话后删除 | 面板列出该条目，还原后会话回到归档列表，彻底删除后条目消失 | `npm run dev` 手工 | pending（本环境无图形界面，未走查） |

## Verification commands

```sh
cd plugins/plugin-archives && npm run typecheck && npm run build && npm test
npm run dev                      # 手工：归档 → 删除 → 回收站 → 还原 → 彻底删除
npm run check:suites:gate        # 根目录
npm run check:graph              # 根目录
npm test                         # 根目录，含 plugin-version-bump
```

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 跨盘搬移（copy → 逐文件校验 → 删源） | 会话与回收站同在 `$DSH_HOME`，正常同盘；只有 `DSH_HOME` 跨盘才有意义 | 收到 `DSH_HOME` 指向另一块盘的用户报告时 |
| 清理内容寻址附件与会话产出文件 | 与会话日志生命周期不同，误删风险高 | 单独评估「彻底清理一个工作区」时 |
| 回收站加密或权限收紧 | 当前与 `$DSH_HOME` 同权限级别，与内核行为一致 | 出现多用户共用机器的场景时 |
| 回收站容量上限自动淘汰 | 保留天数已能控制增长，再加容量上限会引入「静默删除」语义 | 出现回收站撑爆磁盘的报告时 |
| `restoreEntry` 的回滚不比照 `settleFailedMove` 做正面证明 | 回滚失败时数据仍在原位（不丢），只是条目变成不可还原；属产品内不可恢复，不是数据丢失 | 首次出现「还原失败后无法再还原」的用户报告时 |
| 并发 `/restore-deleted` 没有按条目互斥 | 两个窗口同时还原同一条目，后者的回滚可能把前者刚放回的目录又搬进 payload；数据不丢但状态错乱 | 回收站面板上线后出现并发还原报告时 |
| `state: 'purging'` 残留只靠用户点「重试删除」回收 | 自动回收需要启动扫描与老化阈值，本轮先把「不可见的字节」变成「可见可重试的行」 | 出现残留长期堆积的报告时 |
| `rootUnknown` 条目在换过 `DSH_HOME` 的后端上可能永久不可还原 | 记录的原路径落在当前 sessions 根之外，严格包含会一直拒绝；删除方向不受影响 | 出现「换过 DSH_HOME 后回收站里的旧条目无法还原」的报告时 |
| 条目以「批次」为单位，单个会话无法独立还原或彻底删除 | 一个会话一个条目会消掉失败结算的复杂度，但会改变面板的行粒度（产品可见）；W7 子代理整树又需要「同进同出」 | 做 W7 时用 `batchId` 分组重新评估粒度 |

## Rollback

- 数据：回收站条目是磁盘上独立的目录树，回退插件代码后它们只是不再被引用；
  条目布局（`trash/<trashId>/payload/<n>/` + `metadata.json` 里的 `originalPath`）写进 README，
  用户可手动搬回。**这是高风险改动的兜底手段，必须随 W1 一起落地文档。**
- 代码：改动集中在 `plugins/plugin-archives/`，回退该目录与版本号即可；不涉及内核线。
- 已知坑：
  - `resolveCurrentLog` 只对当前格式的日志作答（`routes.ts:330-336`），旧格式会话要靠目录查找兜底，
    改动时必须保留这条路径，否则旧会话会从「可删」变成「永远删不掉」。
  - Windows 上符号链接夹具需要开发者模式或管理员权限，CI 上可能跳过 → 该用例标 `N/A（需要符号链接权限）` 时
    必须在 Phase log 写明跳过原因，不得算 PASS。
  - 投影缓存分片的命名有两种（`<id>.json` 与裸 UUID），清理逻辑必须两种都认，否则漏删一半。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 回收站与可撤销 | 2026-11-02 | `cd plugins/plugin-archives && npm run typecheck`=0；`npm test`=0（159 项 / 158 通过 / 1 跳过）；`npm run build`=0；`node scripts/plugin-gates.mjs plugins/plugin-archives`=0；终审记录 `.devflow/archive-delete-hardening/review-final.md`。T1–T4、T6、T7 PASS；W1–W5 `[x]` | Gate 未过：T16（回收站面板走查）pending，本环境无图形界面 |
| 2 安全与残留 | 2026-11-02 | 同上命令；T5、T8 PASS（投影缓存两种命名、只读文件与 EBUSY 退避均有反例） | Gate 通过 |
| 3 整树与运行中 | 2026-11-02 | 同上命令；T9、T10 PASS（三个目录同进同出、任一子代理运行中整体拒绝）；T11 自动化半 PASS，手工半未跑 | Gate 未过：T11 的界面手工半 pending |
| 4 批量与策略 | 2026-11-02 | 同上命令；T12–T14 PASS；终审 P0（设置读不出即授权删除）已修为「读不出就不删」并有反例用例 | Gate 通过 |
| 5 收尾 | 2026-11-02 | T15 判 N/A（W12 撤回，理由见 Work items）；W13 交付物齐（版本 0.2.5、changeset、README 含回收站磁盘布局）；`check-suites-drift --check`=0；根 `npm test`=0（729/727/0） | Gate 通过 |
