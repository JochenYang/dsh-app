# 内核线 0.2.0-rc.2：适配清单与官方客户端可移植项

> 立项 2026-09-29。上一轮（0.1.7-rc.2 → 0.2.0-rc.1）的调研、执行与台账在
> [`kernel-0.2.0-rc.1-upgrade.md`](kernel-0.2.0-rc.1-upgrade.md)，本文只写**这一轮新增的**：
> rc.2 要做什么、官方客户端那份变更清单里我们能拿走什么。
>
> **证据标记**：`[实测]` = 命令真跑过；`[静态]` = 源码阅读（上游检出 `D:\codes\deepseek-harness`
> 已到 `0.2.0-rc.2`，HEAD `639ed01539`）。实施时逐条复验。

---

## 0 事实基线 `[实测]`

```
npm view @deepseek-ai/dsh dist-tags   → { alpha: 0.1.7-alpha.2, latest: 0.2.0-rc.2, next: 0.2.0-rc.2 }
npm view @deepseek-ai/dsh versions    → 0.2.0-rc.1, 0.2.0-rc.2
检出 dsh-v0.2.0-rc.1..dsh-v0.2.0-rc.2 → 187 个提交
我们仓库                             → 根 spec 与 16 插件 peer/dev 仍是 ^0.2.0-rc.1（v0.14.4 已发）
runtime-dist 未见 rc.2 产物            → 0.2.0-rc.2 的运行时还没切
```

一条容易误判的事：`^0.2.0-rc.1` **是接受 rc.2 的**（同一 `[major,minor,patch]` 的预发布版本在
caret 范围内）；真正钉住 rc.1 的是 **lockfile**。所以「跟不跟 rc.2」是一次显式决策，不是
`npm install` 的自然结果——要跟就必须同时改 spec、重建 lockfile、重跑门禁（上一轮 §1.4 的
那套教训仍然适用：插件的 peer/dev 也必须一起升，否则插件继续编译在旧线上）。

---

## 1 这一轮要做什么

### 1.1 rc.2 升级本身（照搬上一轮的骨架，只列差异）

| 步骤 | 与 rc.1 那轮的差异 |
|---|---|
| 版本线 bump | 根 24 个 spec + 16 插件 peer/dev：`^0.2.0-rc.1` → `^0.2.0-rc.2`；lockfile 重建（换线必须清 `node_modules`，见 `AGENTS.md` §3） |
| 运行时重建 | `npm run runtime:build` 的产物要证明来自 rc.2：`dshVersion` 与 `app/node_modules/@deepseek-ai/dsh/package.json` 都是 `0.2.0-rc.2` `[实测于 rc.1 的同法]` |
| 自动门禁 | `typecheck` / `test` / `check:graph` / 16 插件套件 / `verify --tgz` / `check:plugins` |
| 真机 M1–M5 | 与上一轮相同（启动到 ready、设置跨重启存活、定时任务、市场装卸、办公载荷） |
| 收尾 | `changesets/*.md`（`shell: patch`）+ `AGENTS.md`/构建文档里若有版本号则同步 |

### 1.2 rc.2 专属的两条门禁（**升级前先跑，零代码**）

1. **`schedule` / `ui-schedule` 是否仍在 CLI 闭包内** `[静态]`：上游把「自动化任务」描述为
   *可选插件包*（`@deepseek-ai/dsh-experimental-schedule-bundle`，`packages/experimental/schedule-bundle/cordis.patch.yml:13-16`），
   而我们的 overlay **以 insert 直挂同两个包**（`plugins/dsh-app.patch.yml:303-308`，`schedule` + `ui-schedule`），
   且 profile 不列那个 bundle。两包当前都在 `apps/cli/package.json:42,57` 的闭包里 `[静态]`；
   一旦某线把它们移出闭包，insert 会让**整棵插件树** `ERR_MODULE_NOT_FOUND`（先例见
   `plugins/dsh-app.patch.yml:261-262` 的注释）。所以升线后第一条门禁就是
   `npm run check:plugins -- --kernel <新 tgz>` + M3 探针（`scratch/probe-schedule-ui.mjs`）。
2. **`desktop-product-telemetry` / `product-analytics` 的守护方式是否变化** `[静态]`：我们是靠
   overlay 显式 `disabled: true` 关掉的（`plugins/dsh-app.patch.yml` 里那两条，理由见
   `docs/kernel-0.2.0-rc.1-upgrade.md` 阶段 3）。升线后要复验：这两行仍由 `dsh-web-app` 携带、
   我们的覆盖仍生效、启动日志**零条** `did not activate`。

### 1.3 不做

- 不 fork 内核、不改内核源码（铁律）；所有适配仍走外壳注入、样式与 profile patch 行。
- 不在这一轮打开上游的整包升级模型（我们两条解耦通道的取舍见 rc.1 文档 §3）。

---

## 2 官方客户端那 19 条：我们已有 / 归上游 / 值得移植

判定口径：**已有等价** = 我们仓库里已有同样效果（含我们自己的实现）；**归上游** = 内核 bundle
自带，随线升级到位，不需要我们写代码；**值得移植** = 上游做在外壳/桌面端一侧、我们没有。

| # | 条目 | 判定 | 依据（文件:行） |
|---|---|---|---|
| 1 | 对话实时动画/用时/过程间距 | 归上游 | 上游 `ui-chat/src/client/locale.ts:65`、`ui-chat/README.zh.md:98`；我们的注入无过程行规则 |
| 2 | 图片失效自动重传 | 归上游 | 上游 `llm-deepseek/src/file-store.ts`、`tests/runtime.spec.ts:839-877`；我们无附件链路 |
| 3 | 更新提示补版本/下载/重试 | **已有等价** | `src/main/updater.ts:135-175,437-464`、`src/shared/locale.ts:184-231`；内核卡 `src/main/update-card.ts:183-273` |
| 4 | 未命名会话 / 重命名空输入 | 归上游；**归档页可对齐** | 上游 `ui-workspace/src/client/locales.ts:12`；我们归档页自绘短 id `plugins/plugin-archives/src/client/archives-section.tsx:83-88` |
| 5 | 插件管理/内置插件界面/安装引导 | 归上游 | 上游 `ui-plugin-manager/README.zh.md:30,44,58-60`；我们的市场是自有抽屉（`plugins/dsh-app.patch.yml:51-56`） |
| 6 | 深色开关对比度 | 归上游；**可临时覆盖** | 上游 `ui-theme/README.zh.md:68`、`ui-primitives/README.zh.md:44`；我们只覆盖菜单面 token（`src/main/window.ts:429-436`） |
| 7 | Office/PDF 预览选区 | 归上游 | 上游 `ui-sidebar-documentpreview/.../PdfBody.module.css:113-118`；我们的 doc/sheet/pdf 只生成文件、不预览 |
| 8 | 插件配置保存等待时间 | 归上游 | 上游 `ui-plugin-manager/README.zh.md:58-60`；我们的设置经内核配置编辑器写 patch |
| 9 | 创造模式指引 + 体验技能 | 归上游 | 上游 `ui-agent-preset/src/client/guide-locales.ts:132-151`、`apps/cli/package.json:74` |
| 10 | 账号模型免 Key 网页搜索 | **已有等价** | 我们默认链全 free 层（`plugins/plugin-websearch/src/wire.ts:403-431`）；`docs/kernel-0.2.0-rc.1-upgrade.md:460` 有全新 home 实测 |
| 11 | Windows 沙箱权限诊断技能 | 归上游 | 上游 `packages/sandbox/sandbox-windows-acl/*`、`sandbox-local/package.json:36` |
| 12 | 工具调度异常后继续/不盲重试 | 归上游 | 上游 `packages/core/session/README.zh.md:160`（`TOOL_OUTCOME_UNKNOWN`）、`agent-loop/README.zh.md:198` |
| 13 | **弹窗/菜单/浮层避让标题栏** | **值得移植（最高）** | 上游通用机制 `ui-layout/src/client/AppFrame.module.css:93-113` + 标记由官方 preload 设（`apps/desktop/src/preload-windows.ts:9-13`）；我们 **0 命中**，只有逐点补偿（`src/main/window.ts:340,348,415,418,429-436`） |
| 14 | Windows 打开/定位文件 | 归上游；我们两条路各不同 | 上游 `packages/util/native-command/src/path-opener.ts:139,307`；我们的 `open-logs` 走 `shell.openPath`（`src/main/shell-actions.ts:428-439`），套件 `native-actions.ts:101-114` 带 30s abort |
| 15 | macOS 录音权限 | 无关（我们无录音） | `docs/kernel-0.2.0-rc.1-upgrade.md:217`；留意：CLI 闭包含 `dsh-experimental-voice-input-bundle`（`apps/cli/package.json:103`） |
| 16 | Safari 刷新恢复回复 | 无关（只跑 Electron/Chromium） | 窗口只加载 `dsh-app://app`（`src/main/desktop-host.ts:79-81`） |
| 17 | Linux 缺可选原生包致安装失败 | 归上游 | 上游 `native/system/packages/entry/package.json:40-45`；我们 runtime 用 pnpm 组装（`scripts/build-runtime.mjs`） |
| 18 | 自动化任务改可选包 | **已有等价** | 我们 `plugins/dsh-app.patch.yml:303-308` 直挂同两包；见 §1.2 门禁 |
| 19 | 工作过程展示默认值 | 归上游 | 上游 `ui-settings-account/src/client/locales/onboarding.ts:21-33` |

---

## 3 移植候选（按性价比）

### P0 · 接入上游的标题栏标记（`#13`）

**收益**：一处注入换掉我们现在**逐点补偿**的一长串规则（`window.ts:340,348,415,418,429-436`），
让内核的菜单、下拉、弹窗、停靠浮窗在新线上**通用地**避开我们那 36px 原生控件条。

**做法**：在 win32 时由外壳注入链（`src/main/window.ts:291-295`；子窗同链 `:907-917`）给
`document.documentElement` 设
`data-windows-titlebar` + `--dsh-windows-titlebar-height: 36px`。上游据此推导
`--dsh-frame-top-clearance` / `--dsh-frame-overlay-top`（`AppFrame.module.css:93-113`）。

**风险与代价（这是它排 P0 但必须单独排期的原因）**：设上标记等于**打开整套 Windows caption 布局**——
frame 的 `padding-top`、折叠侧栏轨道移除、16px 圆角、`::before` 拖拽条（`AppFrame.module.css:26-55`、
`AppFrame.tsx:168-170`）。它会与我们现有的拖拽/补偿规则**重叠**。回归面：小窗口（900×600）、
全屏（`[data-fullscreen]` 分支 `module.css:109-113`）、设置页弹窗、日程子窗、以及
`scripts/probe-drag.cjs` 必须同步（`test/desktop-chrome-css.test.mjs:25-38` 会读它）。

**验收**：① 小窗/全屏下顶部内容不再被控件条遮挡（探针：`probe-settings-nav.cjs --sweep` 的
面板 top 断言 + 新增一条「任一浮层的 bounding box 不与 y<36 相交」）；② 拖拽仍只发生在
预留条内；③ 既有补偿规则若已冗余则同提交删除，不留两套。

### P1 · 升线前置门禁（`#18`，零代码）

见 §1.2 第 1 条：升到 rc.2 前先跑 `check:plugins` 与 `probe-schedule-ui.mjs`，确认两包仍在闭包内。
**验收**：两包在产物里（`tar -tzf … | grep dsh-client-ui-schedule`）+ 组合树里两行都在。

### P2 · 归档页「未命名」对齐（`#4`，低成本）

`plugins/plugin-archives/src/client/archives-section.tsx:83-88` 的 `rowTitle` 改为无标题时显示
「未命名」（该插件自有 locale）。代价：插件版本 bump + `changesets/*.md` 片段
（`plugins/AGENTS.md:88-95`）。**验收**：归档页一条无标题会话显示「未命名」。

### P2 · 深色开关 token 临时覆盖（`#6`，可逆）

在 `DESKTOP_CHROME_CSS` 里覆盖 `--dsw-alias-switch-thumb`（先例：`window.ts:429-436` 的菜单面覆盖）。
**明确标注为过渡项**：上游正式版若已修好，升线后删除，避免与上游漂移。改 CSS 必须同步
`scripts/probe-drag.cjs`。

### P3 · 更新文案逐字对齐（`#3`，可选）

只有产品要求与官方措辞一致时才动 `src/shared/locale.ts` 的 `updater.*`；功能上**已等价**。

### 不推荐

`#7` 预览选区：上游类名是 CSS-module 哈希，覆盖脆弱、收益小（我们不做预览渲染）。

---

## 4 实施顺序

1. **P1 门禁**（升线前）→ 2. **rc.2 升级**（§1.1，含 §1.2 两条专属门禁）→ 3. **P0 标题栏标记**
（单独一个提交 + 窗口级回归）→ 4. **P2 两项**（各自带片段）→ 5. 需要时再评估 P3。

## 5 风险与不做项

- **P0 是行为切换**，不是加法：它的回归面覆盖窗口布局本身，必须先在小窗/全屏/弹窗三处验过。
- **升线不能顺手做**：rc.2 与我们已发的 v0.14.4 是两条通道——外壳改动要靠新 tag，运行时改动
  要靠新的 `suiteVersion`/`dshVersion`（见 `docs/agents/release-checklist.md` 的两条教训）。
- **不做**：fork 内核、打开整包升级、把官方 preload 的私有通道搬进我们的壳（`account-preload.ts`
  只暴露一个冻结标记，任何新通道都要过安全评审，见根 `AGENTS.md` §4）。

---

## 6 实测台账（2026-09-30）

升线本体按 §1.1 走完，产物已建。本节只记数字与判据来源，方便下次换线照抄。

### 6.1 依赖与产物 `[实测]`

| 项 | 值 |
|---|---|
| spec 改动 | 304 处 `^0.2.0-rc.1` → `^0.2.0-rc.2`（根 23 + 16 插件 281）；`@deepseek-ai/cordis` 保持 `^4.0.4` |
| 重装 | 旧 lockfile 直接 `npm install` **ERESOLVE**：`peer @deepseek-ai/dsh-agent@"0.2.0-rc.1" from …preset-registry@0.2.0-rc.1`；清根与 16 插件 `node_modules`+lockfile 后全部 exit 0，根与插件本地都解析到 `0.2.0-rc.2`（无版本偏斜） |
| 运行时产物 | `runtime-dist/dsh-runtime-win32-x64-0.2.0-rc.2.tgz` 96.6 MB / 13076 文件（293.0 MB 展开）；`office-payload-win32-x64-0.2.0-rc.2.tgz` 0.1.2 / 70.5 MB |
| manifest | `dshVersion 0.2.0-rc.2`、`suiteVersion 7ca94399`（插件代码未动，版本未 bump，故 suiteVersion 不变）、`node 24.18.0` |
| 树内版本 | `app/node_modules/@deepseek-ai/dsh` = `0.2.0-rc.2`，`dsh-web-frontend` = `0.2.0-rc.2` |
| host 源 | `D:\codes\deepseek-harness` 在 tag `dsh-v0.2.0-rc.2` 的一次性 worktree（commit `639ed01539`，`build-runtime.mjs` 自己建、用完删；**不需要手工建 worktree**） |

### 6.2 门禁

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 0 error |
| `npm test` | 485 用例 / 484 pass / 1 skipped / 0 fail |
| `npm run check:graph` | `ok — no violations`（`followed line ^0.2.0-rc.2`） |
| 16 个插件套件 | 全部 ok（如 websearch 92 pass、brand 31 pass） |
| `npm run verify -- --tgz …rc.2.tgz` | `smoke: all checks passed`（mode=tgz，逐条路由与 artifact 断言全绿） |
| `npm run check:plugins -- --kernel …rc.2.tgz --home scratch/realcpy2` | 通过，内核 5.1s 就绪、无失败信号 |

§1.2 的两条专属门禁：

1. **schedule**：树内 `dsh-schedule` 与 `dsh-client-ui-schedule` 都在（`tar -tzf`）；`scratch/probe-schedule-ui.mjs`
   对着新解出的 rc.2 树 **PASS** —— client 半在服务端 index 里、`skipped-patch lines: (none)`、
   `activation failures: (none)`、`log lines mentioning ui-schedule: (none)`。插入式两行在 rc.2 上不再产生
   `patch: entry "ui-schedule" not found`。
2. **遥测**：`dsh-host-product-telemetry-otel` 仍在树内（所以 overlay 的 `disabled: true` 仍是必需的），
   真机启动**零条** `did not activate`。

> 注意 `check-plugin-compat.mjs` 的失败规则里**没有** `patch: entry … not found` 这一类文案（规则只收
> `ERR_*` / `Cannot find module` / `duplicate …` / `failed to load|start` / 缩进堆栈行），所以它“通过”
> 不能替代这两条；要显式 grep 启动日志。

### 6.3 真机 M1

全新 `DSH_HOME`（`scratch/fresh-home-rc2`）+ `DSH_APP_DEV_KERNEL=<新解出的 rc.2 树>`：

```
[kernel] local kernel: dsh 0.2.0-rc.2+suite 7ca94399
[host]   dsh host: argv shape runtime-and-project (host package 0.2.0-rc.2)
[host]   dsh host ready (web transport)          ← 约 3s
```

`did not activate` / `patch: entry` / `ERR_` / `Cannot find module` / `duplicate` 各 0 条。

### 6.4 一条会误导人的环境现象

换线清 `node_modules` 后第一次 `npm test` 有 4 个文件红（`home-rows` / `host-arg-shape` /
`host-stream-auth` / `log-redaction`），报的是 `Electron failed to install correctly` +
`failed to create …\electron\dist\locales\*.pak: 拒绝访问 / 文件存在`。原因是重装后 electron 的
`dist/` 还没解出来，而 node 的测试运行器**并发**跑这四个文件，四个进程各自触发
`node_modules/electron/index.js` 的 `install.js`，在同一目录里互相踩踏。`dist/` 补齐（55 locales +
`electron.exe`）后单独重跑这 4 个文件 59 pass，再跑整套 485 全绿 —— **不是 rc.2 回归**，换线后
要么先手动补 `dist/`，要么不要并发起跑。

### 6.5 未做

- `bundled-kernel/` 仍是本地旧产物（dev 日志里的 `bundled 0.2.0-rc.1` 来自它）：它是打包期由
  `prepare-bundled-kernel.mjs` 从 `runtime-dist/` 里**最高 semver** 的 tgz 生成的（现在已是 rc.2），
  不需要提交，也没有仓库内改动。
- §3 的移植候选（P0 标题栏标记、P2 归档页「未命名」、深色开关 token 覆盖、更新文案）本轮未实施，
  它们与升线解耦，各自单独提交。
