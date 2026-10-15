# 内核线 0.2.1 预适配：alpha.3 变更映射与可先行项

- Status: draft
- Plan date: 2026-10-11（alpha.2 面）／2026-10-13 复核至 alpha.3
- 上游检出：`D:\codes\deepseek-harness`，工作树 = `dsh-v0.2.1-alpha.3` + 16 提交（干净树）

**证据标记**：`[实测]` = 命令真跑过（本轮全部结论来自在上游检出里真跑的 `git` 命令，以及消费方仓库里的 grep）；
`[静态]` = 源码或配置阅读；`[待验证]` = 推断未执行。**任何条目标记为未验证时，不得据此下"已适配"的结论。**

## Goal

在官方 rc 版发布之前，把本仓库对 0.2.1 线的适配面摸清并**先做无风险的部分**，使正式换线时
只剩「升版本号 + lockfile 重建 + 跑门禁」。

成功标准：下表 P0 项落地后，`git grep` 里不再有已删除内核 API 的引用；换线日按
`docs/agents/kernel-line-regression.md` 走完门禁即可交付。

---

## 事实基线

### A. 本轮复核口径 `[实测]`

- 上游 delta：`git log --oneline dsh-v0.2.1-alpha.2..dsh-v0.2.1-alpha.3` = **852 提交**
  （673 个非 merge）；`git diff --shortstat` = 3311 文件、+120978 / −16632。
- 包清单：`packages/*/*` 目录 **498 → 503**，新增 5 个、**删除 0 个**：
  `api/remote-access`、`client/ui-secret-mask`、`context/harness-dev-context`、`experimental/cua`、
  `experimental/cua-macos`。没有包被退役——这也意味着"名字没了"这类断裂在 alpha.3 不成立。
- 版本面：alpha.3 树里 336 个 workspace 包**全部**是 `0.2.1-alpha.3`（另 2 个是 `1.0.0`）；
  vendored `cordis` 为 **`4.0.5-alpha.2`**（我们根 `package.json` 现在钉 `^4.0.4`）。
- **升级指南的可得性（本轮最重要的一条方法论发现）**：alpha.3 树里**没有**
  `docs/upgrade-guide/v0.2.1-alpha.3/` 目录。而在 a2→a3 这个窗口里，上游**补写了 14 篇更早版本的
  指南**——10 篇进 `v0.2.1-alpha.2/`、3 篇进 `v0.2.1-alpha.1/`、1 篇进 `v0.2.0-rc.2/`。
  后果有两条：① 上一轮（在 alpha.2 检出上）读到的"18 篇指南"漏掉了这 14 篇；② 换线到 rc 时
  **不能只读 rc 目录的指南**，必须同时对源码 diff 复核，否则会漏掉像
  `subagent-preset-composition` 这种被补写的破坏性变更。

### B. alpha.2 基线（2026-10-11 核对；本轮在 alpha.3 上逐条复验，结论全部仍然成立 `[实测]`）

- 本仓库对内核的真实接触面：
  - `ctx.subagents`：`startActivation` / `sendMessage` / `interrupt(targetSessionId, authority)` 在位；
    `SubagentInterruptAuthority` 的 `ancestor` 变体不变；`subagent/end` 仍按 activation epoch 发布。
  - spawn provider capabilities、`maxActiveSubagents` 配置键在位——overlay 的 `subagent` 行不用动。
  - `defineTool` 的 `presentCall` / `presentResult` / `presentationMeta` / `isConcurrencySafe` 全在。
  - `ctx.web` seam、`registerSearchProvider` / `registerFetchProvider` 不变——websearch 不用动。
  - Connection exact-Fetch `register(route)` 契约、config editor 的 `fiber.entry` 锚点不变。
  - 客户端槽 `conversation.chat.commandview`（rewind 用）、`conversation.view`、`settings.section`、
    `sidebar.footer.action`、`conversation.chat.node` 全部还在。
  - primitives：`Modal` / `Button` / `Tooltip` / `Toast` / `DiffBlock` / `RiskConfirmation` 导出不变。
  - `ImageLightbox` 的标记已重构成 `.stage` 内嵌关闭钮——915837f 注入的
    `[class*="_backdrop"] > [class*="_close"]` 自动失配、自动失效，「无需清理」成立。
  - `tool-subagent-control` 的 `send_message` / `interrupt_agent` / `list_agents` 照旧。

### C. alpha.2 → alpha.3 增量 `[实测]`

**C1（破坏，唯一一处）subagent 组合改为由 Agent Preset 拥有。**

| 面 | alpha.2 | alpha.3 | 依据 |
|---|---|---|---|
| `SubagentStartRequest` | 有 `toolFilter?: ToolRestriction`、`persona?: string` | **两者已删**，新增 `agentPreset?: string` | `subagent/src/types.ts` diff |
| `SubagentCapabilities` | 5 项：`agentOptions`/`outputSchema`/`depthLimit`/`toolFilter`/`persona` | **4 项**：`agentOptions`/`agentPreset`/`outputSchema`/`depthLimit` | 同上 |
| spawn provider | 5 项（含 toolFilter/persona） | `agentPreset: true`，4 项 | `subagent-spawn-in-process/src/index.ts:39-44` |
| fork provider | 5 项 | `agentPreset: false`（显式不支持），`inheritsParentContext` 仍 `true` | `subagent-fork-in-process/src/index.ts:61-66` |
| `dsh-tool-subagent` Config | `provider`/`toolName`/`modelSelectionSettings`/`agentOptions`/**`persona`**/**`toolFilter`**/`maxDepth` | 去掉两个旧键，加 **`agentPreset`** / **`allowedAgentPresets`** | `tool-subagent/src/index.ts:81-98` |
| 加载期行为 | 静默接受 | **`persona` / `toolFilter` 一旦出现即抛错**（`apply` 改为 async，加载失败，不是忽略） | `tool-subagent/src/index.ts:146-154` + 指南 `subagent-preset-composition` |
| 新增模型可见参数 | — | `agent_preset`；新增 system-prompt 段 `tool:<name>:depth` | `tool-subagent/src/index.ts:236-240,383-392` |
| 预设里的 `toolFilter` | `standard`/`ptc`/`cordis` 三份 × 2 行各带 `deny: [schedule_create, schedule_delete, schedule_list, schedule_update]` | **全部删除**（改成"工具仍可见，但执行被拒"） | `presets/*.patch.yml` diff |
| `minimal` 预设 | — | 新增 `tool-fs`（只读）与 `compaction` 组 | `presets/minimal.patch.yml` diff |

**未变的那一半（负面证据，同样重要）**：`startActivation` 的两个重载、入参
`SubagentActivationSpec`（`provider`/`label`/`childId?`/`request`/`signal`/`delivery: 'parent'|'caller'`）
与出参 `SubagentActivation`（`childId`/`messageId?`/`result`/`dispose()`）**与 alpha.2 逐字一致**；
`lifecycle.ts` 在 a2↔a3 **逐字节相同**；`subagent/src/index.ts` 的 diff 只有三处
（`BrowserPromptSource` 加 `principal`、加 `agentPreset` 能力校验分支、删 `toolFilter`/`persona`
两条能力校验）；provider 的 **`prepareContinuable` 仍然存在**，且仍是本地／外部后端的判据
（`subagent/src/index.ts:271,281,549,590`）。

**C2（新增）客户端座位：94 → 98。** 新增 5 个、无退役、1 个改名 `[实测：a2/a3 的生成物
`extensions/cordis-client-runner/src/client/slot-catalog.ts` 求差]`：

- 新增 `conversation.chat.message.images`、`conversation.chat.user.images`、
  `conversation.hero.options`、`conversation.user.text.node`（`inline: true`）、`workspace.toast`；
- `conversation.message.images` → **改名** `conversation.chat.message.images`（同一声明者
  `conversation.chat.flow`、同一 occupant）；
- **我们注册的 8 个座位在 a2 与 a3 都在**，`settings.dsh-app-maintenance.tab` 除外（我们自己声明）。
- `ui-slots/src/index.ts` 只加了一个可选字段 `inline?: true`；`ctx.slots.register/inject` 签名与语义未变。
- `ui-primitives/src/index.ts` 只有两处：新增 `HoverCardGroup`；
  `projectUserText` / `UserTextReferences` 换成 `UserTextRun` / `ReferenceChip`（我们都没用）。
  `Modal` / `Toast` / `DiffBlock` / `ImageLightbox`(.tsx/.module.css) 在 a2↔a3 **逐字节相同**，
  `Tooltip` 只有 4 行 JSDoc 改动。

**C3（新增）组合树里新增行，无删除。**

- `base/cordis.patch.yml`：新增 `remote-access`（`@deepseek-ai/dsh-api-remote-access`）；`authorization`
  行只改了注释（凭据来源顺序见 C6）。**没有任何 id 被删或改名。**
- `web-app/cordis.patch.yml`：新增两行——`harness-dev-context`（:211-212）、
  `ui-secret-mask`（:388-389）。`schedule`(:140) 与 `ui-schedule`(:399) 两行**在 a2 上就已经存在**
  （a2 对应 :140 / :390），所以 overlay 注释里"0.2.0-rc.1 两个都不带"的前提对 0.2.1 线已过时，
  我们的 insert 在这条线上同样与上游自带的行并存（rc.2 上已实测为无害：同 id 后写者胜）。
- `profileContext?.name === 'desktop'` 的 guard 未变（`base:123`、`web-app:47,59,298`）。

**C4（负面证据）桌面注入面：21 条外壳侧锚点 + 17 条插件侧锚点在 a2↔a3 的命中数完全一致。**
唯一变化是 `data-slot` 15 → 17（纯增量）。逐条计数覆盖：`logoRow`、`titleRow`、`centerCol`、
`frame`、`data-shortcut-modal`、`footerActions`、`navList`、`navLabel`、`data-composer-card`、
`data-chat-flow-kind`、`data-chat-turn`、`data-clock`、`data-phase`、`data-slot`、
`--dsh-frame-chrome-top`、`--dsw-specific-sidebar-fill`、`--dsw-menu-surface-fill`、`theme-color`、
`data-ds-dark-theme`、`aria-haspopup`、`triggerEffort`、`cellValue`。
`ImageLightbox.tsx` / `.module.css` 的 a2↔a3 diff **为空**——那条 `[class*="_backdrop"] > [class*="_close"]`
规则的失配**早于 alpha.2**，不是 alpha.3 的回归。

**C5（负面证据）设置页序号未变。** 上游 `settings.section` 的 `order` 仍是 `0 / 10 / 15 / 20`
（`account` 为 `-10`），与我们占用的 `11/12/13/14/19/21/22/23/24/26` 无冲突。

**C6（用户可见行为变化，归上游）** `packages/credentials/credentials-local/src/index.ts` 大改
（108 行）：`$DSH_HOME/.credentials.yaml` 里的条目现在**优先于**导出的环境变量，`.env` 两级仍排在其后。

**C7（附带）`apps/cli` 面。** `apps/cli/package.json` 在 a2↔a3 只有版本号一行变动；
`apps/cli/src/plugin.ts`（marketplace 调用的 `dsh plugin add/remove`）**未变**；
`args.ts` 只改了帮助文案与选项描述；`profile-boot.ts` 的 `--from-default-profile` 语义从
"目标已存在则拒绝"改为**整体替换**。`apps/desktop-host` 只改了 package.json 与
`platform-session.ts` 的 2 行 → `profile: 'desktop'` 的行为未变。

---

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | **swarm 移植到 activation 模型**（`plugins/plugin-swarm/src/orchestrator.ts:824`）。修订要点：**(a)** `ctx.subagents.startContinuable` → `startActivation({ provider, label, request, signal, delivery: 'caller' })`，结果从 `activation.result` 收（`SubagentActivation` 与 alpha.2 逐字一致），收完 `dispose()`。**(b)** `ctx.subagents.start`（`orchestrator.ts:919` 的 `runOneShotTask`，函数体在 `:896`、调用点 `:1149`）在这条线上不存在 → 该函数与其调用点一并删除。**(c)** `provider?.prepareContinuable` 的**两处判断保留**（`index.ts:697` 的 `resume_entries` 预检、`orchestrator.ts:1031` 的 `continuable` 分支）——alpha.3 里 provider 的 `prepareContinuable` 仍在，作用从「选启动 API」变成「选结果收敛方式」。**(d)** 请求里的 `toolFilter` 见 W13。同步改写 `tests/swarm.test.ts` 的 one-shot 桩。 | `[ ]` 换线日现场移植（用户拍板方案 b） |
| W2 | P0 | **清 `backgroundMode` 残留**：`$DSH_HOME/cordis.patch.yml` 已删（alpha.1 已移除该键，alpha.3 源码零命中 `[实测]`）。**2026-10-11 已完成**。 | `[x]` 2026-10-11 |
| W3 | P1 | **home layer 的 tool-subagent 覆写行整行删除**。**2026-10-11 已完成**；本轮复核 `$DSH_HOME` 三层补丁里 `toolFilter` / `persona` / `backgroundMode` 全部 0 命中 `[实测]`。**这项从"减少冗余"升级为硬要求**：alpha.3 的 `tool-subagent` 对这两个键是加载期抛错（见 C1），残留即启动失败。 | `[x]` 2026-10-11，2026-10-13 复核 |
| W4 | P1 | **`tool-presentation-mode`**：`mode` 只收 `native\|ptc`，`both` 被拒。我们的 overlay 未设 `tools.mode`——**无需动作**，记录在案防回归。 | `[–]` 无需改 |
| W5 | P1 | **`experimental-package-composition`**：我们的 overlay 以 insert 直挂 `schedule` / `ui-schedule`。**修正上一轮的证据**：`@deepseek-ai/dsh-schedule` 确在 `apps/cli/package.json:55`，但 `@deepseek-ai/dsh-client-ui-schedule` **从来不在 `apps/cli` 里**（a2 与 a3 的 apps/cli 逐字节相同，`:80` 是 `@deepseek-ai/dsh-tool-schedule`）。ui 半的解析锚点是 `packages/bundle/web-app/package.json`（alpha.3 的 `:101`，alpha.2 的 `:96`），而 `apps/cli/package.json:88` 依赖 `@deepseek-ai/dsh-web-app` 构成传递闭包。换线日重跑 `check:plugins` 并显式检索启动日志里的 `patch: entry … not found`。 | `[–]` 无需改，换线日复验 |
| W6 | P2 | **新 Session 语义**（`new-session-generations`）：我们没有任何代码依赖「复用空白会话」。无需动作。 | `[–]` 无需改 |
| W7 | P2 | **working-directory**：`{{cwd}}` 提示变量移除。我们注入的系统提示/技能文档不用 `{{cwd}}`。无需动作。 | `[–]` 无需改 |
| W8 | P0 | **版本面**：全部 `@deepseek-ai/*` spec 从 `^0.2.0-rc.2` → `0.2.1-alpha.3`（该线 336 个包同版本 `[实测]`），`@deepseek-ai/cordis` 从 `^4.0.4` → `4.0.5-alpha.2`，lockfile 重建（换线必须清 root `node_modules/`）；`docs/kernel-0.2.0-rc.2-adaptation-and-ports.md` 的「检出在 rc.2」基线更新为 alpha.3。**此项等 rc 版**——alpha 范围内上游还可能再动。 | `[!]` 待 rc 发布 |
| W9 | P2 | 上游检出构建问题（tsdown 根包入口 `lib/types/{index,startup}.js` 无人生成、client face 767 条 test-spec 类型错）反馈上游或等 rc 修复；`tsdown --config-loader native --env.DSH_BUILD_FACE client` 是当时可用的绕过。**alpha.3 上未复核** `[待验证]`：检出已有 2.1G `node_modules`，最短验证路径是在该检出里跑 `pnpm run build`。 | `[ ]` |
| W10 | P1 | **真机验证 W2/W3**：下次 rc.2 启动确认——① 无 `backgroundMode` 相关报错；② 会话里 `subagent`/`subagent_fork` 工具照常出现；③ 委派一个子智能体，descriptor 仍为 `mode: continuable`。 | `[ ]` 用户下次启动 |
| W11 | P0 | **overlay 增加 `harness-dev-context` 禁用行**（换线日）。alpha.3 的 web-app bundle 新增该行（`web-app/cordis.patch.yml:211-212`），而我们的 desktop profile 列了 `@deepseek-ai/dsh-web-app` `[实测：profiles/dsh-app/package.json]` → 换线后它会挂上，把**内核检出路径**与 **GUI URL** 作为 runtime context 送进模型，并附一段 `pnpm run dev:web` 的 HMR 说明。上游 README 自己写的处置就是"在 profile 补丁里禁用这一行"。**不现在加**：rc.2 线没有这个 id，提前加会在每次启动留一条 `patch: entry "harness-dev-context" not found`（本仓库把这类行当噪声，见 §8 第 8 条）。换线日与 W1 一起做。 | `[ ]` 换线日 |
| W12 | P1 | **`ui-secret-mask` 新行判定为保留**（换线日无需动作）。alpha.3 的 web-app bundle 默认挂它（`web-app/cordis.patch.yml:388-389`），对**已发送**的用户文本做显示层凭据掩码（保留前 8 字符），不改消息文本、复制内容与模型输入。它与我们 `plugin-websearch` 的 `VALUE_MASK` 哨兵通道是**不同平面**（那是宿主回传的设置页掩码值），不共享座位也不共享代码。它占的是 C2 新增座 `conversation.user.text.node` 的 `key='secret'` 格。保留即可：对一个会截图外发 UI 的公开客户端是净收益。 | `[–]` 无需改，记录防回归 |
| W13 | P0 | **swarm 工具面 `tool_filter` 的去向（本轮唯一需要用户拍板的产品面决策）**。我们的 `swarm` 工具有**模型可见**的 `tool_filter` 参数（`plugin-swarm/src/index.ts:526-540`，描述里明写"for read-only batches (analysis, review, lookups) pass tool_filter to scope every child to read/search tools only"），一路透传到 `startContinuable`（`index.ts:746`、`orchestrator.ts:831`、`:925`）。alpha.3 **删掉了 `SubagentStartRequest.toolFilter`**，且**没有-per-child 工具过滤的替代物**——新的等价物是 `agentPreset`（预设拥有 persona 与工具组合，`tool-subagent` 新增 `allowedAgentPresets` 供模型挑）。两条路：**(A) 删参数 + 同步改工具描述**，只读批次改由 preset 承担（swarm 的 overlay 已钉 `provider: spawn`，而 spawn 支持 `agentPreset: true`；代价是我们要提供一个只读 preset，并在 swarm 上加一个 preset 配置项）。**(B) 自己实现过滤**——但子会话的 ctx 在 kernel 内部创建，swarm 没有介入窗口；option B 是否可行**未验证** `[待验证]`。**关键：不能只删参数不改描述**，否则模型会继续按旧文案调用一个已不存在的旋钮。 | `[ ]` 换线日，需用户拍板 A/B |
| W14 | P1 | **profile 里 `llm-deepseek-account.models` 的硬失败检查**。alpha.3 的模型目录改由账号 `GET /models` 供给；该行若残留 `models` 字段，**插件在加载期直接失败**，桌面与 Web 都不显示账号模型。本轮实测：本机 4 个 profile 里的 `models:` 全部落在 `- id: llm-deepseek` 行上（`profiles/dsh-app:1082`、`profiles/web:1080`），**没有**挂在 `llm-deepseek-account` 上 → 当前无需动作。**换线日复跑这条检查**（Models 页会写这个文件，用户动过就可能出现）。 | `[–]` 已查无问题，换线日复查 |
| W15 | P2 | **`stored-credentials-precedence`（归上游，但用户可见）**：见 C6。外壳把 `{...process.env}` 传给内核子进程，因此"导出 `DEEPSEEK_API_KEY`"与"设置页里存了一把 key"同时存在时，请求改用存的那把。**无需改代码**；需要在用户可见文档（README / 故障排查）里记一条，并确认没有用户依赖导出变量切账号。 | `[ ]` 文档项 |
| W16 | P2 | **`--from-default-profile` 语义反转（归上游，脚本面）**：现在会**替换**目标 profile，连带删掉 `package.json` 依赖、`node_modules` 与 `cordis.patch.yml`；旧行为是拒绝。本仓库 0 处调用 `[实测：grep src/、plugins/*/src、scripts/]` → 无需动作；若用户的脚本或文档里出现 `dsh rescue --from-default-profile web`，要改成 `dsh rescue`。 | `[–]` 无需改 |
| W17 | P2 | **本轮判定「无关」的 alpha.3 条目（负面证据汇总，防止下一轮重查）**：`deepseek-account-identity-watch`（`watch(signal,true)`）——我们 0 处调用 `deepseekAccount.watch`；`plugin-install-over-installed`——我们的 marketplace 走 CLI `dsh plugin`，0 处使用 Host API 的 `installBundle`，且 `apps/cli/src/plugin.ts` 未变；`job-id-identity`（id 变 `<kind>-<16位hex>`）——0 处解析 job id；`jsonl-persistence-plugin`（取消默认导出）——0 处导入该包；`operator-connect`（非页面客户端默认 `interactions:'none'`）——0 处使用 `$stream`/`$events`/`interactions`；`primary-runtime-python-aliases`——指南原文"Windows 不受影响"，我们的办公载荷只构建 win32-x64/arm64；`desktop-font-size-shortcuts`（Desktop 保留 `Ctrl+=`/`Ctrl+-`）——外壳 0 处 `globalShortcut`/缩放处理，且 `packages/client/shortcuts` 在 a2↔a3 只改了 locale 与打包配置，功能随线到位，无冲突也无手写实现；新增包 `experimental/cua*`——不在我们的插件名册内且为 macOS 取向。 | `[–]` 无需改，仅记录 |

---

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1（先行适配） | W2, W3（仓库外配置层，不进 git） | 条目全 `[x]`；yaml 结构校验通过；rc.2 行为推演零变化 | `[~]` 待 W10 真机复验 |
| 2（换线日） | W1, W8, W11, W13, W5 复验, W14 复查, W9, W10 | kernel-line-regression 全门禁 | `[ ]` |
| 3（已判定无需动作，仅留档） | W4, W6, W7, W12, W15, W16, W17 | — | `[–]` |

---

## 风险

1. ~~W2/W3 可以先做~~ → **已做**（2026-10-11，2026-10-13 复核）：删 `backgroundMode` 键在 rc.2 上无害；
   删 tool-subagent / tool-subagent-fork 覆写行后由预设接管，行为推演零变化（见 W3）。
2. **W1 不先行**（用户采纳方案 b）：`startActivation` 只在 0.2.1 线存在，现在改 swarm 会让 rc.2
   运行时（当前交付线）直接编译失败。
3. `resume_entries` 语义在 0.2.1 下有一个小差异需要换线日验证：`sendMessage` 对已 settle 的
   冷子智能体会走冷恢复，恢复后的 `subagent/end` 会再发一次——我们的 `watchSettlements` 按
   「每个 waiter 消费一次 terminal」设计，重试 epoch 等自己的事件，行为应一致，但要用真机批次复验。
4. **残留 `persona`/`toolFilter` 在新线上是启动失败，不是静默忽略**（C1）。W2/W3 的清理由此从
   "减少冗余"升级为硬要求；本机 `$DSH_HOME` 三层补丁（home / profile / overlay）本轮复核均为 0 命中。
   换线日还要扫**用户的** profile 补丁与自定义 preset——上游指南明写这两处也要清。
5. **升级指南滞后于标签**（A 末条）。alpha.3 没有自己的指南目录，而 14 篇更早版本的指南是补写的。
   换到 rc 时的复核口径定为「逐条对源码 diff」，指南只作交叉验证——否则会漏掉像
   `subagent-preset-composition` 这种在标签之后才补文档的破坏性变更。
6. W13 是本轮唯一改变**产品形态**的决策（删一个模型可见的工具参数），按 §13 属用户拍板项；
   其余条目已在此处判定并记录理由。

---

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| — | 2026-10-11 | 935 提交扫描 + 18 篇指南逐读 + 本仓库 12 类表面逐一对 alpha.2 源码核对 | 计划落盘；W1 建议换线日现场移植，W2/W3 可先行，待用户拍板 |
| 1 | 2026-10-11 | **用户拍板方案 (b)**（W1 换线日现场移植）。W2/W3 已执行：`$DSH_HOME/cordis.patch.yml` 删 4 处 `backgroundMode` 键 + 整行删除 tool-subagent / tool-subagent-fork 覆写 | W2 `[x]`、W3 `[x]`；真机复验（W10）待下次启动；W1/W8 留换线日 |
| 复核 | 2026-10-13 | 852 提交 / 673 非 merge；`packages/*/*` 498→503（+5、−0）；slot catalog 94→98；14 篇新补的指南逐读；本仓库 12 类表面在 **alpha.3** 上逐条 `git` 复核 | 增量落盘：**破坏 1 处**（subagent composition 改由 preset 拥有，含加载期硬失败）、**新决策 2 条**（W11 overlay 新行、W13 工具参数）、**修正 1 条**（W5 的闭包锚点在 web-app bundle，不在 apps/cli）；slot / primitives / DOM 锚点 / 设置页序号 / tools 与 web seam **全部未变**（负面证据） |
