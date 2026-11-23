# 内核线 0.2.3-alpha.1：预适配结论

- Status: planned
- Plan date: 2026-11-22（alpha.2 增量 2026-11-23，见 §0.3）
- Note: 结论是 2026-11-22 对 `0.2.3-alpha.1` 的实测与静态快照，**本轮不升线**（理由见 §0.2）。
  换线日按 §8 执行；若届时目标已是 `0.2.3-rc.N`，先对它重跑预检——本文的载荷与声明结论只对 alpha.1/alpha.2 负责。

> 执行 2026-11-22。**这不是一次升线**：上游把 `0.2.3-alpha.1` 发在 `alpha` 通道，`next` 与 `latest` 仍是
> 本仓跟随的 `0.2.2-rc.5`。本文记录「换到 0.2.3 线需要做什么」，供那一轮直接照此执行——与
> [`kernel-0.2.2-alpha.2-preflight.md`](kernel-0.2.2-alpha.2-preflight.md) 同一性质。流程判据在
> [`../agents/kernel-line-regression.md`](../agents/kernel-line-regression.md)。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 阅读源码、已发布声明或文档；`[待验证]` = 推断，未执行。
> `α:` 指 tag `dsh-v0.2.3-alpha.1`，`r5:` 指 `dsh-v0.2.2-rc.5`；不带前缀的路径相对本仓根。
>
> **复现材料**（gitignore）：`scratch/kernel-0.2.3-alpha.1/` —— `preflight.json`（预检 JSON）、
> `pkg-names-*.txt`（包名差集）、`upstream-primary-runtime-lock-*.json`、`yaml-check.mjs`（按 alpha.1 的
> YAML 口径解析本仓 17 个组合文件）、`undefined-tokens.mjs`（扫描无 fallback 的未定义主题令牌）。
> 已发布的 alpha.1 包解包在 `scratch/kernel-preflight/0.2.3-alpha.1/`；上游检出 `D:\codes\deepseek-harness`
> 停在 `dsh-v0.2.3-alpha.1`。
>
> **调查方式**：预检 + 七类触点扫描 + 五路只读调查（组合树与私有宿主、host 侧 API、client 侧锚点、升级指南、
> runtime 构建与载荷），结论逐条回到源码复核；未采纳的调查结论见 §10。

> **预检**：`npm run check:preflight -- --npm 0.2.3-alpha.1` → **2 blocker / 0 ADAPT / 16 note**（exit 1）；
> `--dir D:/codes/deepseek-harness`（源码检出）→ 同 2 blocker / 14 note。blocker 裁决：两条均「已知并接受——
> 本轮不升线」，换线日分别按 §2.3、§2.2 解决。预检**看不见**的必改项——私有宿主握手、Python 集缺 `pypdf`、
> Creator 技能点名的旧工具——来自 §1 的源码与指南调查（§2.1、§2.4、§2.5）。
> **alpha.2 复跑**（2026-11-23）：**4 blocker**——原两条不变，新增 Node 下限（§2.9）与 cordis 范围（§2.7）两条；
> 后两条是预检当时看不见的，先修了预检再复跑的（§0.3）。

## 0 事实基线

### 0.1 `[实测]`

```
npm dist-tags @deepseek-ai/dsh → { alpha: 0.2.3-alpha.1, latest: 0.2.2-rc.5, next: 0.2.2-rc.5 }
0.2.3-alpha.1 发布：2026-11-22T03:45:26Z；engines：node >=24.9.0（与 rc.5 相同，CI 跑 24.9）
r5..α：2343 提交（1629 非 merge）；7260 文件，+302202 / −83093
@deepseek-ai 包：379 → 403（新增 30、移除 6）；升级指南新增 55 篇、修改 2 篇
我们 import 的内核包 34 个，其中 29 个载荷有变（457 个文件）
我们具名导入 42 个符号（13 个包为运行期耦合）；alpha.1 上只丢 rankByName 一个
我们的 spec（升线前）：^0.2.2-rc.5 × 422（20 个 manifest）；锁定 0.2.2-rc.5
当前线门禁基线：check:touchpoints:gate / check:slots（30 次注册全解析）/ check:graph / check:suites:gate 全 exit 0
```

### 0.2 通道：为什么本轮不升线

- `^0.2.3-alpha.1` 经 `scripts/kernel-line.mjs` 的 `channelFromSpec` 判为 `alpha`，发版 workflow 会改从
  `alpha` dist-tag 解析，外壳的内核更新通道随之把 alpha 内核推给用户。本仓自 0.2.2 线起只跟 RC 线。
- 默认 semver 口径下 `^0.2.2-rc.5` **不接受** `0.2.3-alpha.1` 与 `0.2.3-rc.1`（预发布不跨 tuple），接受稳定版
  `0.2.3` `[实测]`。所以 rc.1 上线后不会自动漂进来，换线必须是显式动作；`assertFollowedVersion` 用
  `includePrerelease`，两种都放行——拦这种漂移的是锁文件，不是它。
- 推荐：等 `0.2.3-rc.1` 上 `next` 再换——**已采纳**（2026-11-22，等到 RC 后再升线，见 §5 D1）。

### 0.3 alpha.2 增量（2026-11-23）`[实测]`

```
npm dist-tags @deepseek-ai/dsh → { alpha: 0.2.3-alpha.2, latest: 0.2.2-rc.5, next: 0.2.2-rc.5 }
0.2.3-alpha.2 发布：2026-11-22T09:57:12Z（alpha.1 之后 6 小时）；engines：node ^24.22.3 || >=26.13.1
α1..α2：5 提交（3 非 merge）；488 文件，+806 / −707——其中 ~400 个是各包 package.json 的版本号与 engines
非 manifest 的实质改动：0 行运行时代码；新增升级指南 1 篇（v0.2.3-alpha.1/node-24-22-3）
dsh 对 vendored 家族的钉版：@deepseek-ai/cordis ~4.1.0 → ~4.2.0-alpha.1、schemastery ~3.19.0 → ~3.20.0-alpha.1
  （cosmokit 1.10.0-alpha.1、cordis-plugin-loader/include/timer 1.2.0/1.2.0/1.3.0-alpha.1；npm dist-tag 均在 next）
预检（修了两处盲区后，§6.4）：4 blocker / 16 note——engines「CI runs 24.9」、rankByName、skill-office、
  peers「@deepseek-ai/cordis ~4.2.0-alpha.1 ← 本仓声明 ^4.1.0, 4.1.0」；当前线 --line-policy=exact 仍 0 blocker
```

alpha.2 是一次「只抬 Node 下限」的发版：上游指南原话——「打包的桌面应用和 Python SDK 的内置可执行文件自带
Node.js 24.22.3 运行时」，理由是内置 undici 的 2026-11 安全修复。对本仓多出两条必改项：**C9**（§2.9，CI 与
发版 workflow 打进运行时的 Node）与 **C7 的补充**（§2.7，cordis 一家的 spec 这次要动——alpha.1 时「不动」的
结论被 alpha.2 推翻）。其余结论（C1–C6、§3、§4、§5）建立在 alpha.1 上，alpha.2 没有触碰它们依赖的任何文件。

## 1 上游这一线动了什么

### 1.1 包级增删 `[实测]`

新增 30 个：`dsh-cli-account`、`dsh-client-config`、`dsh-client-remote-connection`、`dsh-client-script-realm`、
`dsh-client-script-realm-iframe`、`dsh-client-ui-connector-account`、`dsh-client-ui-session-panel`、
`dsh-client-ui-session-status`、`dsh-cua-macos`、`dsh-cua-mcp`、`dsh-cua-windows`、`dsh-deepseek-auth`、
`dsh-desktop-publisher`、`dsh-dingtalk`、`dsh-feishu`、`dsh-forge-gitlab`、`dsh-host-authentication-desktop`、
`dsh-host-authentication-token`、`dsh-linear`、`dsh-mcp-account`、`dsh-notion`、`dsh-session-persistence-sqlite`、
`dsh-tencent-docs`、`dsh-tencent-meeting`、`dsh-timeline`、`dsh-tool-session-control`、`dsh-tool-session-list`、
`dsh-upstream-skills`、`dsh-util-text-search`、`dsh-wecom`。

移除 6 个：`dsh-client-ui-settings-plugin-inventory`、`dsh-client-ui-settings-plugins`、
`dsh-experimental-cua-macos`、`dsh-experimental-ptc-runtime-python`、`dsh-personalized-recommendations`、
`dsh-tool-working-directory`。对本仓：6 个被移除的包 **0 处运行期引用**（唯一命中是
`plugins/plugin-client-ui/src/client/maintenance/section.tsx:10` 的注释）。

### 1.2 组合树 `[实测：git diff]`

- **base**：新增 `deepseek-auth`、`cli-account`、`upstream-skills` 三行；删除 `tool-working-directory`；既有行的
  配置键无增删。
- **web-app**：新增 `tool-session-control`（默认 `disabled`）、`mcp-account`、`authentication-token`、
  `ui-session-status`、`remote-connection`、`ui-connector-account`、`action-cards` / `client-ui-action-cards`、
  `creation-recommendations` / `client-ui-creation-recommendations`、`plugin-recommendations` /
  `client-ui-plugin-recommendations`、`ui-session-panel`；删除 `ui-settings-plugins`；
  `ui-settings-plugin-inventory` 改名 `ui-connector-account`。order 15 的设置节改由既有的 `ui-plugin-manager`
  注册（`α:packages/client/ui-plugin-manager/src/client/index.ts:176-179`）。bundle 共 211 行。
- **presets**：`standard` 新增 `tool-cordis`；`cordis` 的 `tool-skill` 增 `excludedSkills`；`ptc` 的
  `skill-filesystem` 增 `customSkillDirs`，`tool-plugin-manager.disabled` 放开为 `!ctx.get('profileContext')`。
- **本仓 overlay** `plugins/dsh-app.patch.yml`：6 条 override 的目标行都在，写入的键在目标插件的 Config 里仍
  合法；19 条 insert 是无锚点的顶层 insert，与上游新增行 **无撞名**。
- **YAML 口径变了**：组合文件改由 `yaml` 的 core schema 解析（`α:vendor/include/src/index.ts:38-62`），遇错、
  遇警告、遇未解析别名都抛；加载器新增条目选项校验。本仓出货的 17 个组合文件按同一组选项实跑全部通过
  `[实测]`（`node scratch/kernel-0.2.3-alpha.1/yaml-check.mjs`），条目只用了 `id` / `name` / `config` /
  `disabled`（布尔），不触碰新校验的任何一条。外壳在启动期生成的 profile 补丁未解析过 `[待验证]`。

### 1.3 升级指南：57 篇全是增量，目录名不可信 `[实测]`

`git diff --name-status r5 α -- docs/upgrade-guide/`：新增 55、修改 2，全部回填在 `v0.2.1-alpha.1` …
`v0.2.2-rc.5` 这些**旧目录**下（r5 的 tag 树里 `v0.2.2-rc.2/`、`v0.2.2-rc.5/` 两个目录都不存在）。抽样 r5 源码，
这些指南描述的变更当时都还不存在（`rankByName` 仍导出、`./brand` 子路径仍在、desktop-host 仍用
`connection.authenticatedUrl`）。结论：**读法是「两个 tag 之间差了哪些指南」，不是「读目标版本的目录」**。
上游没有面向插件作者的集中发布说明。

命中本仓的 5 篇，逐篇判定（口径见 `kernel-line-regression.md` §7.3）：

| 指南 | 判定 | 打到本仓哪里 |
|---|---|---|
| `rc.2/connection-page-peer` | 值得移植 + **必改** | 外壳启动握手，§2.1 |
| `rc.5/office-single-skill` | 归上游 + **必改** | 技能名单、`/` 菜单、两份技能文档，§2.3 |
| `rc.3/cordis-inspect-tool` | 归上游 + **必改** | workbench 的 Creator 技能正文，§2.5 |
| `rc.1/web-fetch-transport-error-codes` | 值得移植 | `plugin-websearch` 的传输错误码，§3.1 |
| `rc.2/client-module-metadata` | 归上游（探针与文档随线） | `claimStyles` 退场、CSS 级联次序，§2.6、§4.3 |

其余 52 篇为**无关**或**归上游**，关键词与命中数见 §4.4。

### 1.4 架构位移（预检看不见的那一类）`[静态]`

连接器全家（钉钉、飞书、Linear、Notion、腾讯文档/会议、企业微信、`cli-account`、`upstream-skills`）与
`mcp-account` 进驻；认证拆成 `deepseek-auth` / `authentication-token` / `authentication-desktop` 三个 provider；
`remote-connection` 让浏览器经扫码登录接入；`script-realm`（+ iframe）与 `ui-session-panel` / `ui-session-status`
改了客户端的脚本边界与会话面板；会话持久化多了一个**可选**的 SQLite provider（已发布的 profile 仍走 JSONL，
base 仍挂 `session-persistence-jsonl`）。这些没有符号消失，只能靠读——它们的产品面影响在 §5。

## 2 必改项（换线日）

每条按 `kernel-line-regression.md` §7.1 的固定字段写。**C1 是阻断**：不改则换线后应用起不来。

### 2.1 C1 私有宿主握手（阻断）

- **类型**：破坏。**接触面**：7（子进程与输出解析）。**来源**：`α:apps/desktop-host/src/index.ts:20-40,159-168`、
  `authentication.ts`、`α:packages/host/authentication-desktop/src/index.ts:22-41`；指南 `rc.2/connection-page-peer`。
- **症状**：alpha.1 的 desktop-host 在读 argv 之前先 `await` 父进程经 IPC 送来的 `{type:'desktop-auth', secret}`
  （secret 为 32 字节 base64url、43 字符，消息恰好两键，重复或格式错即认证失败）；`ready.url` 不再带 token，
  鉴权靠 cookie `dsh-desktop-session=<secret>`。外壳现状：不认识 `starting`、从不发送 `desktop-auth`
  （`src/main/desktop-host.ts:1746-1901,1970-1989`），仍用 `authenticateHostWeb(ready.url)` 要求
  `303 + set-cookie`（`src/main/desktop-host.ts:1395`、`src/main/host-web.ts:269-278`）。后果：子进程停在等凭据、
  外壳停在等 `ready`，90 s 后超时（`HOST_READY_TIMEOUT_MS`，`src/shared/constants.ts:116`）`[静态]`；
  未启动 alpha.1 实测 `[待验证]`。
- **修法**：外壳成为凭据的属有者——收到 `starting` 时生成 `randomBytes(32).toString('base64url')` 并只发一次
  （argv 回退重试的每个子进程各发一次），`ready` 后直接拼 cookie，不再换取；`isHostEvent` 接受 `starting`。
  上游参照实现：`α:apps/desktop/src/parent-authentication.ts:7,19,37`、`host-process.ts:262-272`；发端用例
  `α:apps/cli/tests/desktop-host.e2e.ts:87`。改动面：`src/main/desktop-host.ts`、`src/main/host-web.ts`
  （`authenticateHostWeb` 与 `HostWebAuthentication` 下线）、`scripts/probe-routes.cjs:66,715-718`、
  `test/host-web.test.mjs:52,72-73`、`test/host-arg-shape.test.mjs:147-163`（夹具模拟的正是旧约定）；文档
  `docs/ARCHITECTURE.md:353-375`、`docs/agents/security-invariants.md:21-24`。cookie 名是内核常量，不要自拟。
- **验证方式**：`npm run dev` 隔离 `DSH_HOME` 起到主界面（M1）；`probe-routes.cjs` 的 S1–S5；该项改的是认证
  边界，合入前走 `security-auditor` 专项审查。顺带收益：凭据不再经 HTTP 传递。

### 2.2 C2 `rankByName` 被删（预检 blocker 之一）

- **类型**：破坏。**接触面**：5（客户端注册面）。**来源**：提交 `a5bdc28238`（2026-11-13）；指南
  `rc.2/shared-search-filter`。
- **症状**：`plugins/plugin-ppt/src/client.ts:31,111` 从 `@deepseek-ai/dsh-client-ui-primitives` 运行期导入
  `rankByName` 并注入 `/` 菜单（`client/office-menu.ts:159-162,207`）；alpha.1 删除了它，替代物是新包
  `@deepseek-ai/dsh-util-text-search` 的 `TextSearchIndex`（有状态索引：列表变化时建、每次查询 `search`）。
  该包只发布了 `0.2.3-alpha.1`，r5 上不可得——所以**不能先行**。
- **坑（比换导入更要紧）**：本仓构建把所有 `@deepseek-ai/*` 设为 external（`plugins/build-lib.mjs:26-30`），
  而内核浏览器 loader 只应答「已物化的模块」，其余 `require` 直接抛 `missed the module table`
  （`α:packages/client/modules/src/client/system.ts:329-337`）。上游自己把它内联（`util-text-search` 在
  `INLINE_SAFE` 名单里，`α:packages/client/tsdown.client.ts:95-100`）。只换导入会让整个 `plugin-ppt` 的
  client 半在求值时抛错，PPT 胶囊与菜单一起消失 `[静态]`。
- **修法**：`office-menu.ts` 的 `rank` 依赖换成有状态的 `search`；`client.ts` 在本地化行变化时重建索引；
  `plugins/plugin-ppt/build.mjs` 的 **client 半**把 `@deepseek-ai/dsh-util-text-search`（连同 `fuzzysort`）内联
  （分别调用导出的 `buildHost` / `buildClient`，只有后者换 external）；该包进 `devDependencies`、规格等于跟随线；
  更新 `tests/office-menu.test.ts:55-74,298-299`。排序规则随之从「有序子序列」变为「多语言模糊 + 词首锚定」，
  标签只按当前语言匹配、名字按所有语言匹配（包的 README 已知限制）。
- **验证方式**：插件 type gate；`test/plugin-kernel-imports.test.mjs`；`node scripts/probe-office-menu.cjs`；
  真机输入 `/` 与部分标签确认过滤。

### 2.3 C3 `skill-office` 四个技能并为一个（预检 blocker 之二）

- **类型**：破坏 + 行为。**接触面**：1、7。**来源**：`α:packages/skill/skill-office/src/index.ts:11`
  （`SKILL_NAMES = ['office']`）、指南 `rc.5/office-single-skill`。
- **症状**（四处，预检只看得见第一处）：
  1. `scripts/build-runtime.mjs:678-683` 的 `OFFICE_SKILL_NAMES` 仍是四项，`stageOfficeSkills`
     （`:834-855`）遇到不完整的载荷直接抛错——`runtime:build` 会拒绝构包。
  2. `plugins/plugin-ppt/src/client/office-menu.ts:72-97` 的「文档」「表格」两行指向已不存在的
     `office-docx` / `office-xlsx`（头注释自己写明：任何一侧改名都必须改到这张表，否则该行调用不到东西）。
  3. 两份技能正文让模型「改用 `office-pptx`」：`plugins/plugin-pdf/src/skill.ts:27`、
     `plugins/plugin-ppt/src/skill.ts:80,87`。
  4. 探针与测试夹具：`scripts/probe-office-menu.cjs:82`、`plugins/plugin-ppt/tests/office-menu.test.ts:99-131`、
     `test/kernel-preflight.test.mjs:139-153`。
- **修法**：
  - **构建侧整体拆除暂存，而不是把名单改成一项。** `runtime/office-skills` 自 rc.2 起无运行期读者（`src/` 0 命中；
     `smoke-package.mjs` / `smoke-suite.mjs` 不断言它），rc.2 那轮把它推迟到「下次动 runtime 分层或技能来源时」
     ——现在技能来源正要变，而换线本来就要重建并复验 runtime，并进来做边际成本为零；单独现在做则要整轮复验，
     且对已装用户零效果（`suiteVersion` 看不见它，同线重建的 runtime 是 `already-adopted`）。拆除后这一类
     blocker 永久消失。同改：`scripts/split-runtime-layers.mjs:37-65`（`META_ENTRIES` 去掉 `runtime/runtime`，
     不改则发布的 split 步骤会因 lstat 失败）、`scripts/kernel-preflight.mjs:1067-1094`（找不到名单时本就只记
     note，顺带删掉 `:1074` 已不存在的镜像路径）、两份 agent 文档（`kernel-line-regression.md:280`、
     `build-and-release.md:23-36`）与 `commands.md` 的一处。
  - **菜单两行**：`office-docx` / `office-xlsx` 两行并入一行 `office`（菜单 4 行 → 3 行）。这是产品形状的改动，
     属 §5 D4。
  - **测试的真源换位**：`office-menu.test.ts:114-131` 现在读的是我们自己的构建脚本；名单拆掉后改读已安装的
     `@deepseek-ai/dsh-skill-office` 包里的 `SKILL_NAMES`——那才是「内核实际装了什么」的权威，比读自己的脚本强。
  - 两份技能正文改指 `office`；探针夹具同步。
- **验证方式**：`npm run runtime:build`；`npm test`；`node scripts/probe-office-menu.cjs`；真机 `/office` 一次，
  下一步声明 `office_render` / `office_convert` / `office_recalculate`（指南的验收句）。

### 2.4 C4 Python 集缺 `pypdf`

- **类型**：行为。**接触面**：7。**来源**：`α:scripts/primary-runtime/lock.json:157,181`；`office` 技能正文
  「Bundled Python includes `pypdf`」。
- **症状**：alpha.1 的 `office` 技能向模型声明内置 Python 含 `pypdf`，而本仓 `scripts/primary-runtime-lock.json:144`
  的 13 个包里没有。三方比对（上游 r5 / 上游 α / 本仓）后，差异**只有这一项** `[实测]`。
- **修法**：锁同步补 `pypdf 6.21.4`（纯 Python wheel，一份共享条目）。
- **已知缺口**：`officePayloadVersion` 只由 kit 版本与 Python 版本组成（`scripts/lib/office-payload.mjs:84-88`），
  不含 wheel 集；补进去后版本仍是 `0.2.3-py3.12.14`，**已装用户不会重下**，他们的内置 Python 仍然没有 pypdf。
  影响面：仅当模型按技能声明在既有 PDF 上跑 pypdf 脚本时失败（PDF 的读/改/转换本仓有自己的工具）。
  把 wheel 集摘要纳入载荷身份会触发 `DESKTOP_OFFICE_KIT_VERSION` 那种两步发布顺序，为单个包不值得；
  记为加固项（§6.3）。

### 2.5 C5 Creator 技能点名了被取代的工具

- **类型**：行为（模型可见）。**接触面**：5。**来源**：指南 `rc.3/cordis-inspect-tool`。
- **症状**：`plugins/plugin-workbench/src/skill.ts:159` 让模型用 `cordis_inspect_list` / `cordis_inspect_query`，
  `tests/skill.test.ts:253-254` 还断言旧名存在；alpha.1 用单个 `cordis_inspect` 取代二者，入参形状也变了
  （`cordis_inspect({ query: { platform, provider, method, input } })`）。
- **修法**：正文与测试改用新名与新入参。**验证方式**：workbench 套件；真机 Creator 会话各跑一次目录查询与方法查询。

### 2.6 C6 内核 CSS 的注入时机后移，等特异性覆盖翻转 `[静态]`

- **类型**：行为（渲染）。**接触面**：6。**来源**：指南 `rc.2/client-module-metadata`；`α:packages/client/web/src/boot.ts:88-101`、
  `ui-renderer/src/client/renderer.ts:68-72`。
- **症状**：内核模块 CSS 改在 `uiRenderer.mount()` 时追加到 head 末尾，晚于各插件 `adoptStyles()` 注入的
  `<style>`；r5 是模块求值即注入、静态 seed 先于所有插件。**等特异性的覆盖从「插件胜」变成「内核胜」。**
  已定位一处：`plugins/plugin-todo/src/client/styles.ts:1089-1092` 的日面板 `margin-top: 0` 对上 alpha.1 新增的
  `.header + .body{margin-top:8px}`（`α:packages/client/ui-primitives/src/Modal.module.css:141`），同为 (0,2,0)。
  外壳 `#dsh-desktop-chrome` 的覆盖特异性更高，不受影响。
- **修法**：该选择器提高特异性。16 份插件样式表对 alpha.1 内核 CSS 未穷举 `[待验证]`。
- **验证方式**：真机打开日面板看 8 px 间距；`probe-settings-rail.mjs`、`probe-whale.mjs`、`probe-drag.cjs`。

### 2.7 C7 换线本体

20 个 manifest 的 `^0.2.2-rc.5` → 目标线（422 处）。清根与全部插件的 `node_modules` 与 lockfile，按根 → 插件
顺序重装；两处版本解析都落到新线。

**cordis 一家这次要动**（alpha.2 推翻了 alpha.1 的「不动」结论，§0.3）：alpha.2 的 dsh 钉
`@deepseek-ai/cordis ~4.2.0-alpha.1`、`@deepseek-ai/schemastery ~3.20.0-alpha.1`，我们消费的 34 个包的
peer 也随之写成 `~4.2.0-alpha.1`。本仓 `@deepseek-ai/cordis` 的 spec 是 `^4.1.0`（peer，×20）与 `4.1.0`
（devDependencies 精确钉，×19）；semver 只让预发布版本满足「同三元组上带预发布」的 spec，所以 `^4.1.0` 既够不到
4.2.0-alpha.1 的安装（pnpm 的 peer 检查会报不匹配），`4.1.0` 更让类型门禁按 4.1.0 查插件而内核跑 4.2.0。
换线日两处都改为目标线的写法（`~4.2.0-alpha.1`，RC 线若钉稳定版则随之）；`@deepseek-ai/schemastery` 本仓不直接
声明，不用动。若届时 cordis 已发稳定 4.2.x，`^4.1.0` 的 peer 范围能过，但 devDependencies 的精确钉仍要跟——
以预检 `peers` 一项为准（§6.4 之后它会报）。

### 2.8 C8 文档同步

`docs/ARCHITECTURE.md:353-375`（握手）、`docs/agents/security-invariants.md:21-24`（cookie 的来源）、
`docs/agents/kernel-line-regression.md:280`（办公载荷行）与 `:373-375`（`claimStyles` 一段——alpha.1 起内核不再
标记或移除插件自建的 `<style>`，`data-plugin-css` 在 `packages/client` 下 0 命中；本仓只有 rewind 自己打标自己查，
不受影响）、`docs/agents/build-and-release.md:23-36`、`plugins/dsh-app.patch.yml` 注释里过期的行号
（`base/cordis.patch.yml:115` 现为 `:123`）。

### 2.9 C9 Node 下限：打进运行时的 Node 要跟着抬（alpha.2 新增）

- **类型**：行为（安全）。**接触面**：7（子进程）与 CI。**来源**：指南 `alpha.1/node-24-22-3`；
  `α2:package.json` 的 `engines.node`；`scripts/build-runtime.mjs:409-424`。
- **症状**：alpha.2 起 dsh 要求 `^24.22.3 || >=26.13.1`（内置 undici 的 2026-11 安全修复）。本仓运行时里的 Node
  不是钉的版本，而是**构建时正在跑的那个**（`build-runtime.mjs` 的 `nodeDist` 用 `process.version` 从 nodejs.org
  取同版本二进制）——CI 与发版 workflow 五处 `node-version: '24.9'`，注释自己写着「0.2.2 的下限是 >= 24.9，
  build-runtime 打包的是正在跑的 node」。于是换线后出货的运行时仍是 Node 24.9.0 `[实测]`：本机已装内核目录里的
  `node/node.exe --version` 就是 v24.9.0。dsh 不在启动时断言 Node 版本（`α2` 只在 `startup-diagnostics.ts:43`
  记录 `process.version`），所以应用**起得来**——这正是它危险的地方：门禁全绿，而内核跑在一个上游已不支持的
  Node 上，带着 undici 那个已修复的漏洞。
- **修法**：`.github/workflows/ci.yml:38,202` 与 `release.yml:91,281,803` 的 `node-version` 改为 `'24.22.3'`
  （钉到下限而不是 `24.x`，与现有注释的理由一致：runner 不能滑到下限之下）；`AGENTS.md` §2「Node 22+（CI 跑的）」
  同步。`npm install` 在 24.9 上会报 EBADENGINE 警告但不失败（本仓无 `engine-strict`），所以这一条**不会被任何
  现有门禁拦住**——预检的 `engines` 现在会（§6.4）。
- **验证方式**：`node scripts/build-runtime.mjs <平台> <架构>` 后在产物目录跑 `node/node.exe --version`；
  `npm run check:preflight -- --npm <目标>` 的 `engines` 一项为 note；`npm run verify -- --tgz`。

## 3 值得移植（不修不影响运行）

### 3.1 `web_fetch` 的传输错误码分类

内核本地的 fetch provider 把网络失败拆成 7 个 `WEB_FETCH_*` 码（DNS、拒连、超时、证书、中断、不可达、其它）；
本仓的替代实现仍把其余传输失败折叠成 `WEB_PROVIDER_ERROR`（`plugins/plugin-websearch/src/fetch/transport.ts:348-355`）。
overlay 自称两者是 drop-in 替代，每演进一次就多一条差距。移植后诊断更具体。

### 3.2 设置页也会出现在「插件」页

alpha.1 起 `settings.section` 的条目在「插件」页上也会列出，且那里的 `close()` 只回退到上一个视图。本仓 11 处
注册里只有 `plugins/plugin-market/src/client/panel.tsx:289-332` 调用节级 `close()`，影响面小 `[待验证]`。

## 4 已查未变（负面证据）

### 4.1 预检各项 `[实测]`

`engines` 在 alpha.1 未变；**alpha.2 抬到 `^24.22.3 || >=26.13.1`**（§2.9）；`slots` 12 个注册 id 目标线全部声明（共 83 个）；`peers` 新增 4 个（`dsh-error` ×2、
`dsh-session`、`dsh-session-projection`）本仓 manifest 均已声明；`deps` 0 个错位钉版；`overlay` 6 / 19 全部仍有目标。

### 4.2 host 侧 API `[实测：已发布声明逐项 diff]`

外壳 `src/` 不导入任何 `@deepseek-ai/*`，只走 HTTP / IPC。套件用到的方法、事件与类型在 alpha.1 **签名未变**：
`ctx.subagents.*`（`startActivation` 两个重载、`sendMessage`、`interrupt`、`getProvider`、`prepareContinuable`、
`subagent/end|provider-added|provider-removed`）；`tools/pre-execute|execute|post-execute` 与 `Pre/PostToolDecision`；
`defineTool`、`ToolDefinition`、`presentCall/presentResult/presentationMeta`；`sessionProjections.register →
ProjectionHandle`、`ProjectionDefinition<K,S>`（`dsh-session-projection` 包字节一致）；`systemPrompt.section/context`；
`connection.fetch.register` 仍 exact-only、非 owner 403、Host/Origin 判定未变；`inputTriggers.registerSource`；
`officeKit.render` 与 `office_render|convert|recalculate`（`office_to_pdf` 是本仓自有工具）；`commands.register`；
`session/event` 与 `SessionEvent`；`createUserMessage/createSystemMessage`、`LlmRuntime.stream`；`dsh-web` 全部；
`workspace/session-activity|session-stop`、`fs/write-intent|edit-intent`；以及 `mcpManager.list`、`jobs.start`、
`configEditor.*`、`sessionQuery.searchSessions`、`sessionProjectionCache.cachedSnapshot`、`credentials.resolve`、
`sessionController.openWorkspacePath`、`directoryPicker`、`agentTeams`。被删的连接包符号
（`BrowserAuth`、`authorizeIndex`、`authenticatedUrl`、`cookieMaxAgeDays`）、被删的子路径
（`dsh-llm/brand`、`dsh-commands/brand`、`dsh-tools/presentation`）、`assertUsableApiKey`、`ctx.remote.mcpServers`
在本仓均 0 命中。预检 `services` 只判定 53 处里的 21 处，其余 32 处是 cordis 基类成员、Canvas 2D 的 `ctx.*`、
以及声明包不在下载集的真实服务——后者已手工逐个核过，alpha.1 均在。

**行为变了但签名没变**（归上游，换线日真机确认）：

- **系统消息改为分节更新**：后续 `system/message` 事件是分节更新而非完整提示词（指南 `rc.5/system-prompt-integrations`）。
  rewind 的表面投影本就把 `system/message` 纳入节点流（`plugins/plugin-rewind/src/projection.ts:176-183`），
  锚点按 user 源筛选，预计不受影响 `[待验证]`：真机走一次 recall 与归档列表。
- `SubagentError.code` 变为联合类型；swarm 只读 `error.code`，无需改。
- `mcp-manager` 条目新增可选的 `oauth`、`toolLoading`；本仓写入键仍合法。

### 4.3 client 侧 `[实测]`

primitives 在 alpha.1 **删除的导出名只有 `rankByName`**；本仓 client 半实际 import 的另外 27 个名字都在，
16 个组件里 14 个声明逐字节相同，`Switch` / `Menu` 只有纯增量。9 个上游座位的 kind / scope / owner 未变，
挂载点只有 `settings.section` 换了渲染路径。外壳注入依赖的 56 个 CSS 变量与一组子串类名
（`_frame`、`_centerCol`、`_logoRow`、`_titleRow`、`_footerActions`、`_backdrop`、`_close`、`_header`）两线都在
（CSS Modules 类名格式从 `_<local>_<hash>` 翻为 `<hash>_<local>`，我们的子串选择器不含尾下划线，仍能匹配）。
`__ModuleLoader__.load` 的门面与「注册 id 等于包名」规则未变。**所有渲染结果均未真机验证。**

### 4.4 runtime 构建与办公载荷 `[实测]`

`@deepseek-ai/dsh-office-kit` 仍精确钉 `@deepseek-ai/libreoffice-kit@0.2.3`（`dependencies`，非 optional / peer），
所以 `DESKTOP_OFFICE_KIT_VERSION` 不动、**两步发布顺序不触发**；kit 解析方式（`import.meta.resolve` + 动态
import）与占位包需要导出的东西不变，前提成立。上游 `packageManager`（pnpm 11.28.5）、`engines`、
desktop-host 的构建配置、四个 vendored 版本（cordis 4.1.0、schemastery 3.19.0、cosmokit 1.9.0、loader 1.1.0）
均未变；`@deepseek-ai/dsh-web-frontend@0.2.3-alpha.1` 已发布。

**其余 52 篇指南的关键词与命中数**（`git grep`，范围 `src plugins/*/src plugins/*/tests scripts test`）：
CUA 7 篇、cordis-root、两篇 package-export-cleanup、forge 3 篇、PTC 各篇、`create_worktree`、`parentSource`、
`facets`、`inspectSession|observeSession`、`working_directory`（仅注释）、`list_agents`（仅注释）、
`summaryEventSeq`、`OarFailure|NativeError`、`useSessionStatus`、`filesApiTimeoutMs`、`launchWaitMs`、
`imageMaxBytes`（仅 locale key）、`overlayPaths`、`cookieMaxAgeDays` → **均 0 命中**。

## 5 产品层决定（属业主，换线日前定）

| # | 决定 | 建议 | 依据 |
|---|---|---|---|
| D1 | 现在跟 alpha，还是等 `0.2.3-rc.1` | **已决（2026-11-22）：等到 RC 后再升线** | §0.2：跟 alpha 等于把 alpha 内核推给用户 |
| D2 | `remote-connection` 行禁用还是保留 | **禁用**（overlay 加一行 disable） | 宿主侧注册第三个认证 provider：30 天持久的浏览器 cookie 写入凭据库，认证通过者得到 **owner** 权限的 peer，并新增匿名 `POST /?login=qr` 与配对路由（`α:packages/client/remote-connection/src/index.ts:61-63,105-112`）。client 半遇到 `dshDesktop` 标记即返回（`…/src/client/index.ts:41`），本应用的设置栏不会出现这一行——**UI 不出现，宿主侧路由却照样挂上**。绑的是 127.0.0.1，但会在系统浏览器开出第二个绕过外壳的会话。先例：0.2.1 预适配的 W11 |
| D3 | `creation-recommendations` / `plugin-recommendations` 保留还是禁用 | **保留上游默认，换线后观察** | 前者注入 `pluginManager` 与 `subagents`，点「创建」后后台生成并安装插件；后者点「启用」即改写整个 profile，可能连带唤醒连接器。与 `plugin-market`、工作台的 Creator 入口职责相邻（见 `plugin-market-boundary.md`），但这是上游默认行为，没有证据表明它与本仓冲突 |
| D4 | `plugin-ppt` 的 `/` 菜单「文档」「表格」两行 | **合并为一行 `office`** | §2.3：两行指向的技能已不存在；模块的约束是「候选名即技能名」，两行同名会撞 |
| D5 | `cli-account` / `upstream-skills` | 保留 | 默认零动作；装了 CLI 应用类连接器后才会 spawn 厂商 CLI、从 `codeload.github.com` 下载 |

另：`tool-cordis`（standard 预设新增）会把行 id、插件名、Config 状态、`packageDir`（宿主路径）与 Config 的
JSON Schema 送进模型上下文，不返回配置值。属于 §1.1 的 (a) 类，跟随上游默认。

## 6 本轮判定与已做

### 6.1 可先行项：预适配本身零代码改动

| 候选 | 判定 | 理由 |
|---|---|---|
| C2 换 `TextSearchIndex` | 不先行 | 包只发布了 `0.2.3-alpha.1` |
| C2 自带一份排序器（vendor 旧实现） | 排除 | 与模块的设计意图冲突（「与其它分组同一规则」），alpha.1 上反而排序不一致 |
| C3 菜单与技能正文改指 `office` | 不先行 | r5 上会把模型指向错误的用法，且丢失三个格式技能的指导 |
| C3 拆 `stageOfficeSkills` | 并入换线轮 | §2.3：单独做要整轮复验，对已装用户零效果 |
| C1 宿主握手 | 不先行 | 现在改会让 r5 的宿主收不到它期待的 `303` 换取 |
| 已删包名的注释、`data-plugin-css` 扫描模式 | 不先行 | r5 上那些事实仍成立 |

### 6.2 已做：一个与本线无关的既有缺陷（按根 `AGENTS.md` §13「缺陷即修」）

调查中发现 `plugin-ppt` 与 `plugin-rewind` 的 6 处样式引用了**主题从未定义**的变量，且没有 fallback——
`--dsw-alias-danger-primary`（ppt ×2）、`--dsw-alias-state-warning-primary`（rewind ×3）、
`--dsw-alias-state-primary-primary`（rewind ×1）。CSS 里引用未定义的自定义属性会让整条声明在计算值阶段失效，
所以品牌输入的错误边框与错误文字、撤回确认框里「用户不能漏看的那句话」的 warn 色调、隔离区「created」标签、
图标焦点环，实际都没有上色 `[实测]`：三个名字在本仓与 34 个已下载内核包（r5、α）里 0 处定义。

修法（`plugins/plugin-ppt/src/client/styles.ts:434,438`、`plugins/plugin-rewind/src/client/styles.ts:65,155,181,275`）：
ppt 改用套件通行的 `var(--dsw-alias-state-error-primary, #dc2626)`；rewind 的样式表测试禁止任何十六进制颜色
（`tests/styles.test.ts:122-126`），故只用令牌——`--dsw-alias-state-warn-label`（主题的文字语义令牌）与
`--dsw-alias-brand-primary`（套件 8 处焦点环的写法）。版本 `plugin-ppt` 0.3.7 → 0.3.8、`plugin-rewind`
0.2.1 → 0.2.2（`suiteVersion` 由 `d08aad63` 变为 `12b9efd2`），片段 `changesets/theme-token-names.md`。

验证 `[实测]`：两插件重建成功；`plugin-ppt` 套件 216/216；`plugin-rewind` 套件 **194/194（第一次跑红过 1 项，
原因是我按别处写法加的十六进制 fallback 撞了它自己的禁令，改掉后重跑通过）**；`plugin-gates` 两插件四道门全过
（0 skip）；`plugin-version-bump` 与 `changeset-gate` 根测试通过，片段用门禁自己的解析器解析通过；
`check:graph` / `check:suites:gate` / `check:slots` / `check:touchpoints:gate` 全 exit 0；
`undefined-tokens.mjs` 在 r5 与 α 两条线上扫描 1620 处 `var()`，除一条文档注释外 0 命中。颜色未在真机目视。

### 6.3 加固排期（不做，记下设计）

1. **套件级令牌门禁。** 同类缺陷已是第二次：`plugin-codegraph/tests/styles.test.ts` 的头注释记着上一次，
   当时只给那一个插件加了测试。把 `undefined-tokens.mjs` 的逻辑搬成根测试，覆盖 19 个插件与外壳；
   令牌真源取已安装主题包（只存在于插件本地 `node_modules`，CI 树上要按 `unjudged` 处理，口径同
   `check:slots`）；要排除注释行与带 fallback 的引用。
2. **载荷身份纳入 wheel 集摘要。** §2.4 的缺口：改了 Python 包集合而已装用户不重下。会牵动两步发布顺序，
   等下一次必须动 wheel 集时一起做。
3. **既有的陈旧项**（不伤用户，换线日顺手清）：`src/main/window.ts:533` 的灯箱选择器两线都匹配不到；
   `scripts/probe-drag.cjs:150` 采集的 `data-plugin-css` 事实在 r5 上就恒为 false（无断言引用）；
   `scripts/runtime-stubs/libreoffice-kit/index.js:5-9`、`scripts/build-runtime.mjs:671-673`、
   `scripts/kernel-preflight.mjs:1074` 的过期注释。

### 6.4 已做：预检的两处盲区（2026-11-23，alpha.2 复跑时暴露）

alpha.2 的两条必改项预检当时都**读成没问题**，各因为一处实现取了捷径：

- `engines` 只比大版本（`scripts/kernel-preflight.mjs` `checkEngines`）：`>=24.9` → `^24.22.3` 大版本不变，于是
  CI 的 `24.9`「合格」。改为按范围判：CI 的 `node-version` 本身就是 semver 范围（`24` 是整个大版本、`24.9`
  是一条小版本线、`24.22.3` 是一个版本），与下限无交集即 blocker。alpha.2 上现在报 `CI runs 24.9`；当前线
  （`>=22.19.0`）仍 note。
- `peers` 只比名字（`checkPeers`）：cordis 已声明就过了，而目标的范围已是 `~4.2.0-alpha.1`。改为对 cordis 一家
  （`NON_LINE`）已声明的 peer 逐 spec 判「本仓 spec 能否被目标范围会装上的版本满足」——预发布范围按其最低版本
  判（semver 只让预发布满足同三元组上带预发布的 spec，所以 `^4.1.0` 与 `4.1.0` 都够不到 4.2.0-alpha.1），稳定
  范围按交集判（`~4.1.0` 会装最新的 4.1.x，`^4.1.5` 能过）。线上的包不在此项（归 `line`）。alpha.2 上现在报
  `@deepseek-ai/cordis ~4.2.0-alpha.1 ← 本仓声明 ^4.1.0, 4.1.0`；当前线 0 条。

两处各补单测（`test/kernel-preflight.test.mjs`，17/17）；`kernel-line-regression.md` §1 的两行同步。`semver` 是根
已有的依赖，无新增。

## 7 本机 profile 供应链前瞻 `[实测]`

`npm run profiles:peers -- --kernel 0.2.3-alpha.1`（只读，`~/.dsh`）：

- `dsh-app`：**`dsh-ops` 0.5.5 在 0.2.3 线上会被启动拒绝**——peer 上限 `>=0.2.2-rc.1 <0.2.3-0`，将来的
  `0.2.3-rc.1` 同样不满足。其余 ok；`@local/dsh-sysmon`、`dsh-session-header`、`dsh-thinking-translator`
  为本地 / git 规格，无法判定。
- `web`：全部 ok 或无法判定；`@deepseek-ai/dsh-tool-session-query` 属内核自带集合，换线日用
  `dsh plugin --profile web update …` 跟随。

换线日按 `profile-supply-chain.md` 的固定流程走：等作者发布兼容版，或显式 `allow-version … --accept-risk`。

## 8 换线日的执行顺序

1. **前提**：目标版本（`0.2.3-rc.1`，或业主决定跟的 alpha）在对应 dist-tag 上全量发布；对它重跑
   `npm run check:preflight -- --npm <版本>`，与本文对照后再动代码。预检自 2026-11-23 起按范围判 `engines` 与
   cordis 一家的 `peers`（§6.4），这两条不必再靠人眼。
2. **裁决** D1–D4；D2 若禁用，overlay 加 `remote-connection` 的 disable 行。
3. **先改不依赖安装的**：C1 宿主握手（认证边界，独立安全审查）；C3 拆暂存；C4 锁同步；C5 技能正文；
   C6 选择器特异性；**C9 workflow 的 Node 下限**（`ci.yml` ×2、`release.yml` ×3 → `24.22.3`）。
4. **换线**：C7（含 cordis 一家的 spec）。
5. **依赖新线的代码**：C2（含 client 半内联与 devDependency）、C3 的菜单行与技能正文、探针与测试夹具
   （office-menu、probe-routes、host-arg-shape、host-web、kernel-preflight）。
6. **门禁**（全部裸跑）：`npm run typecheck` → 19 个插件 `build` + `test` + `plugin-gates` → `npm test`
   （先清 `PATH` 里含 `pnpm` 的段）→ `check:graph` / `check:suites:gate` / `check:slots` / `check:touchpoints:gate`
   → `check:preflight --line-policy=exact`。
7. **runtime**：`npm run runtime:build` 与 `npm run primary-runtime:build` → 产物目录里 `node/node.exe --version`
   必须是 `v24.22.3` 或更高（C9 的验收句）→ `verify --tgz` → `check:plugins`，
   并**显式检索启动日志**里的 `patch: entry … not found`、`invalid entry options`、`invalid config`
   （后两条是新校验的文案，不在 `check:plugins` 的失败规则里）→ 探针 `probe-routes.cjs`、`probe-workbench.cjs`、
   `probe-office-menu.cjs`、`probe-whale.mjs`、`probe-settings-rail.mjs`、`probe-settings-nav.cjs`。
8. **真机** M1–M5 + 渲染面每插件判定；重点看四处：握手起得来、设置页出现在插件页后的 `close()`、
   rewind 在系统消息分节更新下的锚点、日面板间距。
9. **发布**：changesets 与插件版本 bump；载荷资产按新内核版本上传（kit 钉版不变，不走两步顺序）。
10. **收尾**：C8 文档同步；本文改 Status 并把执行记录归档到 `docs/archive/kernel-line/`。

## 9 未验证项与风险

- **没有启动过 alpha.1 / alpha.2 内核。** 所有「会不会坏」的结论来自已发布声明、源码与指南；握手超时、`ready.url`
  不带 cookie 时的状态码、C6 的 8 px 间距、C2 内联后的菜单排序，全部 `[待验证]`。alpha.2 还多一条：Node 24.22.3
  下运行时与各原生模块（office kit、pty 等）的实际行为未验——上游自家桌面应用就是这么出的，预期满足。
- **宿主构建未跑**：`tsc -b apps/desktop-host/tsconfig.json` 在 `--filter` 安装树上跨新增的 references 是否通过，
  以及 host 把 `dsh-api-workspace-files` 打进 bundle 后的运行期闭包。
- **CI 的 pnpm 是 11.7.0**，上游检出的 `packageManager` 是 11.28.5——既有偏差，进入检出后是否自动切换未验。
- **等特异性覆盖未穷举**（§2.6），这是渲染面的固有盲区，只能真机看。
- **rewind 在分节更新下的投影**（§4.2）。
- **`dsh-deepseek-auth` 行的 Config 定义未定位到**，该无 config 行能否启动未核实；上游自家 desktop 同为
  base + web-app，预期满足。
- 预检自身的盲区未变：架构位移、渲染与运行期，以及**私有宿主的契约**——C1 这种断裂今天没有任何门禁能看见，
  `test/host-arg-shape.test.mjs` 的夹具模拟的是旧约定。C1 落地时顺手让夹具跟上 alpha.1 的握手，这条盲区才收窄。

## 10 未采纳的调查结论

- 「`subagent` 行在 alpha.1 新增了 `maxDepth`（默认 1）」——**不成立**：r5 的
  `packages/subagent/subagent/src/index.ts:196` 已有同一条，默认值相同。本仓对该行的 override 行为不变。
- 「`probe-drag.cjs:150` 升线后恒为 false」——不准确：该标记在 r5 上就已不存在，是既有陈旧项（§6.3）。

---

## 相关文档

| 文档 | 用途 |
|---|---|
| [`../agents/kernel-line-regression.md`](../agents/kernel-line-regression.md) | 流程判据、门禁与盲区、升线清单 |
| [`kernel-0.2.2-alpha.2-preflight.md`](kernel-0.2.2-alpha.2-preflight.md) | 上一次针对 alpha 版本的预适配（性质相同） |
| [`kernel-0.2.2-rc.2-upgrade.md`](kernel-0.2.2-rc.2-upgrade.md) | `runtime/office-skills` 暂存的来历与推迟理由 |
| [`../agents/profile-supply-chain.md`](../agents/profile-supply-chain.md) | 换线后本机 profile 的固定流程 |
| [`plugin-market-boundary.md`](plugin-market-boundary.md) | 与上游推荐/插件页重叠时的边界判据 |
