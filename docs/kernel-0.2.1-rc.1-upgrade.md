# 内核线 0.2.1-rc.1：适配清单、上游重复项与门禁结果

> 立项/执行 2026-10-16。上一轮（0.2.0-rc.1 → 0.2.0-rc.2）的记录在
> [`kernel-0.2.0-rc.2-adaptation-and-ports.md`](kernel-0.2.0-rc.2-adaptation-and-ports.md)，
> 流程判据在 [`agents/kernel-line-regression.md`](agents/kernel-line-regression.md)。本文只写这一轮新增的：
> 这次上游改**接口形状**的地方比前两轮多，五处直接打到我们的代码（四处编译期可见，一处是办公载荷的构建与启动契约）。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或配置；
> `[待验证]` = 推断。未标记的条目不得当成已验证。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh  → { alpha: 0.2.1-alpha.5, latest: 0.2.0-rc.2, next: 0.2.1-rc.1 }
本地检出 D:\codes\deepseek-harness → dsh-v0.2.1-rc.1（1600d8a1e1，rc.2..rc.1 共 1916 个提交）
我们的 spec：根 23 处 + 20 插件 peer/dev 合计 434 处 ^0.2.0-rc.2 → ^0.2.1-rc.1
```

`^0.2.0-rc.2` **不接受** `0.2.1-rc.1`：caret 范围内的预发布只有同一 `[major,minor,patch]` 才匹配。
因此这一步是显式换线，而不是 `npm install` 的自然结果。

---

## 1 接口断裂：五处 `[实测]`

前四处是**编译期可见**的，`npm run typecheck` 与各插件自己的 `tsc --noEmit` 直接报出；
第五处编译器看不见，它是构建与启动的契约，靠 `runtime:build` 自己停下才暴露。
没有一处是靠读 changelog 猜出来的。

| # | 上游变化 | 打到的位置 | 症状 | 修法 |
|---:|---|---|---|---|
| 1 | `SubagentRuntime.start()` 与 `startContinuable()` **移除**，统一为 `startActivation(spec)` + `waitForChildren(parent)`；返回 `{ childId, messageId?, result, dispose }`，并由 `delivery: 'parent' \| 'caller'` 决定结果送达方 | `plugins/plugin-swarm/src/orchestrator.ts` | `Property 'startContinuable' does not exist`、`Property 'start' does not exist` | 两条后端都改走 `startActivation`：可续后端 `delivery: 'parent'`（保持换线前的语义，子代理结束仍通知父级），一次性后端 `delivery: 'caller'`（结果只回工具）。子会话改由 `liveChildSession(ctx, childId)` 取，`dispose()` 换成激活自带的 |
| 2 | `SubagentStartRequest` **移除** `persona` 与 `toolFilter`，新增 `agentPreset`（角色与工具由 Agent Preset 统一表达） | `plugins/plugin-swarm/src/index.ts`、`src/expand.ts`、`src/orchestrator.ts`；`plugins/plugin-creative/src/role-tool.ts` | 同上（`toolFilter`/`persona` 不在类型里） | swarm：工具参数 `tool_filter` 换成 `agent_preset`，直传 `agentPreset`。creative：角色文本改随子会话首条消息进入，工具白名单改由内核自己的 `subagent/start` 边界施加（见 §1.1） |
| 3 | 槽注入的 `sessionId` 类型依赖 `ui-session` 的 `SessionStandardProps` 增强；缺这条增强时 `SessionIdOf` 退化成裸 `string`，而 `ctx.modelDirectories.directoryFor()` 要的是 branded `SessionId` | `plugins/plugin-effort/src/client/index.tsx` | `Argument of type 'string' is not assignable to parameter of type 'SessionId'` | 补 `import type {} from '@deepseek-ai/dsh-client-ui-session/client'`（AUGMENT 惯用法，不建立运行期边），并把该包写进 devDependencies |
| 4 | 包集合变化后，`plugin-rewind` 的编译单元里同时出现**两棵内核树**（插件本地 + 仓库根），且 zod 次版本偏斜（本地 4.6.7 / 内核 4.4.3） | `plugins/plugin-rewind/package.json` | `Property '[BRAND]' is missing`（本地 `UserMessage` 交给根树的接口）、`ZodType` 不可赋值（`_zod.version.minor 6 vs 4`）、`TS2589` 深度实例化 | `dsh-client-connection`（src 里本就是 type-only 导入）与 `dsh-agent`（经本地 `dsh-commands` 的类型链带出根树）写进 devDependencies；`zod` 的 devDependency 钉到内核自己的 `4.4.3` |
| 5 | **办公载荷的契约换了**：`scripts/check_office.py` 在 0.2.1 的检出里根本不存在，`@deepseek-ai/dsh-skill-office` 改成按 `SKILL_NAMES` 读 `<assetRoot>/<skill>/SKILL.md`（七个技能目录） | `src/main/desktop-host.ts`、`scripts/build-runtime.mjs`、两个根测试 | 不是 tsc 报错，是**构建与启动**都拒绝：`runtime:build` 在 `stageOfficeSkills` 抛 “no office payload”，外壳 `prepareOfficePayload` 会拒绝任何新载荷 | 外壳与构建脚本各存一份 `OFFICE_SKILL_NAMES`，按“七个 `SKILL.md` 是否齐全”判定载荷；完整性同时作为**重拷贝的输入**（半拷贝的树比源新，mtime 判不出来）。见 §1.2 |

### 1.1 creative 的角色限制为什么换到这个边界 `[静态]` + `[实测]`

`persona` 与 `toolFilter` 现在只剩“冷恢复时重放历史描述符”的地位
（`@deepseek-ai/dsh-subagent/lib/types/child-agent.d.ts` 的 `ChildComposition`），起子会话时无法再传。
上游给出的替代是 Agent Preset，而我们的七个角色是随包分发的一次性文本，不是用户可选的 preset。
所以角色由两条现成的缝承载：

1. **角色文本**进子会话的首条消息（`rolePrompt()`）；
2. **工具白名单**在 `subagent/start` 边上施加到子会话自己的 context（`applyPendingRole()` 调
   `ctx.tools.restrict()`，与内核 `applyChildComposition` 用的是同一个调用）。

第二条要求“边到之前就知道这个孩子是谁”。`subagent/start` 的载荷只有 `{ runId, provider, id, local }`，
不含 label，所以这个工具**自己预留 childId**（`startActivation` 的 `childId` 字段要求本地后端），
用 id 建表，边一到就查表并消费。时序上这是确定的而不是抢跑：`manager.startLocal` 在
`materialize()` 末尾发 `observer.start()`，**之后**才把初始消息投进子会话，所以限制一定在第一步之前生效
`[静态]`；`tests/role-tool.test.ts` 用真实的 `createCreativeRoleTool` 与 `applyPendingRole` 覆盖了这条路径
`[实测]`。

### 1.2 办公载荷：这轮最贵的一条 `[实测]`

`runtime:build` 的第一跑就停在这里：

```
Error: no office payload at D:\codes\deepseek-harness\packages\skill\skill-office\assets:
the desktop host refuses to start unless <primaryRuntime>/../office-skills holds scripts/check_office.py
```

去检出里找，`check_office.py` **一个都没有**（`find . -name check_office.py` 空），
`packages/skill/skill-office/assets/` 下换成了七个技能目录：`office`、`office-docx`、
`office-pptx`、`office-xlsx`、`office-render`、`office-recalculate`、`office-export-pdf`，
每个一份 `SKILL.md`。上游 `packages/skill/skill-office/src/index.ts:9` 的 `SKILL_NAMES` 就是这份清单，
`apply()` 对每一项读 `join(assetRoot, name, 'SKILL.md')`——缺一项就在组合期抛。

所以这个契约同时活在**四个地方**，全部改了：

| 位置 | 改法 |
|---|---|
| `scripts/build-runtime.mjs` 的 `stageOfficeSkills` | 不再认 `scripts/check_office.py`；按七项断言源目录，复制后再断言目标目录；`officeSkillsCheckout()` 选检出时也按“完整”而不是“目录存在” |
| `src/main/desktop-host.ts` 的 `prepareOfficePayload` | 同上。**并且**把“七项齐不齐”作为重拷贝的判据：半拷贝的树比源更新，mtime 判不出来，而数据目录里的载荷既不会被重装清掉、也不会被内核回滚清掉 |
| `test/host-arg-shape.test.mjs` 的假宿主与夹具 | 假宿主按新契约检查七个 `SKILL.md`；夹具造齐七项 |
| `test/office-payload-heal.test.mjs` | 夹具、断言、“半拷贝会重拷”的判据全部按新形状 |

**留下的耦合**：技能名清单在构建脚本与外壳各有一份，上游改名/增删技能就要跟着动。这是**跨进程契约**的
老问题（`argv[4]` 那一族），两处都写了注释指向 `SKILL_NAMES`；一旦上游改了而我们没跟，构建期就会红，
不会等到用户机器上。

---

## 2 与上游重复、冗余的部分

### 2.1 `schedule` / `ui-schedule` 的两条 insert —— 已删除 `[实测]`

换线前 overlay 直插这两行，理由是 0.2.0-rc.1 把它们移进了
`@deepseek-ai/dsh-experimental-schedule-bundle`，而本 profile 不列那个 bundle。0.2.1-rc.1 把它们放回了
web bundle 自己：

- `packages/bundle/web-app/cordis.patch.yml:140`（`dsh-schedule`）、`:398`（`dsh-client-ui-schedule`），
  两行都启用、都不带 `config`；
- 四个提醒工具与时钟读取改由 preset 组合声明（`packages/bundle/web-app/presets/standard.patch.yml:19,35`，
  `cordis` / `ptc` 同形；极简与子代理 preset 不带）——正是 changelog 那句“改为 Web 内置能力，提醒工具按模式提供”。

我们的 insert 在这条线上只能是**遮蔽**（loader 按 id 取最后一个），遮蔽的是一个一模一样的裸行，收益为零。
已删除（`plugins/dsh-app.patch.yml` 的 Schedule 段），并把理由写在原处。

**一个副作用要记住**：`dsh-time-context` 原本是我们**故意不挂**的（每个 pre-step 注入当前时间）。它现在随
preset 组合一起进来，我们不再有这个选择——opt-out 意味着改 preset 组合，而本仓库不做这件事。

### 2.2 上游的插件市场 vs `plugin-market` —— 保留，重叠面记录在此 `[静态]`

这一轮上游加了两样与 `plugin-market` 同面的东西：

- `feat(plugin-market): add the Custom plugin markets bundle and Discover tab`（3de3a977e0）——
  用户可加自定义插件索引源；
- 插件管理页的“让 Agent 创建插件”入口（同一批提交）。

我们的 `plugin-market` 除了索引源还有三件它没有的：技能目录（`market_search` / `market_install_skill`）、
一次性安装令牌（`src/install-intent.ts`，绑定目录行、拒绝重放与跨 profile 复用）、以及面板自己的队列与
本地/Git 开发副本的拒绝规则。**结论：保留，不合并**——这不是本轮接口适配的范围，也是产品形态决定；
但它现在是“两处能装插件”，写在这里，免得下一次有人重新发现。

边界已定，落在 [`plans/plugin-market-boundary.md`](plans/plugin-market-boundary.md) `[实测]`：
我们的市场是**主入口**（不因上游 Discover 降级）；已发布 bundle 的**发现**让给上游，技能目录与
一次性安装意图归我们；安装串行化由内核的 profile 写锁保证（两条路径都走
`runPluginCommand` → `withFileLock(<profile>/package.json)`，`packages/boot/plugin-manager/src/operations.ts:545`）；
退役要三条同时成立——上游 Discover 能装技能、具备一次性意图、覆盖本地/Git 副本的拒绝规则。

### 2.3 上游 Models 页的推理等级编辑 vs `plugin-client-ui` 的第 11 行 + `plugin-effort` `[静态]`

这一轮上游加了 `feat(models): edit reasoning levels of custom model API models`（f61d9982f8）。
`plugin-client-ui` 的“模型高级设置”是对同一份配置的另一个编辑面（`AdvancedModelsStore`），
`plugin-effort` 则是**运行期**在官方模型菜单的“推理等级”行上做拖拽轨道——查询与写入都走
`ctx.modelDirectories`，与官方座位同一个 store。

**结论：都保留**。`plugin-effort` 与上游的编辑面不重叠（一个是配置、一个是选择）；
`plugin-client-ui` 那一行与官方 Models 页的重叠在这一轮只是多了一个字段，属于既有布局，
是否收窄是另一件事（见 `docs/desktop-optimization-plan.md` §3.1 的行号表）。

---

## 3 负面证据：查过、确认未变 `[静态]`

按 kernel-line-regression §7.2 的要求写下来，下一次换线不必重查。

| 上游条目 | 结论 | 依据 |
|---|---|---|
| 移除运行时 invariant 插件与各包的 `./invariant` 导出 | 无关 | `grep -rn "invariant" plugins/*/src src/` 只命中注释散文，无导入 |
| 子路径插件的显示文本/图标改走 `<specifier>/icon` | 无关 | 我们的客户端半边是 `<包名>/client`，rc.2 与 rc.1 都解析不到 `…/client/package.json`（`readPluginMeta` 两版实现对比）；改动只影响导出了自己 `package.json` 的子路径插件，我们没有 |
| 第三方插件兼容性优先按 `engines.dsh` | 不新增该字段 | 我们的 20 个插件都已声明 `@deepseek-ai/dsh*` peer，且都随本行同步到 `^0.2.1-rc.1`；`unmetRequirements` 在 `engines.dsh` 缺席时逐个核对 peer，结果等价。加 `engines.dsh` 反而会让 peer 不再参与判断（`packages/boot/app-boot/src/plugin-compatibility.ts:53-62`） |
| 移除工具展示的 `both` 混合模式 | 无关 | 仓库内无 `'both'` 的工具模式配置（唯一命中是 OOXML 的 `w:jc="both"`） |
| 移除 `agent-instructions` 的逐行 `dshHome` 配置 | 无关 | overlay 不含 `agent-instructions` 行 |
| 输入区统计扩展拆成 `activity` / `usage` 两个入口 | 无关 | `plugin-usage` 只注册 `settings.section`，从未覆盖旧的 stats 整行 |
| 新增 `--public-url` / `--tls-cert` / `--tls-key` / 绑定地址、桌面端默认系统分配端口 | 无关 | `src/main/desktop-host.ts:641` 的 `webShapeArgs` 只发一个 Node 标志与五个位置参数，不含任何端口或 TLS 参数 |
| 客户端 `dsh.client.inject` 名单 | 全部可解析 `[实测]` | 20 个插件的每一条 inject 都在 0.2.1-rc.1 树里存在（逐个目录检查） |
| 各插件自己的 `cordis.patch.yml` 是否覆盖内核行 id | 无覆盖 | 只有 `plugin-rewind` 有一条 `- id: rewind`（自家行），其余全是 insert 自家包 |

---

## 4 门禁结果 `[实测]`

全部裸跑，执行于 Windows / Node v24.21.0 / pnpm 11.7.0。

| 门禁 | 结果 |
|---|---|
| `npm run typecheck`（外壳） | exit 0 |
| `npm run build` | exit 0 |
| `npm test`（根套件，含 `plugin-kernel-imports`） | 681 用例 / 679 pass / 2 skipped / 0 fail |
| `npm run check:graph` | `plugin graph: 20 plugins, followed line ^0.2.1-rc.1` — `ok — no violations` |
| `npm run check:slots` | 全部 `OK`，无 `unjudged` |
| `npm run check:suites:gate` | `no drift: every copy names the same set of plugins` |
| `npm run check:touchpoints:gate` | exit 0（七类均有命中） |
| 20 个插件的 `npm run build` + `npm test` | 20/20 绿；`plugin-creative` 417 用例、`plugin-swarm` 35 用例 |
| 20 个插件的 `tsc --noEmit` | 20/20 干净（`plugin-rewind` 需 `--max-old-space-size=8192`，见 §5） |
| `node --test test/host-arg-shape.test.mjs test/office-payload-heal.test.mjs` | 28 用例 / 0 fail（办公载荷新契约） |
| `npm run runtime:build` | 见 §6 |
| `npm run verify -- --tgz …` / `npm run check:plugins` | 见 §6 |

---

## 5 本轮新增的两条判据

1. **两棵内核树会让类型门红得不可能修。** 插件本地的 `node_modules` 缺某个包时，TS 会走到仓库根那一份；
   两份 `@deepseek-ai/dsh-*` 即使版本相同也是不同身份，`[BRAND]` 属性互不兼容，报出来的却是
   “参数不可赋值”——看起来像 API 变了，其实一行代码都没变。判据：报错里同时出现
   `plugins/<x>/node_modules/@deepseek-ai/…` 与 `dsh-app/node_modules/@deepseek-ai/…` 就是这一类。
   修法是补 devDependencies（不是改类型、不是加断言）。
2. **依赖钉死的包不能用 `^`。** `zod` 由内核**精确**钉在 `4.4.3`（`dsh-session-projection` 的
   `dependencies`），插件用 `^4.4.3` 装到 4.6.x 就会在 `ZodType` 的 `_zod` 内部形状上失配。
   插件侧 devDependency 跟随内核的精确值，peer 才用范围。

---

## 6 真内核验证与未验证项

### 6.1 产物与真机验证 `[实测]`

| 项 | 结果 |
|---|---|
| `npm run runtime:build` | 成功。`runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.1.tgz`，112.4 MB / 20948 文件；同批产出 `office-payload-win32-x64-0.2.1-rc.1.tgz`（70.5 MB，LibreOffice kit 0.1.2 / win32-x64） |
| 产物版本自证 | `runtime/app/node_modules/@deepseek-ai/dsh/package.json` 的 `version` = `0.2.1-rc.1` |
| 产物内容自证 | 含 `runtime/runtime/office-skills/office/SKILL.md`（新契约）、`runtime/runtime/office-skills/office-export-pdf/SKILL.md`、`runtime/app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` |
| `npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.1.tgz` | `smoke: all checks passed` —— 真内核起得来，每个插件的设置路由 200，客户端 bundle 非空，MCP 挂载链路通，websearch 走真实网络取到 sources |
| `npm run check:plugins -- --kernel <同一 tgz> --home scratch/e2e-home` | `通过 — 内核就绪，未命中失败信号`（就绪 4.5s） |

`check:plugins` 的第一次调用用了 `scratch/dsh-home`，那里只有 `web` 与 `node_modules` 两个 profile，
工具要的 `dsh-app` 不在，于是报的是“profile 不存在”——**这是调用参数错，不是内核问题**，
换成带 `profiles/dsh-app` 的 `scratch/e2e-home` 即通过。记在这里，免得下次再当成回归。

### 6.2 仍未验证 `[待验证]`

- **浏览器渲染面**：`scripts/probe-workbench.cjs` / `probe-routes.cjs` / `probe-settings-nav.cjs` 本轮**未跑**。
  `verify` 只证明到“路由 200 + bundle 非空”，客户端 slot 真的渲染不在它的覆盖面内
  （`agents/kernel-line-regression.md` §6.2）。而本轮改动了 `plugin-swarm` 与 `plugin-creative` 的 host 半、
  `plugin-effort` 只在类型层、`plugin-client-ui` 未动——渲染风险集中在办公栏与工作台容器的既有断言之外，
  但仍属未覆盖。
- **18 个未改动插件的运行期渲染**：与上一轮同形，未逐个判定。
- **`plugin-effort` 的注入面**：新增的 `ui-session` 类型增强只影响编译；运行期该插件不 import 它。
- **`plugin-market` / 上游插件市场的取舍**（§2.2）是产品决定，不在本轮验证范围。

---

## 7 收尾一轮：Office 收敛与模型页收窄 `[实测]`

换线完成后，产品侧定了两件事，执行记录如下。

### 7.1 Office：官方负责编辑，我们只留官方没有的

判定依据（`packages/skill/skill-office/assets/office*/SKILL.md`）：官方那套是**技能驱动的脚本执行**——
模型写 python-docx / python-pptx / openpyxl，经 `load_workspace_dependencies` 跑，渲染与导出 PDF 走
LibreOffice Kit。它比我们的 JSON 渲染器强在**编辑已有文件与保真**，代价是 Python 载荷 + Kit + 每任务多几轮脚本。

因此退掉 `plugin-doc` / `plugin-sheet`，保留两件官方没有的：

- `plugin-ppt`：模板化生成 + 导出前校验（`pptd_check` 定位文本溢出与遮挡），模板是本仓库的产品资产；
- `plugin-pdf`：`pdf_read` 读 PDF，`pdf_render` 带 CJK 字体子集，`office_to_pdf` 走应用自己的引擎。

套件从 20 个降到 18 个，五处名册同步（`plugins/dsh-app.patch.yml`、`scripts/kernel-line.mjs`、
`src/main/brand-suite.ts`、`scripts/smoke-suite.mjs`、`.github/workflows/release.yml`），
`npm run check:suites:gate` 报 `18 distinct names … no drift`。

顺带修掉的连带面：`scripts/check-plugin-graph.mjs` 的 Han 豁免目录（“office four” → “office pair”）、
`test/type-escape-ratchet.test.mjs` 的两条基线、`test/recursive-delete-guard.test.mjs` 的 AUDIT 计数
（103 → 84，两个插件套件随插件离开）、`test/plugin-graph.test.mjs` 的夹具、`scripts/smoke-suite.mjs`
的两条 mode 路由断言，以及 6 处指向已删文件的注释。

**刻意保留**：办公栏的 `OFFICE_FORMAT_ORDER` 仍写着 `ppt / word / excel / pdf`，chip token 仍含
`/dsh-word`、`/dsh-sheet`。这是**槽契约**不是名册：未知格式按插入顺序排在已知格式之后，留着它
既不影响当前两种胶囊，也不挡住将来某个 Word/Excel 面重新加入同一行。

### 7.2 模型高级设置：只保留官方页表达不了的字段

官方 0.2.1 把 Models 页扩到：provider 增删改、凭据、端点探测、模型增删、`contextWindow`/`maxTokens`、
输入模态、手写路由的推理等级（`ModelReasoningEfforts.tsx`、`ApiKeyInput.tsx` 均为本轮新增）。

于是我们的页面收窄为：

| 保留 | 理由 |
|---|---|
| 目录路由的 `modelOverrides`（全字段） | 官方明确把目录内模型的覆盖留给 `cordis.patch.yml`（`ModelsSection.tsx:504`） |
| compat 开关（19 个字段） | 官方没有任何 compat 编辑面 |
| 推理等级 + compat 自动填充 | 官方那份不碰 compat，私有网关缺 flag 时档位出现但请求失败 |
| 路由级高级参数卡 | 官方只覆盖 `baseURL` 一族，其余字段仍在 `settings.yaml` |
| models.dev 导入 / 端点探测 | 填已有行，官方无此数据源 |

移除：**新建路由卡**（官方「自定义提供方」已覆盖同一需求），以及手写路由上的
`contextWindow` / `maxTokens` 与输入模态编辑（官方已覆盖）。页面同时改写了两处过时文案
（原先写着“推理等级、输入模态由官方页留给 settings.yaml”，0.2.1 起不成立）。

改动的体量 `[实测]`：`section.tsx` 1152 → 831 行（删掉创建卡、`createRoute`、`startSplitRoute`、
`NewRouteDraft` / `EMPTY_NEW_ROUTE` / `cleanRouteValue` / `existingRouteKeys`，以及只为它们存在的
CSS），`locales.ts` 835 → 751 行（两张表各删 40 键，新增 2 键，键表严格配对），
`entry-editor.tsx` 里 `handDeclared === true` 的行走“只渲染推理 + compat”的分支。
`dshAma-newRoute*` 三个 CSS 类原本也被参数卡与折叠块复用，改名为 `dshAma-card*`，样式等价。

留下的**判断记录**：

- 模型清单的整表编辑（手动增删行、从 provider 获取、models.dev 导入/补全）保留。整表 `models`
  写入是本页对手写路由唯一的写入路径——compat 与推理等级的保存就走在它上面——所以写入路径不能退；
  **但“手动增删行”这两个按钮与官方页重复，属残余的冗余**，本轮没有删（删它要连带一个 locale 键与
  一次产物重建），记为下一轮的小改动，不算缺陷：它不误导、不损坏数据，只是多一个入口；
- `locales.ts` 里另有 33 个**本轮之前就没人引用**的键（`adv.retry.*`、`adv.reasoningCard.*`、
  `adv.headers.*`、`adv.undo`、`adv.pg.retry.hint`），已核对是历史遗留而非本次删除产生的孤儿，
  不在这一轮清理（与本次改动无关，单独一轮处理更干净）。

**未覆盖的一层**：`plugin-client-ui` 的四个测试套件都不渲染这个页面，本轮的验证只到
`tsc --noEmit`、`build.mjs`、`npm test`（31 pass）、grep 无残留与键表参照检查——**组件在真实窗口里的
渲染未验证**（`probe-settings-nav.cjs --section 模型高级设置` 属下一轮探针）。

### 7.3 产物与真机复核 `[实测]`

**上游在这轮工作期间发布了 `0.2.1-rc.2`**（`next` 标签于 2026-10-17T08:36Z 移过去）。后果有两条，都实测过：

- `^0.2.1-rc.1` **接受** rc.2（`semver.satisfies('0.2.1-rc.2','^0.2.1-rc.1',{includePrerelease:true}) === true`），
  所以 `runtime:build` 解析 `next` 时会拿到 rc.2 —— 而本地检出仍是 rc.1，构建守卫直接拒绝：
  `host source at … is 0.2.1-rc.1, but this runtime ships dsh 0.2.1-rc.2`。这条守卫是对的，不是缺陷。
- 因此本轮产物**显式钉在 rc.1**：`DSH_VERSION=0.2.1-rc.1 npm run runtime:build`。要跟 rc.2 是**下一轮**
  （改 spec、重装、重跑门禁、复核是否有新的接口变更），不在本轮范围。
- **钉版本也只能撑到 rewind 改动之前**：子包规格是范围（`^0.2.1-rc.1`），pnpm 仍会解析到 rc.2，
  守卫报 `lockfile resolved @deepseek-ai/dsh-client-store@0.2.1-rc.2, but this runtime ships dsh 0.2.1-rc.1`。
  所以下表这份产物是 **rewind 0.1.4 时期**的，不含 `plugin-rewind@0.1.5`；rewind 那轮的产物闸门因此
  **未通过**（`docs/plans/rewind-undo-parity.md` 的 Phase 3 记了同一条）。补全要么升到 rc.2，要么给构建
  加“精确钉住子包版本”的模式。

| 项 | 结果 |
|---|---|
| `npm run runtime:build` | `dsh-runtime-win32-x64-0.2.1-rc.1.tgz`，111.8 MB / 20934 文件；`manifest.json` 的 `suiteVersion` = `7899ebd7`，与 `computeSuiteVersion()` 一致 |
| 产物名册 | `node_modules/@dsh-app` 下 19 项 = 18 个插件 + `suite-layer`；`grep plugin-doc\|plugin-sheet` 命中 0；`plugin-client-ui` 的版本是 `0.5.2` |
| `npm run verify -- --tgz …` | `smoke: all checks passed` |
| `npm run check:plugins -- --kernel … --home scratch/e2e-home` | `通过 — 内核就绪，未命中失败信号`（4.5s） |

**第一次 `check:plugins` 是红的，原因值得记下来**：`scratch/e2e-home` 是一个旧 profile，
它的 `node_modules/@dsh-app/suite-layer` 还是上一轮写的内容（仍指名 doc/sheet），`@dsh-app` 下也还留着
那两个包的**悬空链接**（源目录已删）。内核按那份层组合，于是报 `failed to import … plugin-doc`。
这不是产物缺陷：

- 真实启动时外壳每次都会用**出厂 overlay** 重写层（`src/main/suite-layer.ts:699` 的 `writeLayerPackage`）——
  直接调 `installSuiteLayer` 复现这一步后，层里已经没有那两行；
- 外壳只按当前名册建链接、**不清理已退役插件的链接**（`src/main/brand-suite.ts:187` 的 `linkSuitePlugins`），
  悬空链接会留在 profile 里。没有行再指名它们，所以不影响启动；这一轮手工删掉悬空链接、补上 18 个链接后，
  `check:plugins` 通过。

留给下一轮的问题：**退役插件在用户 profile 里的悬空链接无人清理**。它不报错、不加载，只是磁盘上的死目录；
是否在 `linkSuitePlugins` 里顺手 prune，取决于是否愿意让外壳删除 `@dsh-app` 下不属于当前名册的条目
（那会连带删掉用户自己放进该 scope 的包），所以本轮只记录，不改。

dev 内核已按新产物重解包到 `scratch/dev-kernel-0.2.1/runtime`（`dshVersion 0.2.1-rc.1`、
`suiteVersion 7899ebd7`、办公载荷七技能齐全），`npm run dev` 会挑中它。

---

## 8 跟进到 0.2.1-rc.2 `[实测]`

rc.1 交付当天的 08:36Z，上游发布了 rc.2（`dsh-v0.2.1-rc.2`，rc.1 之后 9 个提交、456 个文件、+4921/−845）。
跟随同一 patch 的预发布是这条线的自然结果，于是整线挪到 rc.2。

### 8.1 rc.2 真正变了什么

456 个文件里绝大多数是发布提交带来的版本号刷新，功能性变化只有两处，都在 web：

- **新增 `@deepseek-ai/dsh-web-deepseek-api`**（base bundle 的 `web-deepseek-api` 行）：注册
  `deepseek-search-api` 与 `deepseek-fetch-api` 两个 provider，**直连 DeepSeek 的 Search / Fetch API**
  （文章里的 5 元 / 千次那两个接口），不再经过一次辅助模型轮次；与旧的 `deepseek-official`
  （`web-search-deepseek`，Messages API + 原生 `web_search_20250305`）并存。
- `dsh-web` 的 `searchProvider` / `fetchProvider` 改为 **Volatile**（每次操作读当前值），
  所以设置页切换不需要重挂 provider；`web-search-deepseek` 的请求补了 `thinking: { type: 'disabled' }`
  （辅助轮次的推理 token 无人消费）。

`web` 行的默认值没变（仍是 `deepseek-official` / `http`），所以我方 overlay 的
`searchProvider: dsh-app` / `fetchProvider: dsh-app-fetch` 继续有效。

### 8.2 适配量：零代码

| 项 | 结果 |
|---|---|
| spec | 19 个 manifest、393 处 `^0.2.1-rc.1` → `^0.2.1-rc.2`；根与 18 插件的 `node_modules`/lockfile 全清重装 |
| 子代理 | `startActivation` / `SubagentActivationSpec` 未变（`packages/subagent/subagent/src` 在 rc.2 的 diff 为空） |
| 会话槽位 / 设置页 | `ui-settings-general` / `ui-settings-models` 无改动；`check:slots` 21 条仍全 OK |
| 压缩检查点 | `compact-checkpoint` 的写入形态未变（`checkpoint.ts:19,50`），rewind 的边界逻辑不受影响 |
| 唯一需要动的代码 | `plugin-websearch` 认识新 provider：`deepseek-search-api` 有自己的名称，并与旧的官方 provider 一样显示计费提示（`0.2.0` → `0.2.1`） |

### 8.3 门禁与产物 `[实测]`

- 根 `npm run typecheck` exit 0；`npm run build` exit 0；18 个插件 `tsc --noEmit` 全部干净、build 与单测全绿。
- 根套件 **681 / 679 pass / 2 skipped / 0 fail**。**失败过一次**：与插件的 build/test 并发运行时出现
  654/649/3 fail（`dist/`、`lib/` 正被写），串行重跑即绿；记为偶发，不是回归。
- `check:graph`（`18 plugins, followed line ^0.2.1-rc.2`）、`check:slots`（21）、`check:suites:gate` 全过。
- 产物：`runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.2.tgz`，111.8 MB / 20949 文件，
  `manifest.suiteVersion` = `b977c4b7`；配套 `office-payload-win32-x64-0.2.1-rc.2.tgz`。
- `npm run verify -- --tgz …` → `smoke: all checks passed`；`check:plugins --kernel … --home scratch/e2e-home`
  → 通过，就绪 5.0s。**§7 里 rewind 那轮挂起的产物闸门由此闭合**（新产物含 `plugin-rewind@0.1.5`）。
- dev 内核已按 rc.2 产物重解包到 `scratch/dev-kernel-0.2.1/runtime`。

### 8.4 仍未做

- 真机压缩会话（`docs/plans/rewind-undo-parity.md` 第 10 条）仍未跑；现在 dev 的内核与套件都是 rc.2 / 最新版，
  可以直接验：`/compact` 后 `/rewind` 应说“已压缩、没有可撤回的消息”，再发一条后应说“列表止于压缩边界”。
- 用户机器上的 home 层把 `web-search-deepseek` 写着 `disabled: true`（2026-09 的取舍）；这一轮按用户要求改成
  `disabled: false`，并把 profile 的 `searchProvider` 指向新的 `deepseek-search-api`。那是**机器本地配置**，
  不在仓库里，记在这里以便下次排查“官方搜索为什么不可用”。

---

## 相关文档

| 文档 | 用途 |
|---|---|
| [`agents/kernel-line-regression.md`](agents/kernel-line-regression.md) | 换线的流程、判据与常见误判 |
| [`kernel-0.2.0-rc.2-adaptation-and-ports.md`](kernel-0.2.0-rc.2-adaptation-and-ports.md) | 上一轮的调研与台账 |
| [`agents/profile-supply-chain.md`](agents/profile-supply-chain.md) | 用户机器上的 profile 供应链 |
