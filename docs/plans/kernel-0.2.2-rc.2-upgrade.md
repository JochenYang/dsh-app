# 内核线 0.2.2-rc.1 → 0.2.2-rc.2：换线适配

- Status: active
- Plan date: 2026-11-12
- Risk: high

> **2026-11-12 更新**：`@deepseek-ai/dsh@0.2.2-rc.2` 已发布到 npm（`next` 指向 rc.2，`latest` 仍是 rc.1）。
> 我们声明的 41 个 `@deepseek-ai/dsh*` 包逐个查过 registry，全部在 0.2.2-rc.2；`@deepseek-ai/dsh-error@0.2.2-rc.2`、
> `@deepseek-ai/libreoffice-kit@0.2.3` 与三个原生引擎包也都在。`@deepseek-ai/dsh-office-to-pdf` 在 rc.2 **没有**版本，
> 所以 `plugin-pdf` 的包名改名必须先于插件安装。Phase 0 通过。
> 复现：`node scratch/kernel-0.2.2-rc.2/check-published.mjs`。

> 换线本身命中 `docs/agents/kernel-line-regression.md` 的换线清单；办公载荷那三条会**硬失败**
> （构建期与启动期都直接抛错），所以风险按 high，每阶段至少 2 个 subagent 独立审查。
>
> 调研结论都是**源码级**（对 tag `dsh-v0.2.2-rc.2` 与 `dsh-v0.2.2-rc.1` 的 packages 源码做入口解析、
> 声明比对、SlotMap 抽取、peer 差集），因为 rc.2 尚未发布到 npm，一条门禁都跑不了。
> 证据分级沿用 `[实测]` / `[静态]` / `[待验证]`。
>
> 复现材料（gitignore）：`scratch/kernel-0.2.2-rc.2/` —— `ourimports.json`（我们 import 的 98 个符号）、
> `surface.mjs` / `surfaceAll.mjs`（入口导出面）、`declDiff.mjs` / `focus.mjs`（声明差异）、
> `slots.mjs`（SlotMap 抽取）、`peers.mjs` / `peers2.mjs`（peer 差集）。两个 tag 的源码是从
> `D:/codes/_wt-rc1` 与 `D:/codes/_wt-rc2`（sparse worktree）读的。

## 当前状态（2026-11-12 收尾时）

图例：**完成** = 代码已改、测试或真机有证据；**待审查** = 实现完成但第二轮独立审查尚未关闭；
**未做** = 本轮明确不做（理由在 Deferred）。

| 条目 | 状态 | 证据 |
|---|---|---|
| W1 换线（418 处 spec / 20 manifest） | 完成 | 两处解析 rc.2；`npm test` 736 用例 0 fail |
| W2 office 服务改名 | 完成 | `plugin-pdf` 0.3.0，插件内无旧名 |
| W3 技能名单 7→4 | 完成 | 构建期+启动期两份名单 + 两份夹具；`runtime:build` 成功 |
| W5 kit 0.2.3 + 垫片改名 + 白名单共享 | 完成 | 新树里 `import.meta.resolve` 解析到垫片并加载出真 kit；payload 0.2.3 |
| W6 `dsh-error` peer | 完成 | 6 个 manifest；19/19 插件建包 |
| W7 类型门禁 | 完成 | 19/19；它抓到 swarm 参数摊平与 rewind 的 zod 漂移 |
| W8 hero 层 | 完成（结论订正） | 上游 canvas 空闲时 0 像素；不否决上游，保持默认开启 |
| W10 provider title/description | 完成 | `plugin-websearch` 0.3.1 |
| W11 文档与注释 | 完成 | ARCHITECTURE / build-and-release / build-runtime / office-payload / desktop-host 均已改 |
| W12 Agent Teams 默认开启 | 完成（裁决） | 不加否决行 |
| W13 MCP 归内核管理器 | 待审查 | 真机：`mounted` + `toolCount 1`，写入落在 `mcp-manager` 行 |
| W13b 旧配置迁移 | 完成 | `tests/legacy.test.ts` 5 例；真机文件是空舰队，无迁移可做 |
| W14 changesets + 换线记录 | 完成 | `changesets/*`、`docs/archive/kernel-line/kernel-0.2.2-rc.2-upgrade.md` |
| W15 swarm 带内核名字 | 完成（真机） | 真机一轮 swarm：`[0] one … name: agent-1`，`[1] … name: agent-2` |
| W4 启动路径不再要 office-skills | 完成 | 删掉 `office-skills` 后启动健康；旧解释器树被清 |
| W9 垫片清理判定 | 完成（判定） | 保留垫片；`lib/cli.js` 保留但已无读者 |

## Goal / Why

把跟随的内核线从 `^0.2.2-rc.1` 换到 `^0.2.2-rc.2`，并修掉这条线上三个会让我们**构不出来或起不来**的音：
办公服务改名（`office-to-pdf` → `office-kit`）、办公技能名单 7→4、新内核 peer `@deepseek-ai/dsh-error`。

成功标准：19 个插件的 type gate 与根 `typecheck` 通过；`runtime:build` 与 office payload 能构建；
真机起得来；`office_to_pdf` 与 `office-docx` 各跑通一次；六条静态门禁绿；本轮改动带 changesets。

**前置事实** `[实测]`：`npm view @deepseek-ai/dsh dist-tags` → `{ alpha: 0.2.2-alpha.3, latest: 0.2.2-rc.1, next: 0.2.2-rc.1 }`。
rc.2 只有 git tag（`dsh-v0.2.2-rc.2`，release 提交 `91319233e1`）与 GitHub release，**npm 上没有**。
所以在发布之前 W1 无法执行 —— 这不是计划的问题，是外部前提。

## Scope

- Must-have：W1–W7（换线、办公三处、新 peer、type gate）
- Should-have：W8（界面判定：hero 层是否叠了两层）、W15（发布面）
- Nice-to-have：W9–W11（清理与文档一致性）
- Out of scope：改上游源码或给它提 patch；把 suite 插件改成依赖内核新能力（`tool-office`、`mcp-manager`、subagent 命名）；跨 profile 的 Python 行为

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 只改 peer/dev spec，不动代码 | 站不住：`plugin-pdf` 的服务 id 与包名都变了，构建期 `missingOfficeSkills` 会先失败（`scripts/build-runtime.mjs:645` 要七个名字，rc.2 只有四个），启动期 `src/main/desktop-host.ts:682` 的同名名单会再失败一次 |
| 保留旧的 `@deepseek-ai/dsh-office-to-pdf` 依赖并加一层补丁包 | 与本仓「只跟一条内核线、不做跨宿主世代运行时兜底」的规则冲突（`docs/agents/kernel-line-regression.md` §0.1） |
| 在运行时对 `ctx.get('officeToPdf') ?? ctx.get('officeKit')` 做双名兜底 | 同上：让「名字没了」这类断裂永远不报，把唯一真源变成两个 |
| 把 `DESKTOP_OFFICE_KIT_VERSION` 与换线放在同一次提交里先改 | 该常量进入 suite 哈希，先行会让已装用户拿到一个要求尚不存在 payload 的 runtime（`scripts/kernel-line.mjs:84-102` 记录了两步顺序） |
| 等 rc.2 上 npm 再写计划 | 计划的价值在发布前就能定范围；W12/W13 的裁决也不依赖安装 |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | 换线：20 个 manifest、418 处 `^0.2.2-rc.1` → `^0.2.2-rc.2`（根 `package.json` + 19 个插件，peer 与 dev 同改）；清根与全部插件的 `node_modules` 与 lockfile；按根 → 插件（`--legacy-peer-deps` 只在插件目录）顺序重装；确认两处解析都落到新线（`node_modules/@deepseek-ai/dsh-*` 与 `plugins/plugin-archives/node_modules/@deepseek-ai/dsh-client-connection`） | [~] |
| W2 | P0 | `plugin-pdf` 办公服务改名（**必须先于 W1 的插件安装**，`dsh-office-to-pdf` 在 rc.2 没有版本）：`package.json:63,80` 的 `@deepseek-ai/dsh-office-to-pdf` → `@deepseek-ai/dsh-office-kit`；`src/index.ts:49` 的模块增强 import 与注释；`src/index.ts:414` 的 `ctx.get('officeToPdf')` → `'officeKit'`；`tests/e2e.test.ts:58,84` 的 fixture 键名；`src/pdf-paths.ts:21` 注释里的类型来源名；版本 0.2.7 → 0.3.0（破坏性改名） | [~] |
| W3 | P0 | 办公技能名单 7 → 4：删掉 `office-render` / `office-recalculate` / `office-export-pdf` 三处，改动 `scripts/build-runtime.mjs:645`（构建期）与 `src/main/desktop-host.ts:682`（启动期）两份副本，并把两处 JSDoc 里的「七个」表述改掉。rc.2 的 `skill-office` `SKILL_NAMES` 只剩 `office` / `office-docx` / `office-pptx` / `office-xlsx`（`packages/skill/skill-office/src/index.ts:11`） | [~] |
| W4 | P2 | 启动路径不再把 office-skills 当硬前提（**降级：不是缺陷**）：技能在 rc.2 由内核包自带 `assets/`，`<dataDir>/dsh-app-office/office-skills` 已无消费者，但 `prepareOfficePayload`（`src/main/desktop-host.ts:800`）仍会复制它——而运行树自 W3 起仍产出 4 个真实目录，所以启动不会失败，这是一块死复制加一条多余硬前提。保留 leaf 与 `linkPrimaryRuntime`（rc.2 的 `apps/desktop-host/src/index.ts:25` 把 argv[4] 写进 `DSH_PRIMARY_RUNTIME`）；是否连 `stageOfficeSkills` 与 `host-arg-shape` 夹具里的“子进程读 skills”一起拆掉，单独一轮做（夹具模拟的是 rc.1 的宿主约定） | [ ] |
| W5 | P0 | 办公引擎版本、payload 身份与加载期 shim：`scripts/kernel-line.mjs:101` 的 `DESKTOP_OFFICE_KIT_VERSION` 0.1.2 → 0.2.3（rc.2 的 provider 声明 `@deepseek-ai/libreoffice-kit: 0.2.3`，原生引擎包同名同版；rc.1 是 `^0.1.5`）；`scripts/build-runtime.mjs` 的 `DESKTOP_OFFICE_PROVIDER_PACKAGE` 由 `@deepseek-ai/dsh-office-to-pdf` 改为 `@deepseek-ai/dsh-office-kit`（不改的话 shim 不会打，已实测：构建日志报 `no @deepseek-ai/dsh-office-to-pdf in the tree; no kit shim needed`，结果 `import.meta.resolve('@deepseek-ai/libreoffice-kit')` 必然抛，办公转换只能报 unavailable）。按 kernel-line 的两步顺序：先构并发布带新 `payloadVersion` 的 runtime，再让要求它的 runtime 可装；重跑 `npm run primary-runtime:build` | [~] |
| W6 | P0 | 新内核 peer：`@deepseek-ai/dsh-error` 进 5 个插件的 `devDependencies` —— `plugin-client-ui`、`plugin-hooks`、`plugin-memory`、`plugin-rewind`、`plugin-swarm`（`dsh-llm` 与 `dsh-attachment` 在 rc.2 把它声明成 peer，`--legacy-peer-deps` 不装 peer） | [~] |
| W7 | P0 | 类型门禁：19 个插件各跑 `node scripts/plugin-gates.mjs plugins/<dir>`（esbuild 不做类型检查，rc.1 的 `ProjectionHandle` 只有它抓到）+ 根 `npm run typecheck`；报告任何新出现的错误并修到 0。**本轮它抓到两处真断裂**：① `plugin-swarm` 的 `startActivation` 去掉了 `request` 包装（rc.2 的 `SubagentActivationSpec` 直接继承 `SubagentStartRequest`），两处调用点要摊平；② `plugin-rewind` 的 `zod` 钉在 4.4.3，而 `dsh-session-projection` 现在依赖 4.6.6，投影声明的 `ZodType` 缺 `validate`/`validateAsync`，要升到 4.6.6 | [~] |
| W8 | P1 | hero 层：rc.2 的 `ui-brand-official` 无条件把 `PixelWhale` 注册进新座位 `conversation.hero.frame`（`packages/client/ui-brand-official/src/client/index.ts:17`）。**实测订正**：它的 canvas 在首页空闲时是**透明的**（alpha>8 的像素 0 个），只有点击空白处才播一段自结束的动画（点击后 4570 → 76180 → 衰减回 2）；我们那层空闲即有 7529 个像素。所以静止状态下并不存在两只鲸鱼，结论改为**不否决上游**：`ui-brand-official` 保持默认开启，若日后觉得点击动画与我们的层冲突，overlay 一行即可关掉。真相靠 `scratch/whale-click-probe.mjs` 的像素计数取得，早先"两层同时可见"的说法按元素存在推断，已作废 | [~] |
| W9 | P2 | 清理判定（**已有实测结论**）：rc.2 的 `office-kit` 用 `import type` + `import.meta.resolve` + 动态 `import()`（`packages/document/office-kit/src/index.ts:347,351`），所以 kit 缺席不再是加载期失败，而是运行时 unavailable。但另一面：我们靠 shim 把 kit 指到 payload，**shim 仍需保留并改指新包名**（见 W5）；`lib/cli.js` 的启动期要求来自已删除的 `desktop-office`，可删 | [ ] |
| W10 | P2 | 我们注册的 web provider 补 `title` / `description`（`WebSearchProvider` / `WebFetchProvider` 在 rc.2 新增这两个可选字段，否则内核的 Web search 页面只显示 id） | [~] |
| W11 | P2 | 文档与注释一致：`plugins/dsh-app.patch.yml` 里 `dsh-deepseek-account-platform`、`dsh-experimental-agent-team-profile`、七技能的说法；`docs/agents/kernel-line-regression.md` §4 的办公载荷判据；`docs/agents/runtime-shape.md` 若提到 office payload 的形状 | [~] |
| W12 | OPT | 裁决已定：**接受 rc.2 的默认**，Agent Teams 随 base 的 `agent-team` / `tool-agent-team` 与 web-app 的 `ui-agent-team` 开启，overlay 不加 disable 行。理由：跟随上游默认，减少一层要自己维护的否决；`subagent` 池 16 与 swarm 的 12 之间留有 4 个槽位 | [x] |
| W13 | P0 | 裁决已定：**MCP 归内核管理器**，退役我们自己的那一套 —— 删掉 `$DSH_HOME/storages/dsh-app-plugin-mcp/servers.json` 存储与 `mount.ts` 的动态 `loader.create` 挂载（两套存储、两批 `dsh-mcp-client` 就此消失），页面保留但改成薄壳：读写内核 `mcp-manager` 行的 `config.servers`（仿 `plugins/plugin-websearch/src/index.ts:313` 的 `ctx.configEditor.edit` 写法），列表/重启/探测走 `ctx.get('mcpManager')`。前提约束：rc.2 的 mcp-manager **没有客户端半**（`package.json` 无 `dsh.client`，`packages/client` 下无消费者），整块删除会让应用失去添加 MCP 服务器的入口，所以取「保留页面、换成内核的库」这一落法 | [~] |
| W13b | P1 | 数据迁移：既有 `servers.json` 里的条目一次性写进 `mcp-manager` 行的 `config.servers`，`$ENV:NAME` 改成 `${credential:NAME}` 模板；迁移后保留原文件不删（可回滚）。沿用 `plugin-usage` 的一次性导入先例 | [~] |
| W14 | P1 | 发布面：本轮改动带 `changesets/<name>.md`（`ci.yml` 的 gate 会拒绝），实际改到的插件 bump 版本；换线记录写进 `docs/archive/kernel-line/kernel-0.2.2-rc.2-upgrade.md` | [ ] |
| W15 | P2 | 跟官方命名：swarm 的 child label 改用内核返回的 `activation.name`（rc.2 的 `SubagentActivation` 新增必填 `name`，`startActivation` 的 `name?` 仍可选），不再自己拼序号 | [~] |

## 本轮实测（2026-11-12）

`[实测]`，日志在 `scratch/kernel-0.2.2-rc.2/`：

- **W1**：418 处 spec / 20 manifest 改完；根 `npm install` 424 包；两处解析均 `0.2.2-rc.2`（根 `dsh-app-boot`、`plugin-archives` 本地 `dsh-client-connection`、`plugin-client-ui` 本地 `dsh-client-ui-primitives`）。`npm test`：731 用例 / 729 pass / 2 skipped / **0 fail**。`check:graph` / `check:suites:gate` / `check:slots` / `check:touchpoints:gate` 全 exit 0（`plugin graph: 19 plugins, followed line ^0.2.2-rc.2`）。
- **W2**：包名与服务 id 改完，`plugin-pdf` 0.2.7 → 0.3.0，插件内已无 `office-to-pdf` 引用。
- **W3**：4 项名单进了 `scripts/build-runtime.mjs`、`src/main/desktop-host.ts` 与两份测试夹具；`runtime:build` 成功：`dsh-runtime-win32-x64-0.2.2-rc.2.tgz`（124.4 MB）+ `office-payload-win32-x64-0.2.2-rc.2.tgz`（70.5 MB，引擎 0.1.2）。
- **W6**：6 个 manifest 加了 `@deepseek-ai/dsh-error`（根 + 5 个插件）。
- **W7**：19/19 插件的 import / type / presence / freshness 四道门全过；根 `typecheck` 无输出。过程中它抓到两处真断裂（已修，见 W7 单元格）。
- **阶段 3 的意外发现**：`runtime:build` 报文 `no @deepseek-ai/dsh-office-to-pdf in the tree; no kit shim needed` —— 包名换掉后 shim 没打，`import.meta.resolve('@deepseek-ai/libreoffice-kit')` 必然抛，办公转换只能报 unavailable。已记入 W5；构建“成功”不等于这个能力还在。
- **hero 层（真机、rc.2 内核）`[实测]`，含一次订正**：两个 canvas 元素都在，但**只有我们的在画**。`[data-home-whale]` 在首页空闲时透明（alpha>8 像素 0），点击空白处才播一段自结束动画（+1.5s 时 76180 个像素，+2.5s 衰减回 2）；我们的 `#dshapp-whale-bg` 空闲 7529 个像素。早先"同时出现两只鲸鱼"是只看元素存在得出的，作废。
- **W8 的定案经过一次回退**：曾按“跟官方”读过一次——把自画层删掉——核对后回退（品牌层是产品资产，不在换线范围内，也不属于“适配”），改为在 overlay 关掉 `ui-brand-official` 一行。关掉后的真实窗口实测 `[实测]`：我们的 canvas 在且 `is-visible`，`[data-home-whale]` 计数 0，`conversation.hero.frame` 无占位者也不报错（`slot entry crashed` 计数 0，故障计数 0）；rc.2 启动日志 `host ready` 1 次。
- **W5 `[实测]`**：`runtime:build` 重跑后报文从 `no …office-to-pdf in the tree; no kit shim needed` 变成 `LibreOffice kit shim: scripts/runtime-stubs/libreoffice-kit -> app/node_modules/@deepseek-ai/libreoffice-kit`，payload 版本从 0.1.2 变 0.2.3（350.7 MB unpacked，121 MB 压缩）；在解包后的 `app/` 里跑 `import.meta.resolve('@deepseek-ai/libreoffice-kit')` 能解析，动态 import 拿到 `createConverter`。另外 payload 的 pnpm 组装因 kit 0.2.3 新增 `koffi` 而被 `ERR_PNPM_IGNORED_BUILDS` 拒，已把运行树那份构建脚本白名单抽成共享函数给两处用。W8 的判定成立。
- **`probe-whale.cjs` 无法对准桌面窗口 `[实测]`**：桌面页面的 `location.href` 是 `dsh-app://app/index.html`，自定义协议只存在于应用自己的进程；宿主 `http://127.0.0.1:<port>?token=…` 里的 token 被外壳日志脱敏（实测输出 `[redacted]`），所以本轮用 CDP 读真实 DOM 代替（`scratch/cdp.mjs`），层数、几何与透明度直接量自运行中的窗口。

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 0 前提 | rc.2 发布到 npm | **已过** `[实测]`：`next = 0.2.2-rc.2`；我们声明的 41 个 `@deepseek-ai/dsh*` + `dsh-error` + `libreoffice-kit@0.2.3` 全在；`dsh-office-to-pdf` 在 rc.2 不存在 |
| 1 裁决 | W12, W13 的方向 | **已过**：W12 接受默认；W13 归内核管理器、页面改薄壳；W8 跟官方座位 |
| 2 换线 | W2（仅 package.json 的包名改名）, W1, W6, W7 | 两处版本解析都在新线；根 `typecheck` 通过；19 个插件的 import/type/presence/freshness 四道门全过；`check:graph` / `check:suites:gate` / `check:slots` 绿 |
| 3 办公 | W2（源码与测试）, W3, W4, W5 | `npm run runtime:build` 与 `npm run primary-runtime:build` 成功；真机 `office_to_pdf` 与 `office-docx` 各跑通一次 |
| 4 界面 | W8, W15 | 真机首页只有一层鲸鱼（我们的层，内核那行已关）；`probe-startup.cjs` 通过；swarm 的 child label 显示内核名字 |
| 5 MCP | W13, W13b | 页面能增删改/重启/探测；工具仍以 `mcp__<server>__<tool>` 注册且只有一套；迁移后旧 `servers.json` 仍在 |
| 6 收尾 | W9, W10, W11, W14 | `npm test` 绿；changesets 片段存在；`npm run verify -- --tgz <新产物>` 通过；四条探针（settings-nav / workbench / routes / startup）结果入 Phase log |

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| `office_to_pdf` 工具取到的转换服务 | modified | `plugins/plugin-pdf/src/index.ts:414`（`officeToPdf` → `officeKit`） |
| 构建期办公技能完整性判定 | modified | `scripts/build-runtime.mjs:645` |
| 启动期办公载荷完整性判定 | removed | `src/main/desktop-host.ts:758,800,816` |
| 办公 payload 的版本身份 | modified | `scripts/kernel-line.mjs:101` |
| 内核 peer 解析（5 个插件的 dev 依赖） | added | `plugins/plugin-{client-ui,hooks,memory,rewind,swarm}/package.json` |
| 启动页 hero 背景层 | modified（待判定） | `plugins/plugin-client-ui/src/client/whale-background.ts` |
| 我们的 web provider 展示名 | modified（可选） | `plugins/plugin-websearch/src/index.ts`（provider 对象） |
| 运行时里的 kit 加载期 shim | removed（待判定） | `scripts/runtime-stubs/libreoffice-kit`、`scripts/build-runtime.mjs:2315` |
| Agent Teams 工具与 UI | added（默认开，待裁决） | 上游 `packages/bundle/{base,web-app}/cordis.patch.yml`，无我方改动 |

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 两处版本解析落到新线 | 根与 `plugins/plugin-archives` 各读一个内核包的版本 | 都是 `0.2.2-rc.2` | `node -e "console.log(require('./node_modules/@deepseek-ai/dsh-app-boot/package.json').version)"` 与 `plugins/plugin-archives` 同名命令 | PASS |
| 2 (W1) | 构建产物版本与 spec 一致 | `npm run runtime:build` | `dsh-runtime-<platform>-<arch>-0.2.2-rc.2.tgz` | 命令 + 产物名核对 | PASS |
| 3 (W6) | 新 peer 可解析 | 5 个插件的套件构建 | 无 `Could not resolve "@deepseek-ai/dsh-error"` | `cd plugins/plugin-swarm && npm test`（其余四个同） | PASS |
| 4 (W7) | 类型门禁 | 19 个插件 + 根 | 0 error | `for d in plugins/*/; do node scripts/plugin-gates.mjs "$d"; done`；`npm run typecheck` | PASS |
| 5 (W3) | 构建不再因技能缺失拒绝 | 只有 4 个技能目录的 source | `missingOfficeSkills` 返回空 | `npm run runtime:build` | PASS |
| 6 (W4) | 启动不再要求 office-skills | 无 `<dataDir>/dsh-app-office/office-skills` | host 正常启动到主界面 | `npm run dev`，看启动日志 | PASS（删掉 office-skills 后 host ready、失败 0） |
| 7 (W4) | Python 走 workspace-dependencies | 真机 `/office-docx` 一次 | 技能指示使用内置 Python，而不是用户的 | 手工 + `load_workspace_dependencies` 输出 | PASS（带 Python 集的 payload 装好后，真机 turn 拿到内置 python.exe，`import docx/pptx/openpyxl` 退出码 0） |
| 8 (W2) | 转换服务可取到 | 真机跑 `office_to_pdf` 一次 | `status: exported` 且文件已写入 | 手工 | PASS（真机 turn：`status: exported`、18303 字节；并因此发现垫片的引擎锚点问题，见归档 §11） |
| 9 (W5) | 引擎 0.2.3 的 API 与 payload 布局 | 用新 payload 跑一次转换 | 不报 kit/engine 定位失败 | 手工 + 日志 | PASS |
| 10 (W8) | 首页只有一层鲸鱼 | 真机开首页 + CDP 读 DOM | 我们的 canvas 在且 `is-visible`；`[data-home-whale]` 计数 0；无 `slot entry crashed` | 运行中的窗口 + `scratch/cdp.mjs` | PASS（订正：静止时只有我们那层；上游画布透明，点击才播） |
| 11 (W1/W14) | 根套件与真内核 | `npm test`；`npm run verify -- --tgz <新产物>` | 全绿 | 命令 | PASS（npm test 737/735/0；verify --tgz smoke 全过，过程中修了导入后单次读状态的断言） |
| 12 (W1) | 路由载体未变 | `probe-routes.cjs` 的 S1–S5 段 | RESULT 全 PASS | `node scripts/probe-routes.cjs` | PASS（--tgz 跑新产物：RESULT: PASS (32 checks)） |
| 13 (W3) | 设置页图标未回退 | `probe-settings-nav.cjs --lang en-US` | 无双图标、无残留 Han | 命令 | N/A（跑不了：该探针需要一个已构建的 harness 检出，本机没有；不是本轮回归） |
| 14 (W12) | Agent Teams 裁决的可见结果 | 真机看模型菜单/工具列表 | 与裁决一致 | 手工 | N/A（未做手工确认；默认开启按上游） |
| 15 (W13) | MCP 只有一套实例 | 在内核页面之外的我们的页面加一个服务器 | 工具以 `mcp__<server>__<tool>` 注册，且 loader 条目里没有第二个 mcp-client 实例 | 手工 + 启动日志 | PASS（真机 mounted + toolCount 1；patch 只有一个存储） |
| 16 (W13b) | 旧配置迁移 | 预置一个带 `$ENV:` 引用的 `servers.json` 后启动 | 条目出现在 `mcp-manager` 行 config，`$ENV:` 变成 `${credential:…}`，原文件仍在 | 手工 + 读 profile patch | PASS（tests/legacy.test.ts；真机空舰队未触发迁移） |
| 17 (W15) | child label 用内核名字 | 跑一次 4 项的 swarm 批次 | 目录/回执里是内核名字，不是自拼序号 | 手工 | PASS（真机 swarm 批次输出 name: agent-1 / agent-2） |

## Verification commands

```sh
npm run typecheck
npm run build
npm test
npm run check:graph
npm run check:suites:gate
npm run check:slots
npm run check:touchpoints
for d in plugins/*/; do node scripts/plugin-gates.mjs "$d"; done
npm run runtime:build
npm run primary-runtime:build
npm run verify -- --tgz runtime-dist/dsh-runtime-<platform>-<arch>-0.2.2-rc.2.tgz
node scripts/probe-settings-nav.cjs --lang en-US
node scripts/probe-workbench.cjs
node scripts/probe-routes.cjs
node scripts/probe-startup.cjs
node scripts/probe-whale.cjs
```

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 移植 `@deepseek-ai/dsh-tool-office`（rc.2 新增，未挂到 web-app，无冲突） | 与 `plugin-ppt` / `plugin-pdf` 的边界要单独定，不在换线范围 | 决定 Office 能力归属时 |
| 用内核的 subagent 名字替换 swarm 的 `childLabel` | 已提升为 W15（按官方命名走） | — |
| `tool-subagent-control` 的 `interrupt: false` 默认（base 行新增） | 我们没覆盖该行，行为随上游走；未观察到与 swarm 的 `interrupt` 冲突 | 出现 swarm 中断行为异常时 |
| MCP 新能力（凭据模板 `${credential:…}`、`probeServer`、状态单元） | W13b 只做迁移与页面薄壳，不在本轮把探测/重启体验做满 | W13 落地后单独一轮 |
| 非 desktop profile 的 `pythonEnvironment` 分支 | 本仓只发 desktop profile | 新增第二个 profile 时 |

## Rollback

回滚方式：本轮所有改动在同一个提交范围内，`git revert` 该提交即可；`DESKTOP_OFFICE_KIT_VERSION`
如果已经 bump 过，要连它一起回退（否则已装用户会拿到要求不存在 payload 的 runtime）。
已装的旧内核在 `%APPDATA%\DSH APP\kernel\` 不受影响，`kernel-manager` 的 rollback 仍可用。

已知坑（都实测过，见 `docs/agents/kernel-line-regression.md` §8）：

- 换线后第一次 `npm test` 可能红在 electron `dist/` 的解压并发上，不是回归；先单独补 `dist/` 再跑。
- 本会话的 `PATH` 里若带内核自带的 `pnpm\bin`，`test/host-arg-shape.test.mjs` 会红；跑全量前先清掉含 `pnpm` 的段。
- 探针在 Electron 内启动子进程的每个 `spawn` 必须传 `windowsHide: true`。
- `git worktree` 留下的 `_wt-rc1` / `_wt-rc2` 与 `scratch/kernel-0.2.2-rc.2/` 都是分析材料，收尾时确认是否需要保留。

残余风险：办公引擎 0.2.3 的运行时行为只做一次转换验证，未覆盖全格式；`workspace-dependencies`
的 `runtime.json` 格式读的是 rc.2 的 `tool-workspace-dependencies`，该包 src 未变，但仍以真机为准。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
