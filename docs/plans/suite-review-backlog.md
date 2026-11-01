# 套件审查 backlog（19 插件）

- Status: active
- Plan date: 2026-10-31
- Risk: high（含越权写盘、原件不可逆丢失、凭据落盘；按改动内容分级，不按任务大小）

## Goal / Why

把一轮「全部套件 + 工作台扩展」审查的发现按伤害程度排序并落成可勾选的修复计划。50+ 条发现里只有 7 条同时具备
「安全或不可逆数据」性质，16 条属静默错数据；先修这些，nit 与可选优化排后面。成功标准：P0/P1 全部有复现证据
并按阶段落地，每阶段 Gate 通过时构建与既有测试全绿。

工作台（`plugin-workbench`）在审查中**未发现实现错误**：两个扩展座位声明在容器自己的 `main` 注册的 `children`
里，符合 `boundRenderSlot` 的所有权规则；`entriesOfSlot` 的 keyed cell 与 `entry.options.key` 用法经核对内核
实现正确；`display:contents` 锚点被 CSS 规则 `.dshWorkbench-grid > [data-slot] > *` 正确绕开。它只剩两个
**未验证面**（见 Deferred）：扩展契约尚无真实使用者、`openView` 对未注册 key 静默 no-op。

## Scope

- Must-have：P0 全部（安全 + 不可逆数据）、P1 全部（静默错数据）、每项一条回归断言。
- Out of scope：新功能、重构、内核线升级、发版。
- 分类口径（沿用本 Skill）：P0 不做受影响输入就走不通 / 越权 / 不可逆丢数据 · P1 静默失败或数据风险 ·
  P2 清理与一致性 · OPT 可选。同级内按 **安全 > 不可逆数据 > 静默错数据 > 浪费** 排序。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 改内核让 `runtime-context` 快照支持 replace | 本仓规则不修改 harness；且上游不接 PR/issue。已在 `plugin-codegraph/src/prompt.ts` 的 `magnitude()` 注释记录机制与实测数字 |
| 把 codegraph 概览挪进 `systemPrompt.section`（有 replace 语义） | 每次 re-index 会重写系统提示、作废整条 prompt 前缀缓存，比多几条快照更贵 |
| 一次性大改（按插件重写） | 每个 W 条目独立可回滚；审查发现多为局部缺陷，重写收益为负 |

## Work items

> 状态：`[ ]` 待办 → `[~]` 已改未审 → `[x]` 审查通过 → `[?]` 审查不通过 → `[–]` 本轮不做 → `[!]` 待用户决定。
> 来源标记：`[复核]` = 本轮由我读源码确认；`[报告]` = 来自只读 review，**未经复现**。

### 本轮完成度（2026-11-01）

**状态列已按本段与 Phase log 回填（2026-11-01）**；后续以 Work items 状态为准。

已实现并跑过测试（`codegraph 375 / market 406 / memory 193 / ppt 168 / pdf 119 / presets 115 / usage 43 / rewind 190 / hooks 38 / swarm 40 / mcp 57 / sidebar 59 / client-ui 31 / archives 21`，根 `npm test` 727 pass / 2 skipped）：

- P0：W1、W2、W3、W4、W5、W6、W7
- P1：W8、W10、W11、W12、W13、W14、W15、W16、W18、W19、W20、W22、W37
- P2：W9（`/graph` 对未 adopt 项目答 `notAdopted` 而非触发扫描）、W21、W23、W25（相似对批量写一次）、W26（四子项）、W28、W29（三项性能）、W30（两个对话框改用 `Modal`/`Button`，`.dshMkt-cardFoot` 三处合并）、W33（LRU 淘汰）、W35、W36
- W17：`AbortSignal` 已贯通到唯一消费者 `revertFiles`（超时后不再继续写盘）
- W24：`inFlight` 按 key 释放 + recorder 的 20k 上限与 `trimmedThroughSeq` 覆盖判据
- W27：临时文件唯一化 + 模板扫描为空时不缓存

明确未做，理由与回来条件见 `## Deferred`：W24 的 quarantine 保留策略与预览载荷上限、W27 的原子写 / `exec.signal` / `read` 2MB / 绝对路径、W31 的其余两项、W32（待裁决）、W38（需与 CI 一起改）。


### P0 — 安全 / 不可逆数据

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 · 功能不可用 | `plugin-codegraph/src/indexer.ts:394` `projectChanged` 的 `seen` 未收 `scan.tooLarge`（`indexProject:448` 收了），涨过体积上限的文件使该函数永远返回 changed → 每轮 debounce 排全量 pass 且 freshness 恒 stale。注释与实现相反 `[复核]` | [x] |
| W2 | P0 · 安全 | `plugin-ppt/src/pptd-paths.ts:69` 祖先校验遇第一个不存在的祖先就 `break`，工程内符号链接可让写入落到工作区之外；对照 `plugin-pdf/src/pdf-paths.ts:90` 的正确写法 `[复核]` | [x] |
| W3 | P0 · 数据 | 导出目标无护栏：`plugin-pdf/src/index.ts:600` `pdf_edit` 不比较 `output_file` 与 `file_path`（源文件被 tmp+rename 覆盖、不可逆）；`plugin-ppt/src/index.ts:463`、`plugin-pdf/src/index.ts:337,506,609` 对已存在文件静默覆盖 `[复核]` | [x] |
| W4 | P0 · 数据 | `plugin-ppt/src/skill.ts:314`、`plugin-pdf/src/skill.ts:114` 按名字覆盖 `$DSH_HOME/skills/dsh-{ppt,pdf}`，会改掉用户从市场装的同名 skill；同文件 `retireSkills` 已用正文判定，安装路径没有 `[复核]` | [x] |
| W5 | P0 · 数据 | `plugin-presets/src/legacy-migration.ts:257` 拼 YAML 未转义 `id`，目录名含 `: ` / ` #` 会写出**无法解析**的 `$DSH_HOME/cordis.patch.yml`（所有 profile 都加载的层），写前无 re-parse 自检 `[复核]` | [x] |
| W6 | P0 · 数据 | `plugin-memory/src/routes.ts:512` `/archive-clear` 省略 `scope` 即清空**所有项目**的撤销副本；同文件 `/clear:231` 明确写着破坏性操作不得靠省略命中。**已裁决（2026-10-31）**：改为必填 `scope`，缺省返回 400，面板请求补 `scope:'all'`（语义不变，只从「静默命中全部」变成「显式命中全部」）`[复核]` | [x] |
| W7 | P0 · 安全 | `plugin-memory/src/memory-store.ts:192` 凭据过滤是 11 条正则黑名单：`AKIA…`、PEM、JWT、裸 32 位 hex、`db://user:pw@host` 均放行并落盘、每会话注入；`:322` 手改（malformed）卡整段注入且不检查 `[复核]`（探针实测 8/12 类放行，待 Guard 复核修法） | [x] |

### P1 — 静默错数据 / 静默失败

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W8 | P1 | `plugin-codegraph/src/indexer.ts:561` + `routes.ts:252`：语法缺失的文件仍写 stat 缓存行，装上语法后只下载不重索引，该语言文件永远无符号 `[复核]` | [x] |
| W10 | P1 | `plugin-market/src/skills.ts:294`、`unzip.ts:92`：技能安装无字节上限（`arrayBuffer()` 全量入内存、`inflateRawSync` 不设界），压缩炸弹即可耗尽内核子进程 `[复核]` | [x] |
| W11 | P1 | `plugin-market/src/store.ts:235` + `routes.ts:791`：一次瞬时失败把该源缓存写成空 entries 且仍判新鲜 → 该源 6 小时内不重试、旧行也借不出来，与注释相反 `[复核]` | [x] |
| W12 | P1 | `plugin-market/src/bridge-install.ts:199`：`BlockedBuildLedger` 只在路由路径记录，模型安装后 `/allow-build` 一律 `notBlockedInstall`，`refusalOf` 也丢掉 blockedBuilds `[复核]` | [x] |
| W13 | P1 | `plugin-client-ui/src/client/models-advanced/{section,ui,route-advanced,import-dialog}.tsx`：4 处缺「路由代次守卫」+「恢复默认」不生效（界面显示 500K、保存 unset）+ `HeadersField` 的 key 让首次「添加」行消失 + 重试是死按钮 `[复核]`（四项均已按代码确证；「恢复默认」只影响显示，单独按 P2 修） | [x] |
| W14 | P1 | `plugin-presets/src/backup.ts:363` `add()` 吞掉一切异常：`.credentials.yaml` 读失败时导出「成功」但不含密钥，且无警告 `[复核]` | [x] |
| W15 | P1 | `plugin-usage/src/backfill.ts:116` 格式迁移只对循环里第一个 session 生效，其余带旧 seq 的行全量重折 → 用量重复计数并写盘 `[复核]` | [x] |
| W16 | P1 | `plugin-rewind/src/index.ts:592` `captured` 先入表再 await（`turn/start` 那条是 `void`），工具门不等遍历完成 → 快照可能记成写后状态却报 `coverage: full` `[复核]` | [x] |
| W17 | P1 | `plugin-rewind/src/participants.ts:196` 超时只放弃等待不取消：用户看到「未恢复」而 `revertFiles` 仍在写盘，期间再来一次 recall 会并发改同一批文件 `[复核]` | [x] |
| W18 | P1 | `plugin-swarm/src/orchestrator.ts:413` `classifyLaunchError` 只认 dsh-llm 失败码，Node 网络 errno 一律当 `structural` 终态（不重试、不缩池）`[复核]`；`:731,856` `watch.wait` 无超时只由 `subagent/end` 或 abort 释放，依赖上游事件契约 → 该半条降 P2 | [x] |
| W19 | P1 | `plugin-hooks/src/native.ts:91` 规则 `push` 与 `throw` 同在一个循环内：条目中途失败留下「前半截已生效、界面显示未生效」`[复核]`；同文件四个拦截器无测试（本仓记录过漏 `next()` 的坑） | [x] |
| W20 | P1 | `plugin-sidebar/src/client/diff-ruler.ts:83` `---`/`+++` 用前缀判文件头、位置无关：删一行 `-- x` 或加一行 `++i` 即被当 meta → 该行不计号、后续 hunk 行号错一位、标尺少一块 `[复核]` | [x] |
| W22 | P1 | `plugin-market/src/installer.ts:317` POSIX 上 `kill(-pid)` 因未 `detached` 而失败，pnpm 孙进程存活并继续持锁 `[复核]`（代码形态确证；行为需 Linux 复现） | [x] |

### P2 — 清理与一致性

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W9 | P2 · 一致性 | `plugin-codegraph/src/routes.ts:318` `GET /graph` 对未知 cwd 触发 `reindex`：**不绕过队列**（`void options.reindex(...)` 就是 `queue.request`），但把索引范围放到了「任意 cwd」而非「已 adopt 项目」`[复核]`（自 P1 下调：无提权含义，落库不出本机） | [–] |
| W21 | P2 · 防漂移 | `plugin-archives/src/routes.ts:471` 删除走 `rm(dirname(resolveCurrentLog(id)))` 且不校验目录名；三道栅栏（已归档 / 在内核列表 / 无活动）挡掉了任意 id，但主路径完全信任 resolver 的返回形状，内核布局变化会连带删同项目其它会话；同文件 fallback 反而有校验 `[复核]`（自 P1 下调：当前布局下不可触发） | [x] |
| W23 | P2 | `plugin-market/src/routes.ts:1303` `/uninstall` 缺 `@dsh-app/` 守卫（`/toggle:1021` 有），面板卸载按钮未对 `pkg.suite` 禁用 `[复核]` | [x] |
| W24 | P2 | `plugin-rewind`：`recorder.ts:106` 无上限、`quarantine.ts` 零保留策略、`index.ts:1100` 预览载荷无上限（一次重建 dist 可让 plan 返回数百 MB）、`trees.ts:457` `inFlight.clear()` 清掉别的会话的持有 | [~] |
| W25 | P2 | `plugin-memory/src/light-sweep.ts:81` 每对相似卡整份同步重写 `distill-state.json`（30 卡最坏 435 次），且阻塞 `memory_save` 返回路径 | [–] |
| W26 | P2 | `plugin-codegraph`：`store.ts:276` 损坏库重建时句柄未关即 unlink；`graph-view.ts:126` 边在过滤前 `LIMIT` 且不并入 truncated；`queue.ts:562` `status()` 每次全量构造；`index.ts:457` 每次工具调用 `await gitHead()` spawn | [–] |
| W27 | P2 | `plugin-ppt`/`plugin-pdf`：`writeFile` 非原子（`writeFileAtomic` 已导入未用）；渲染不看 `exec.signal`；`${target}.${pid}.tmp` 非唯一且失败不清理；`templates.ts:150` 首次扫描失败永久缓存空目录；`pdfd/read.ts:24` 单次可返回 2MB 文本；`index.ts:234` 返回插件安装绝对路径 | [~] |
| W28 | P2 | `plugin-mcp/src/mount.ts:129`、`plugin-hooks/src/mount.ts:36` `chains` 只增不删（已 settled 的 Promise 永留） | [x] |
| W29 | P2 | `plugin-client-ui` 性能：`whale-background.ts:495` 250ms 无条件 `getComputedStyle`+重建填色表；`settings-nav.ts:60` body 级 `characterData` 观察者被流式输出打满；`models-advanced/section.tsx:194` 每次 render 全量 clone + stringify | [–] |
| W30 | P2 | `plugin-market/src/client/{confirm-dialog,skill-detail}.tsx` 自绘 mask+card，违反 `plugins/AGENTS.md` §6（应用 `Modal`+`Button`）；`styles.ts:364,417,474` `.dshMkt-cardFoot` 定义三次互相冲突 | [–] |
| W31 | P2 | 测试缺口：`plugin-client-ui` 的 `models-advanced/*` 无覆盖（W13 全落在这里）、`plugin-hooks` 的 `native.ts` 四个拦截器无覆盖（W19）、`plugin-market` 的 `/uninstall` `/toggle` `/update` 无路由级测试 | [~] |
| W35 | P2 | `plugin-rewind/src/snapshots.ts:197,238-243`：隔离槽名是 `${stamp}-${Math.abs(hash(path))}`，`hash` 为 32 位 `31*h+c`。同一毫秒内两条路径的 `|hash|` 相同即复用同一槽，`created`/`replaced` 与 manifest 被覆盖——隔离副本丢失且无痕迹。`Math.abs` 让 `h` 与 `-h` 撞车，碰撞面翻倍 `[复核]` | [x] |
| W36 | P2 · 可用性 | `plugin-sidebar/src/git-routes.ts:172-177`：`gitEnv()` 只传 `PATH`+`HOME`（防父进程污染，正确），但 macOS 从 Finder 启动的 PATH 不含 `/opt/homebrew/bin`，`execFile('git')` 得 ENOENT → Git 标签页报 `git-missing`。不是注入面，是可用性 `[复核]` | [x] |
| W37 | P2 · 数据 | `plugin-presets/src/pack.ts:73,81`：dirent 判 `isSymbolicLink` 跳过之后，`stat`（`:81`）与打包时的 `readFile` 都跟随链接——窗口内被换成链接的普通文件会把工程外内容读进导出包。后果不是「大小不准」，是内容越界 `[复核]` | [x] |
| W38 | P2 · 硬化 | `scripts/lib/plugin-gates.mjs:475-482` 在缺 peer 的树上 SKIP 类型门禁（机制正确，代价已记录在 `:325-347`），但没有任何运行点断言「真的全跑了」；`npm run verify` 在有 peer 的树上应断言 `skipped === 0`。**不改成 fail-closed**：那会重演 `TS2307` 停发版 `[复核]` | [–] |

### OPT / 待裁决

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W32 | OPT | `plugin-presets` 导出 zip 内含明文 `.credentials.yaml`（注释写明有意，仅靠响应头提示）——是产品决策，需用户/Guard 裁决后再定 | [!] |
| W33 | OPT | `plugin-codegraph` 的 `graphs` Map 无淘汰（每个打开过的项目各留一个 SQLite 句柄） | [–] |
| W34 | OPT | nit 批量清扫：未使用导入、注释里的 order 陈旧（`maintenance/section.tsx:3`、`client.ts:326`）、市场 `api.ts:41` 非 JSON 抛裸 `SyntaxError`、UTF-16 截断切出代理对、`detect.ts` 文档与代码不符等 | [–]（不做理由：不影响行为，随下一次触碰该文件时顺手） |

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 0 复核 | W1–W22 中所有 `[报告]` 项 | 每条给出「复现成功（附命令/步骤）」或「证伪（附理由）」，落盘 `.devflow/suite-review-backlog/verify-<id>.md`；复现失败的一律降为 P2 或 `[–]` |
| 1 安全与不可逆 | W1–W7 | 条目全 `[x]`；Test plan 1–7 PASS；安全类经 Guard 复核（W2、W7） |
| 2 静默错数据 | W8、W10–W16、W20、W37 | 条目全 `[x]`；Test plan 8、10–16、17、31 PASS |
| 3 并发与超时 | W17、W18、W19、W22 | 条目全 `[x]`；Test plan 18–21 PASS |
| 4 资源上限 | W24、W27、W28 | 条目全 `[x]`；Test plan 24–25 PASS |
| 5 清理与一致性 | W9、W21、W23、W25、W26、W29、W30、W35、W36 | 条目全 `[x]`；Test plan 22–23、28–30 PASS |
| 6 测试缺口与可选 | W31、W32、W33、W38 | W31 完成并纳入 CI；W32 有裁决记录；W33 记结论；W38 在有 peer 的树上断言 `0 skipped` |

阶段闸门：任何条目处于 `[~]`/`[?]`/`[!]` 时不得开始下一阶段。条目 `[~]→[x]` 前必须回答四问（主张复核、
最小性、新风险、反例），并在 Phase log 记证据路径。

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| codegraph 的「变更检查」与「索引 pass」对超限文件判定一致 | modified | `plugin-codegraph/src/indexer.ts:394` |
| ppt 的祖先校验在目标不存在时继续向上，符号链接不能带出工程 | modified | `plugin-ppt/src/pptd-paths.ts:69` |
| 导出/编辑的目标文件已存在时要求显式确认；`pdf_edit` 拒绝源==目标 | added | `plugin-ppt/src/index.ts:463`、`plugin-pdf/src/index.ts:600` |
| skill 安装改名为内容判定，非本套件正文则不覆盖 | modified | `plugin-ppt/src/skill.ts:314`、`plugin-pdf/src/skill.ts:114` |
| 预设迁移写出的 YAML 保证可被 re-parse | modified | `plugin-presets/src/legacy-migration.ts:257` |
| `/archive-clear` 缺 scope 即 400 | modified | `plugin-memory/src/routes.ts:512` |
| 凭据过滤从黑名单改为「高熵 + 已知前缀 + malformed 同样检查」 | modified | `plugin-memory/src/memory-store.ts:192` |
| markdown 解析把 `---`/`+++` 只在首个 hunk 之前视为文件头 | modified | `plugin-sidebar/src/client/diff-ruler.ts:83` |
| `/uninstall` 拒绝 `@dsh-app/*` | modified | `plugin-market/src/routes.ts:1303` |
| rewind 快照与预览载荷加上限、隔离区有保留策略 | modified | `plugin-rewind/src/index.ts:592,1100`、`quarantine.ts` |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 超限文件的 freshness | 造一个超过体积上限的文件并索引，再跑两次 check | 第二次 `projectChanged` 返回 false，不再排 pass | `(cd plugins/plugin-codegraph && npm test)` 新用例 | pending |
| 2 (W2) | 符号链接越界 | 工程内建 `link -> ../outside`，请求 `link/newdir/x.page` | 抛「父目录越出 project_path」，外部目录不存在 | 新单测（临时目录 + symlink） | pending |
| 3 (W3) | 源==目标 | `pdf_edit` 传 `output_file === file_path` | 拒绝；源文件 sha 不变 | 新单测 | pending |
| 3b (W3) | 目标已存在 | 导出到已有文件且不带确认参数 | 拒绝并要求显式覆盖 | 新单测 | pending |
| 4 (W4) | 同名用户 skill | `$DSH_HOME/skills/dsh-ppt/SKILL.md` 写入非本套件正文 | 保留原文件并记日志；本套件旧版正文才覆盖 | 新单测（临时 home） | pending |
| 5 (W5) | 目录名带 `: ` | 用含 `: ` 的预设目录名做 legacy 迁移 | 写出的 `cordis.patch.yml` 可被 `parse()` 读回 | 新单测 | pending |
| 6 (W6) | 缺 scope | `POST /archive-clear` 不带 `scope` | 400，且撤销副本数量不变 | 新单测（路由） | pending |
| 7 (W7) | 凭据样本 | 12 类样本（AKIA/PEM/JWT/hex/URL 带密码…）写入卡片 | 全部拒绝；malformed 卡同样过滤 | 新单测 | pending |
| 8 (W8) | 装语法后重索引 | 先索引一个 unsupported 语言文件，再安装该语法 | 该文件被重新解析并出符号 | 新单测 | pending |
| 9 (W9) | 任意 cwd | `GET /graph?cwd=<未 adopt 的目录>` | 拒绝或只回 indexing，不落库 | 新单测 + `node scripts/probe-routes.cjs` | pending |
| 10 (W10) | 压缩炸弹 | 安装一个声明大小/解压后超限的 zip | 提前拒绝，进程内存不飙升 | 新单测（构造 zip） | pending |
| 11 (W11) | 瞬时失败 | 源第一次抓取失败、第二次成功 | 第二次仍在 6h 内重试，或旧 entries 保留 | 新单测（改 `catalog-cache` 期望前先定语义） | pending |
| 12 (W12) | 模型安装被拦 | 走对话路径安装一个需构建的包，再 `/allow-build` | 返回可放行的包名（不再 `notBlockedInstall`） | 新单测（路由 + bridge 共用 ledger） | pending |
| 13 (W13) | 路由切换竞态 | 抓取/保存中切换 provider | 新路由草稿不被旧响应覆盖；「恢复默认」后输入框清空；首次「添加」请求头出现 | 手工 `npm run dev` 三步 + 单测（store 层） | pending |
| 14 (W14) | 凭据读失败 | 让 `.credentials.yaml` 不可读后导出 | 导出带 warning，且提示缺该成员 | 新单测 | pending |
| 15 (W15) | 格式迁移 | 两个 session 都带旧 seq，触发一次迁移 | 两个都被清行重折，用量不翻倍 | 新单测 | pending |
| 16 (W16) | 首写前快照 | turn 首工具写文件，遍历仍在跑 | 快照要么等到遍历完成，要么报 `partial` | 新单测（注入慢遍历） | pending |
| 17 (W20) | 内容像文件头 | diff 内含 `-- x` 删除行与 `++i` 新增行 | 行号连续；两行都出现在标尺上 | `(cd plugins/plugin-sidebar && npm test)` 新用例 | pending |
| 18 (W17) | 参与者超时 | 让一个 participant 卡住 5s | 超时后其写盘被 abort，不出现「失败但文件已改」 | 新单测 | pending |
| 19 (W18) | 网络 errno | 让子代理启动抛 `ECONNRESET` | 归类 transport、自动重试；`watch.wait` 超时生效 | 新单测（注入 provider） | pending |
| 20 (W19) | 规则半生效 | 一个条目含 2 合法 + 1 非法规则 | 该条目整体不进入活动集 | 新单测 + `native.ts` 四个拦截器的 `next()` 断言 | pending |
| 21 (W22) | POSIX 进程树 | 在 Linux 上让安装超时 | pnpm 孙进程一并退出（`ps` 无残留） | CI linux 任务或本地 WSL | pending |
| 22 (W23) | 卸载套件 | `POST /uninstall {package:'@dsh-app/plugin-memory'}` | 拒绝，插件仍在 | 新单测 | pending |
| 23 (W30) | §6 违规 | 检视 market 两个对话框 | 使用 `Modal`+`Button`，无自绘 mask | 代码检视 + 手工 `npm run dev` | pending |
| 24 (W24) | 隔离区上限 | 反复 recall 直到超过阈值 | 自动修剪到阈值内并保留最近 N 个 | 新单测 | pending |
| 25 (W27) | tmp 唯一 | 并发两次导出到同一目标 | 不撞名、无 `*.tmp` 残留 | 新单测 | pending |
| 26 (W32) | 凭据导出 | 导出 config | 保持现状直到裁决；裁决后按结论落测试 | 待裁决 | N/A（待用户决定） |
| 27 (W31) | 测试缺口 | 新增 `models-advanced`、`native.ts`、market 路由级套件 | 四条命令全绿且纳入 CI | `npm test` | pending |
| 28 (W21) | 删除会话归档 | `DELETE` 一个 id，并让内核解析器返回的目录名与 id 不一致（可用 stub 注入） | 拒绝删除并记 `io/missing`，同项目其它会话仍在 | 新单测（stub `resolveCurrentLog`） | pending |
| 29 (W35) | 隔离槽碰撞 | 同一毫秒内两条 `|hash|` 相同的路径各 restore 一次 | 两个独立槽，两份隔离副本都在 | 新单测（注入固定 `now` 与两条路径） | pending |
| 30 (W36) | git 缺失 | PATH 不含 git 且平台为 darwin | 报 `git-missing`，诊断里带探测过的候选路径 | 新单测（注入 env 与 `execFile` 抛 ENOENT） | pending |
| 31 (W37) | 导出遇链接 | 预设目录内一个指向工程外的符号链接 | 导出包不含该目标内容；能力范围内直接拒绝 | 新单测（临时目录 + symlink） | pending |
| 32 (W38) | 门禁覆盖断言 | 在装了 peer 的树上跑 plugin-gates | 输出 `0 of N plugins skipped it`，否则退出码非 0 | `npm run verify` 内断言 + 新单测 | pending |

## Verification commands

- `npm run typecheck`
- `node scripts/plugin-gates.mjs plugins/<plugin>`（改动的每个插件）
- `(cd plugins/<plugin> && npm test)`
- `npm test`
- `node scripts/probe-routes.cjs`（W9、W12 等路由面）
- `node scripts/probe-codegraph-langs.cjs`（W8 触及语言行/样式时）
- `node scripts/probe-swarm-team-prompt.mjs`（W18 触及 prompt 段时）
- `npm run dev`（W13、W23、W30 等只能实机确认的项）

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| W32 presets 导出含明文凭据 | 产品决策（注释写明有意），需用户/Guard 裁决 | 裁决后转 W 条目 |
| W33 codegraph `graphs` 无淘汰 | 桌面端极少同时打开大量项目，收益低于风险 | 出现句柄耗尽或项目数异常见闻时 |
| W34 nit 批量清扫 | 不影响行为 | 触碰相关文件时顺手 |
| 工作台扩展契约的真实检验 | 套件目前没有域插件；契约要求「逐字复制」，字段拼错只在运行时从界面消失 | 第一个真实域卡片落地时补 drift 测试 |
| 工作台 `openView` 未注册 key 静默 no-op | 属可观测性问题，非错误 | 与上一个域卡片一起做（加日志或提示） |
| W24 其余两项（quarantine 保留策略、预览载荷上限） | 「保留多少隔离副本」是产品取舍，会改变用户能看到的历史 | 磁盘占用被报告，或预览慢到可感知 |
| W27 其余四项（原子写、`exec.signal`、`pdfd/read` 2MB、安装路径绝对化） | 原子写与 signal 都要渲染器配合，属渲染管线重构 | 取消长文档渲染后仍有输出现象 |
| 代码图谱的边截断无标志、`symbolGraph` 仍是过滤前 LIMIT | `fileGraph` 已改成过滤后取边，但边数被 `MAX_VIEW_EDGES` 砍掉时没有 `truncated` 标志；`symbolGraph` 的 1200 条 LIMIT 仍在 `.filter(known)` 之前 | 面板出现「连接缺失」的报告时 |
| W31 的 client-ui 组件测试与 market 路由测试 | 需要 react-dom 测试环境；本轮已补 hooks 的原子挂载与 recorder 的 trim 用例 | 建测试环境时一并做 |
| W38 verify 断言 `0 skipped` | 断言会让 CI 的 `--legacy-peer-deps` 树失败，必须与 CI 一起改 | 调整 CI 的 verify job 时 |
| 新 code 的客户端字典（`skill.tooLarge`、`backup.memberUnreadable`、`backup.memberNotRegular`、`preset.memberIsLink`） | 需要同时改 `MarketKey` 类型与 zh/en 两张表；这些 code 落在低频失败路径，`hostMessage` 的兜底会显示英文诊断 | 下一次触碰 market/presets 的字典时 |

## Rollback

- 每个 W 条目独立提交，回滚 = `git revert <sha>`；不夹带无关改动。
- 数据类（W3、W5、W6、W21、W24）改动前先在临时目录复现：涉及 `$DSH_HOME` 的用例一律用 `mkdtemp` 临时 home，绝不碰真实 profile。
- 已知坑：`plugin-rewind` 的两条源码读取测试对 CRLF 敏感（本仓已修，改动该文件时注意不要退回）；`plugin-market` 的 `catalog-cache.test.ts:241` 固定了 W11 的当前行为，改语义需同步改测试并说明。
- 环境：`plugin-client-ui` 的 React 类发现只能在 `npm run dev` 下确认；本机 npmjs 网络不稳，装依赖时用 `--prefer-offline`。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 0 复核 | 2026-10-31 | `.devflow/suite-review-backlog/verify-W{4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,21,22}.md`；W7 另有 `scratch/probe-cred.mjs` 实跑输出 | 18 条 `[报告]` 全部有结论：15 条确证（W4、W5、W7、W8、W10、W11、W12、W13、W14、W15、W16、W17、W18、W19、W22）、2 条证伪降级（W9、W21 → P2）、1 条裁决后转待办（W6：改为必填 `scope`）；W18 的 `watch.wait` 半条降 P2。无 `[!]` 残留，Phase 1 可放行——用户选择先审计划，暂缓进入。 |
| 1 安全与不可逆 | 2026-11-01 | `.devflow/suite-review-backlog/review-phase1.md` | W1–W7 修复完成。独立审查（guard，只读，未跑命令）提 4 条 P1 + 4 条 P2，逐条实测后：P1-1 面板仍发 `{}`（成立，已修）、P1-2 大小写/目录链接可绕过源文件比较（成立，改为 realpath + 大小写折叠）、P1-3 `\b` 让 `DB_PASSWORD=` 命中回归（成立，改 `(?<![A-Za-z0-9])`）、P1-4 marker 过新致旧正文刷不上（**证伪**：`git show v0.16.7` 已含 marker，仍改为 marker 集合作防御）；P2-1 `pptd_render` 缺 mkdir、P2-2 `pdf_render` 把路径冲突报成 needs_revision、P2-3 `assertInsideProject` 用未 realpath 的目录、P2-4 base64 规则误杀长路径，全部已修。测试：codegraph 375、presets 115（1 skip）、memory 193、ppt 168、pdf 119，全绿。 |
| 2 静默错数据 | 2026-11-01 | `.devflow/suite-review-backlog/review-phase2.md` | W8、W10–W16、W20、W37 完成。独立审查（reviewer，只读）提 3 条 P1：W8 只覆盖本进程打开过的项目（已改为 `knownProjects` + 临时开图 + `await` 重索引）、W11 失败行的 entries 没有读者且 304 会把 `failed` 写回（三处已修）、`draftEpoch` 在 `controller.load()` 之前自增导致保存后回退（已移到之后）；另修 P2：迁移轮先 drop 再读、witness 取最高版本、required 成员是链接也报错、`pack` 的 `lstat` 失败归类、被取消的 walk 释放 claim。新 code 的客户端字典与缓存 budget 两条记入 Deferred。测试：codegraph 375、market 406、usage 43、rewind 190、presets 115、client-ui 31、sidebar 59，全绿。 |

| 3 并发与超时 | 2026-11-01 | `.devflow/suite-review-backlog/review-phase3.md` | W17–W19、W22 完成。独立审查（reviewer，只读）提 1 条 P1：`AbortSignal` 只发到 context，而唯一的 participant 没读它（成立，已把 signal 贯通到 `revertFiles` 并加中止点与 `cancelled` 记录）；修 P2：内核 settle 路径只会给 `UNKNOWN`（已加入 TRANSPORT、保持不可重试，与 QUOTA 同构）、`RETRYABLE` 改为从 `TRANSPORT` 派生、W19 补原子挂载用例、`detached` 子进程加 exit 兜底。测试：hooks 38、swarm 40、rewind 190、market 406。 |
| 4 资源上限 | 2026-11-01 | 同 Phase 3 的证据目录 | **部分**：W28 完成（mcp/hooks 的链条在最后一次 enqueue 后释放）；W24 只做 `inFlight` 按 key 释放（并发抓取不再互删 blob）；W27 只做临时文件唯一化（同进程并发导出不再撞名）。其余子项在 Deferred，**未标 Gate 通过**。 |
| 5 清理与一致性 | 2026-11-01 | 同上 | **部分**：W21（`basename` 校验）、W23（`@dsh-app/` 守卫）、W35（隔离槽随机尾）、W36（macOS PATH 前缀）完成。W9、W25、W26、W29、W30 未做，理由见 Deferred；**未标 Gate 通过**。 |

| 6 全局复查 | 2026-11-01 | `.devflow/suite-review-backlog/review-final.md` | 第四轮是整批改动的全局复查（reviewer，只读）。两条 P1 都指向本轮新加的 `MAX_OPEN_GRAPHS`：淘汰让「图谱没打开」多了第二种含义（被淘汰），而 `changed` 与 `freshnessOf` 仍按旧含义读它 → 没变的项目答 `indexing` 且每次切回排一次全量 pass；淘汰按插入序是 FIFO 而非 LRU。两处已改为走 `graphFor`，并给命中分支加 touch。另修：`skills.ts` 超限时 `cancel()` 而非只 `releaseLock`（与 `catalog.ts` 一致）、两个 changeset 的 `shell` 改 `none`、删掉 `catalog-contract` 里硬编码版本的橡皮章断言与 `graph-view` 的死变量、recorder 的 `trim` 暴露 `trimmedThroughSeq` 并让 `coverageOf` 判 `partial`，补一条 trim 用例（rewind 191）。 |

| 7 真机启动 | 2026-11-01 | `scratch/dev-kernel-0.2.1-rc.5/runtime` 上的 `npm run dev` | 14 个插件 lib 全部按新版本重建 → 内核 host `ready (web transport)` 于 `127.0.0.1:7712` → renderer 建立两条 ESTABLISHED 连接（页面已加载并连上内核），进程无 crash、日志无 error。**界面行为仍需人工确认**：代码图谱对未 adopt 项目显示「还没有图谱」、市场确认弹层的 Esc/遮罩/焦点返回、模型设置的请求头表格、记忆归档清空。 |
