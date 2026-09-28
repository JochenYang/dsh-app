# 内核线升级 0.1.7-rc.2 → 0.2.0-rc.1

> 立项 2026-09-28。范围：跟随线从 `0.1.7-rc.2` 升到 `0.2.0-rc.1` 的依赖升级、
> runtime 重建、自动门禁与真机验证。
>
> **证据标记**：`[实测]` = 用命令真实跑过、有可复现输出；`[静态]` = 源码阅读，实施时必须复验。
>
> **使用方法**：§1 是升级前的调研结论；§2 是执行清单（带复选框）；§3 是评估过但不做的项；
> §4 是回归清单；§5 是风险与未验证项；§6 是执行台账，边做边填。
>
> **一条约束**：任何条目标记为 `[~]`（已改未审）时，不得进入下一阶段。

---

## 1 升级前的调研结论

**这是一次版本升级，不是移植改造。** 依据是升级前在 `0.2.0-rc.1` 上跑过的完整验证。

### 1.1 我们的代码在新线上编译与测试全绿 `[实测]`

做法：根 `package.json` 的 24 个 `@deepseek-ai/*` 依赖从 `^0.1.7-rc.2` 改到 `^0.2.0-rc.1`，
**同时**把 16 个插件 `package.json` 里的 `^0.1.7-alpha.2` 也改到 `^0.2.0-rc.1`（原因见 §1.4），
然后清空根与全部插件的 `node_modules` + lockfile 重装：

```
外壳   npx tsc --noEmit -p tsconfig.json    → 0 error
插件   16 个插件逐个 tsc --noEmit           → 全部 0 error
根测试 npm test                             → 458 pass / 0 fail
插件   16 个套件测试                         → 1,243 pass / 0 fail（全绿）
```

上游这一版列出的破坏性接口变动**没有一处打到我们的代码**。逐条核对过（`[实测]`）：

| 变动 | 我们是否用到 |
|---|---|
| 会话契约删除 `atSeq` / `increaseTitle` | 未使用 |
| 遥测体系重构（`SessionEventMap` 新增必需键等） | 未使用（`plugin-brand` 里只有一句 doc 注释提到 telemetry） |
| 账号凭证新增 `getDeviceIdentity` 抽象方法 | 未使用（我们不实现该基类） |
| 沙箱 `SelectedRunner.provider` 变必需 | 未使用 |
| `TextShimmer` / `useAnchoredPosition` / `refreshStatus` / `transcriptView` / `MessageSubmission` | 未使用 |
| 模型与账号设置页的 `track` 字段 | 未使用 |
| `session-log-deepseek` 的 `enabled`/`maxBytes` 变必需 | 未使用 |
| 8 处新增**可选**配置字段 | 向后兼容，无需动作 |

### 1.2 我们依赖的运行期契约全部存活 `[实测]`

内核升级最危险的是"编译过但运行期名字没了"。逐条核对了我们依赖的 12 个 API 与 6 条行为假设：

```
app-boot 导出面（12/12 存活）：
  ✓ loadProfileDirectory  ✓ readProfilePatches  ✓ composeEntries
  ✓ applyEntryPatches     ✓ bundlePatchPaths    ✓ bundlePatchFiles
  ✓ loadOverlayPatches    ✓ reportSkippedBundles ✓ resolveBundleDir
  ✓ writeProfileBundles   ✓ reconcileProfilePlugins ✓ requiredStartupEntryIds

行为假设（6/6 成立）：
  ✓ insert 是纯追加（applyEntryPatches）
  ✓ patch 必须是顶层数组（否则抛错）
  ✓ skippedBundles 降级路径
  ✓ requiredStartupEntryIds 抛错
  ✓ reconcileProfilePlugins 保留模板条目
  ✓ readProfilePatches 的层顺序（bundle 层在前、profile patch 在后）
```

我们 29 个上游依赖包在新线里**一个不少**。`test/plugin-kernel-imports.test.mjs`（专门检查
"运行期名字是否还在"的那道门）在新线下 **1/1 通过** `[实测]`。

### 1.3 宿主协议号的变化不构成阻塞 `[实测]`

上游把宿主协议常量提到了 `4`，而我们在 `src/main/desktop-host.ts:84` 硬编码 `3`。**这条不影响我们**：

- 那个常量是**发布元数据字段**，不是 shell↔host 的线上协议；
- host 发 `ready` 消息时**不带** `protocolVersion`（新旧两版都是
  `{ type: 'ready', url, injections }`）；
- 我们的 `HOST_PROTOCOL_VERSION = 3` 只在那条 `protocolVersion` 分支上被比较，而那条分支
  属于 **frames transport**；`0.2.0-rc.1` ≥ `0.1.6-alpha.2`，我们走 **web transport**，
  该分支不执行。

### 1.4 方法纠正：插件有自己的 `node_modules`，必须一起升 `[实测]`

**这是本次升级最容易漏的一步。** 第一轮验证时只改了根 `package.json`，插件 `tsc` 报 0 error，
差点据此下"插件也没问题"的结论——**那是错的**：

```
$ node -e "require('./plugins/plugin-archives/node_modules/@deepseek-ai/dsh-client-connection/package.json').version"
0.1.7-alpha.2                     ← 插件本地装的是旧线
```

插件目录有**自己的** `node_modules`（`plugins/AGENTS.md` §2 的规矩：插件本地装、不在根装），
而它们的 devDeps 写的是 `^0.1.7-alpha.2`。所以第一次的"16 个插件 0 error"测的是**旧线**。

**并且 `^0.1.7-alpha.2` 不接受 `0.2.0-rc.1`**（`[实测]`）：

```
semver.satisfies('0.2.0-rc.1', '^0.1.7-alpha.2', {includePrerelease:true})  →  false
```

即插件的 devDeps/peer **必须一起升**，否则插件永远编译在旧线上、而运行时加载的是新线——
一个编译期看不见的版本偏斜。改完重装后复验：插件本地解析到 `0.2.0-rc.1`，
16 个插件 typecheck 与测试全绿（§1.1 的数字即改后的结果）。

### 1.5 "自动化任务改由可选包提供"不影响我们的 overlay `[实测]`

这条最容易被误读成"`schedule` 没了"。实测：`@deepseek-ai/dsh-schedule@0.2.0-rc.1` **仍在**，
我们 overlay 的 insert 行仍有目标。仍进回归（§4 M4）。

---

## 2 执行清单

### 2.1 版本线 bump

| 编号 | 条目 | 状态 | 说明 |
|---|---|---|---|
| U1 | 根 `package.json` 的 24 个 `@deepseek-ai/*` → `^0.2.0-rc.1`（`@deepseek-ai/cordis` 保持 `^4.0.4`） | `[x]` | — |
| U2 | 16 个插件 `package.json` 的 `^0.1.7-alpha.2` → `^0.2.0-rc.1`（peer **与** dev） | `[x]` | 不能漏，见 §1.4 |
| U3 | 清空根与全部插件的 `node_modules` + lockfile，按 §2.2 重装 | `[x]` | — |
| U4 | 核对根与插件本地都解析到 `0.2.0-rc.1` | `[x]` | 验收判据见下 |
| U5 | `npm run typecheck` + 16 个插件逐个 `tsc --noEmit` | `[x]` | — |
| U6 | `npm test` + 16 个插件测试 | `[x]` | 收尾复跑：根 458 pass / 0 fail（1 skipped），16 套 1 243 pass / 0 fail |

U4 的验收判据（两条都要过）：

```sh
node -e "console.log(require('./node_modules/@deepseek-ai/dsh-app-boot/package.json').version)"
#   → 0.2.0-rc.1
node -e "console.log(require('./plugins/plugin-archives/node_modules/@deepseek-ai/dsh-client-connection/package.json').version)"
#   → 0.2.0-rc.1     ← 插件本地也必须是新线，否则就是版本偏斜
```

### 2.2 重装依赖（有坑，按顺序做）

`[实测]` 直接改 spec 保留旧 lockfile 会 **ERESOLVE 失败**：旧 lockfile 把整棵传递闭包钉在
旧线，而新 spec 要求新线，peer 冲突。正确顺序：

```sh
# 1. 清空根与全部插件（项目规则：换内核线必须先删 node_modules）
rm -rf node_modules package-lock.json
for d in plugins/*/; do rm -rf "$d/node_modules" "$d/package-lock.json"; done
# 2. 根：全新解析
npm install --no-audit --no-fund
# 3. 插件：逐个在插件目录内装（--legacy-peer-deps 只在插件目录用，见 plugins/AGENTS.md §2）
for d in plugins/*/; do (cd "$d" && npm install --legacy-peer-deps --no-audit --no-fund); done
```

### 2.3 重建 runtime 与 bundled kernel

内核树必须重建（`@deepseek-ai/dsh-desktop-host` 是私有包、从不发布，由
`scripts/build-runtime.mjs` 从检出构建并打包，见该文件的 `packDesktopHost`）。
步骤见 `docs/agents/build-and-release.md`：

```sh
npm run runtime:build
# 产出 runtime-dist/dsh-runtime-<platform>-<arch>-0.2.0-rc.1.tgz
#     + office-payload-<platform>-<arch>-0.2.0-rc.1.tgz
```

**前置检查（本轮已发现一个真实的坑）** `[实测]`：检出的**构建产物是陈旧的**。
`D:\codes\deepseek-harness` 的 HEAD 是 `0.2.0-rc.1`（2026-09-28 19:48），但：

```
apps/cli/lib/bin.js            → 2026-09-23 11:37
apps/desktop-host/lib/index.js → 2026-09-24 23:39

$ find apps/desktop-host/src apps/cli/src -newer apps/cli/lib/bin.js -name '*.ts' | wc -l
8                    ← 有 8 个 .ts 比产物新
```

即源码已经换到新线，而 `lib/` 还是旧线编译出来的。**直接跑 `runtime:build` 会打进旧代码**，
而且这个错误在产物里看不出来（版本号来自检出，代码来自陈旧的 lib）。所以重建前必须先：

```sh
cd D:\codes\deepseek-harness
pnpm install          # 若 node_modules 不是当前 HEAD 装的
pnpm run build        # 让 lib/ 与 HEAD 对齐（build 脚本 = tsx scripts/build.ts）
```

**依赖是否要重装**的判据 `[实测]`：比对三个时间戳——`node_modules/.modules.yaml`、
`pnpm-lock.yaml`、HEAD 提交时间。本轮实测 `node_modules` 是 09-28 21:02、lockfile 是 20:47、
HEAD 是 19:48，**两者都晚于 HEAD**，所以只需 `pnpm run build`，不必重装。

构建完成的判据：`apps/cli/lib/bin.js` 与 `apps/desktop-host/lib/index.js` 的时间戳
**晚于** HEAD 提交时间。

| 编号 | 条目 | 状态 |
|---|---|---|
| U7a | 检出 `pnpm run build`，产物时间戳晚于 HEAD | `[x]` |
| U7 | `npm run runtime:build` | `[x]` |
| U8 | 确认 runtime 含 `dsh-desktop-host/lib/index.js` 与 `runtime/office-skills/scripts/check_office.py` | `[x]` |

### 2.4 逐项复验（升级后必做，不能只信编译）

```sh
npm run typecheck
npm test
npm run check:graph
npm run verify -- --tgz runtime-dist/dsh-runtime-<platform>-<arch>-0.2.0-rc.1.tgz
npm run check:plugins -- --kernel <新 runtime.tgz> --home <真实 DSH_HOME>
```

### 2.5 收尾

| 编号 | 条目 | 状态 |
|---|---|---|
| U9 | `changesets/<name>.md` 片段（`shell: patch`；插件 peer 范围改了，按需声明 `plugins:`） | `[x]` | 四个片段：`kernel-line-0.2.0-rc.1.md`（本升级）、`schedule-row-inserts-itself.md`（日程行）、`spent-flip-rows-are-dropped.md`（套件残留行）、`market-lifts-the-release-age-policy-per-run.md`（`plugins: plugin-market`） |
| U10 | 文档更新：`AGENTS.md` 的跟随线、`docs/agents/build-and-release.md` 的产物版本 | `[x]` | 核对结论：两处都不写具体线号——`AGENTS.md` 只说"新内核线把每个 `@deepseek-ai/dsh*` 依赖升到同一个 spec"，`build-and-release.md:121` 的 `0.1.7-rc.2` 是历史说明（解释一次重建为何解析到旧版本），保留。本轮真正要更新的文档是本文件的台账与 `docs/profile-patch-regeneration-regression.md` §3.4 |

---

## 3 评估过、决定不做的

| 项 | 为什么不跟 |
|---|---|
| 产品埋点与遥测出口重构 | 我们一个遥测行都没挂（overlay 里搜 `telemetry`/`otel` 为空） |
| 桌面端新增的设备信息能力 | 我们的 preload 是 `account-preload.ts`，刻意只暴露一个冻结标记（根 `AGENTS.md` §4 的安全不变量）。加通道需要安全评审 |
| 客户端版本注入 | 我们已有 `DSH_APP_SHELL_VERSION`（随 kernelEnv 传给子进程），语义等价 |
| macOS 录音权限 entitlement | 我们本来就没有录音功能；将来要做才需要 |
| 上游自身的依赖钉版与构建脚本调整 | 不是我们的依赖、不是我们的脚本 |

---

## 4 回归清单

### 4.1 自动门禁（**裸跑，不走管道**）

```sh
npm run typecheck
npm run build
npm test
npm run check:graph
npm run verify -- --tgz runtime-dist/dsh-runtime-<platform>-<arch>-0.2.0-rc.1.tgz
npm run check:plugins -- --kernel <新 runtime.tgz> --home <真实 DSH_HOME>
```

### 4.2 真机回归

**界面侧的逐项回归留到本次升级收尾后统一做**（用户 2026-09-28 指示）。升级本身要跑的是下面
这几条"能不能起来、机制还在不在"：

| 编号 | 步骤 | 预期 | 为什么这条重要 |
|---|---|---|---|
| M1 | 新 runtime 启动到主界面 | host ready（web transport）；无 `plugin tree failed to load` | 基本可用性 |
| M2 | 改一个设置 → 重启 | 值仍在 | 验证 `suite-layer` 在新线上仍成立 |
| M3 | 定时任务可用 | 工具在；会话头部有日程目录 | 上游把自动化改由可选包提供（§1.5） |
| M4 | 市场禁用/启用一个插件 | 块内若有内核设置行不被连带删除 | 验证 R7 修复在新线上仍成立 |
| M5 | 办公组件（诊断页或 `office_to_pdf`） | 载荷可识别；不报"未声明办公组件" | `argv[4]` 的 office 契约是最脆的跨进程契约 |

界面侧的全量回归（设置页逐行、主题、安全模式等）另立任务，在升级收尾后一起做。

### 4.3 换线专属检查

| 项 | 检查方式 |
|---|---|
| `dsh-desktop-host` 被正确构建进 runtime | `tar -tzf <runtime>.tgz \| grep dsh-desktop-host` 应含 `lib/index.js` |
| office-skills 已随 runtime 打包 | 同上，应含 `runtime/office-skills/scripts/check_office.py` |
| 宿主协议分支未被执行 | 真机日志确认 `web transport`（不是 frames） |
| 客户端存储按线清理 | 换线后 `client-state.ts` 应报 `cleared`（0.1.7 → 0.2.0 是换线） |

---

## 5 风险与未验证项

| 项 | 状态 | 影响 / 下一步 |
|---|---|---|
| 真机运行 | M1（启动到 ready）、M2（内核写的设置存活且仍是生效行）、M3（定时任务：工具调用 + 投递，用户真机实测）**已过**（§6 阶段 3） | 剩余：**界面侧全量回归的自动化部分**已跑（`probe-launch-folder` 22 项 PASS、`probe-settings-nav --lang en-US --sweep` 全绿）；逐项的人工界面确认（点开每个设置分区、主题、安全模式）仍留给收尾后统一做 |
| `runtime:build` | 已跑（重建于 `pnpm run build` 之后的检出），产物经 `verify --tgz` 与真机启动 | 收尾改动（市场插件、overlay、套件残留行）后又重建一次，见 §6 阶段 3 的复跑 |
| 上游 `0.2.0-rc.1` 是 rc 不是正式版 | npm dist-tag 是 `next` | 与我们现在跟随 rc 的策略一致；正式版出来后可再 bump 一次 |
| `HOST_PROTOCOL_VERSION = 3` 与上游的 `4` | 实测不构成阻塞（走 web transport，该分支不执行） | 但 frames 线（0.1.5 及更早的回滚目标）若将来要跑新 host，这条会咬人。本轮不改 |
| 插件 `package.json` 的 peer 范围 | `^0.1.7-alpha.2` **不接受** `0.2.0-rc.1`（semver 实测） | 已一起改（§1.4），`check:graph` 报 `followed line ^0.2.0-rc.1` / `ok — no violations` |
| **第三方 bundle 被新线的 peer 检查跳过** | **已不成立**（2026-09-29 复核）：作者当天发了 `dshmarket@1.66.4` / `1.66.5`，peer 范围加上 `^0.2.0-rc.1`；真实 profile 的锁文件与已装包现为 `1.66.5`，`--dump-config` 里那条 skip 消失 | 升级说明仍要提一句：第三方插件的 peer 范围封顶在旧线时，0.2.0 是**启动即拒**（0.1.7 上只是警告），出路是升级该插件或显式 `dsh plugin allow-version` 豁免 |
| **安全模式下的日程行** | **已修**（2026-09-29）：`stripSuiteRows` 新增 `isSpentFlipRow`，把「id 由当前 overlay 以 insert 声明 + 无 config + 状态与层里那行一致」的残留行摘掉 | 实证：真实 profile 副本上迁移只摘 `ui-schedule` 一个 id（patch 1337 → 1335 行，diff 仅那两行）、留 `.pre-suite-layer-*` 备份、组合树不变；副本切安全模式（空层）后 `--dump-config` 的 stderr 为空 |
| **界面探针的一条形状假设** | **已修**（tooling）：`probe-settings-nav.cjs` 的「面板已渲染」判据原为 `panel.querySelector('section') !== null`，只对用 `<section>` 建页的插件成立（presets 页根是 `<div class="dshPresets-section">`），于是每次运行都两条假 FAIL，掩盖真失败 | 改成与形状无关的「面板里有元素」并打印 `children` 计数。**注意**：这条断言的对错与内核线无关，别把它读成 0.2.0 的回归 |

---

## 6 执行台账

> 边做边填。每条格式：编号 · 主张复核 · 最小性 · 新风险 · 边界 · 证据 · 反例。

### 阶段 0 — 开工前的主张复核

| 主张 | 复核结果 |
|---|---|
| "这是一次版本升级，不是移植改造" | **成立**。§1.1 的编译 + 测试数字是升级前实测的 |
| "插件的 peer 范围会自然满足" | **不成立，已改**。`^0.1.7-alpha.2` 不接受 `0.2.0-rc.1`；且插件有本地 `node_modules`，第一轮验证测的是旧线（§1.4） |
| "宿主协议号 3 vs 4 会阻塞" | **不成立**。那个常量是发布元数据，且我们走 web transport，比较分支不执行（§1.3） |
| "检出的 `lib/` 可以直接用来重建 runtime" | **不成立，已记入 U7a**。HEAD 是 2026-09-28，而 `apps/cli/lib/bin.js` 是 09-23、`apps/desktop-host/lib/index.js` 是 09-24，且有 8 个 `.ts` 比产物新——直接打包会打进旧代码，且**产物里看不出来**（版本号来自检出、代码来自陈旧 lib）。重建前必须先 `pnpm run build`（§2.3） |

### 阶段 1 — 依赖升级（U1–U6）

| 编号 | 状态 | 证据 |
|---|---|---|
| U1 | `[x]` | 根 24 个 `@deepseek-ai/*` 已改为 `^0.2.0-rc.1`（`@deepseek-ai/cordis` 保持 `^4.0.4`） |
| U2 | `[x]` | 16 个插件的 `^0.1.7-alpha.2` → `^0.2.0-rc.1`（peer 与 dev） |
| U3 | `[x]` | 清空根与全部插件的 `node_modules`/lockfile 后重装：根与 16 个插件**全部成功** |
| U4 | `[x]` | 根 `dsh-app-boot` = `0.2.0-rc.1`；插件本地 `dsh-client-connection` = `0.2.0-rc.1`（**两条都过**，排除了 §1.4 的版本偏斜） |
| U5 | `[x]` | 外壳 `tsc --noEmit` 0 error；16 个插件逐个 `tsc --noEmit` 全部 0 error |
| U6 | `[x]` | 根 `npm test` **458 pass / 0 fail**；16 个插件套件 **1,243 pass / 0 fail**（全绿） |
| — | `[x]` | `npm run check:graph`：`plugin graph: 16 plugins, followed line ^0.2.0-rc.1` / `ok — no violations` |
| — | `[x]` | `node scripts/kernel-line.mjs --json` → `{"spec":"^0.2.0-rc.1","channel":"beta","tag":"next"}` |

**U3–U6 的边界覆盖**：换线最怕的是"编译过、运行期名字没了"。本轮除了 17 次 typecheck，
还跑了 `test/plugin-kernel-imports.test.mjs`（专查运行期导入名）与全部套件测试——
两者都过，说明新线的导出面在我们用到的范围内是完整的。

### 阶段 2 — runtime 重建（U7a–U8）

| 编号 | 状态 | 证据 |
|---|---|---|
| U7a | `[x]` | 检出 `pnpm run build` 完成；`apps/cli/lib/bin.js` 与 `apps/desktop-host/lib/index.js` 时间戳 = **2026-09-28 22:51**（晚于 HEAD 19:48）；`find ... -newer` 计数 **0**，产物已对齐 HEAD |
| U7 | `[~]` | `npm run runtime:build` 进行中 |
| U8 | `[ ]` | 待 U7 |

### 阶段 3 — 门禁与真机（§2.4、§4.2）

| 编号 | 状态 | 证据 |
|---|---|---|
| U8 | `[x]` | 产物三处关键内容齐全：`dsh-desktop-host/lib/index.js` ✓、`office-skills/scripts/check_office.py` ✓、`app/node_modules/@deepseek-ai/dsh/package.json` ✓ |
| — | `[x]` | 产物 manifest：`dshVersion: 0.2.0-rc.1` / `suiteVersion: 5158525c` / `channel: beta`；`dsh` 包版本 `0.2.0-rc.1` |
| — | `[x]` | `npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.0-rc.1.tgz` → **`smoke: all checks passed`** |
| — | `[x]` | `npm run check:plugins -- --kernel <新 tgz> --home <真实 DSH_HOME>` → **`通过 — 内核就绪，未命中失败信号`**（10.5s） |
| M1 | `[x]` | 真机启动（隔离 `DSH_HOME` + 新 runtime）：`host ready (web transport)`，host package `0.2.0-rc.1`；套件层正常安装 |

**M1 实测发现一个上游新行的告警（不是我们的缺陷）** `[实测]`：

```
dsh: warning: 2 entries did not activate
desktop-product-telemetry (@deepseek-ai/dsh-host-product-telemetry-otel):
  ValidationError: invalid config: - $.serviceVersion missing required value
product-analytics (@deepseek-ai/dsh-client-product-analytics):
  pending (waiting for service: productTelemetry)
```

排查结论：

- 这两行是 **0.2.0 新增**的（0.1.7-rc.2 的 `dsh-web-app/cordis.patch.yml` 里没有）；
- 它们在 `dsh-web-app` 的 bundle 层里，带 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`；
- 它们需要的 `serviceVersion` / `appVersion` 来自环境变量 `DSH_CLIENT_VERSION`，
  而这个变量是**官方桌面端**注入的，我们没有设（我们有自己的 `DSH_APP_SHELL_VERSION`）；
- 后果是**非致命告警**：两个 id 都不在 `requiredStartupEntryIds`
  （`agent-loop`/`webserver`/`modules`/`connection`/`headless-runner`/`acp`/`sdk-jsonrpc-server`）里，
  所以 `auditStartupEntries` 不抛错，host 正常 ready；
- **我们的 16 个套件插件一个都没报错**（日志里搜 `plugin-*` 为空）。

处置：**本轮不改**（这是上游新增的可选遥测行，对我们无功能影响，且界面能正常起来）。
若将来要消除这条告警，最直接的做法是给子进程注入 `DSH_CLIENT_VERSION`（用我们的 shell 版本），
但那属于产品决策，记入 §5 待办。

### 阶段 3（续）— 收尾当天补的两项与 M2 `[实测]`

**M2 通过，且上一轮那条「设置存活? 否」是探查脚本自己的缺陷。** 上一轮收尾时
`scratch/simulate-settings-write.mjs` 报 `设置存活? **否**` + `根级 id: ["ui-theme","ui-theme"]`，
本轮逐条查清（两条都是脚本的问题，内核与外壳均无缺陷）：

| 缺陷 | 实测证据 |
|---|---|
| 写的包名不存在 | 脚本硬编码 `name: '@deepseek-ai/dsh-ui-theme'`，两条线上该包都叫 `@deepseek-ai/dsh-client-ui-theme`。内核自己的补丁 pass 直接跳过它：`dsh: […cordis.patch.yml] patch: name mismatch for "ui-theme" (expected "@deepseek-ai/dsh-client-ui-theme", got "@deepseek-ai/dsh-ui-theme"), skipping` |
| 读第一行而不是生效行 | 同 id 重复是合法的，生效的是**最后**一行（`cordis-plugin-loader` 的 `Object.fromEntries(config.map(o => [o.id, o]))`）。脚本用 `parsed.find(...)` 取第一行——那行是内核先写的继承默认值 |

重做的探查（`scratch/probe-m2-settings.mjs`）按内核自己的写法写设置
（`parseDocument` → `contents.flow = false` → `document.add({id, name, config})` → `String(document)`，
即 `dsh-config-editor` 的 `edit()` 路径），再跑一次外壳的启动期处理，然后从**组合树**里读回：

```
[1] kernel wrote ui-theme.config = {"preference":"dark"}
[2] installSuiteLayer → already
[3] profile patch: 2 row(s) for ui-theme; last = {"preference":"dark"}
[4] composed tree: 1 row(s) for ui-theme; last = {"preference":"dark"}
设置写后存活? 是   组合后生效? 是
```

**用户 2026-09-28 报的两项，本轮的处置与证据：**

| 项 | 处置 | 证据 |
|---|---|---|
| 启动提示 `patch: entry "ui-schedule" not found`（来自套件层与 profile patch 两处） | `plugins/dsh-app.patch.yml` 的 `ui-schedule` 从「改写上游禁用行」改为随 `schedule` 一起 **insert**（0.2.0 的 web bundle 已不携带该行，改由 `@deepseek-ai/dsh-experimental-schedule-bundle` 提供，本 profile 不列它，override 因此没有目标） | 真机 start（隔离 home + 新 runtime）：**警告归零**，启动照旧 ready；组合树里 `ui-schedule` 回来了（修前 `--dump-config` 只有 `schedule`）。真实 profile 的副本上同样归零（它自己那份非 insert 行现在解析到套件层插入的同一个 id）。0.1.7-rc.2 上对照：组合树多一行同 id，生效的仍是最后那行（`disabled: false`），与修前的改写等价 |
| `dsh-app` 装包需要 `--config.minimumReleaseAge=0` 单次覆盖 | `plugin-market` 改为把该覆盖**放进命令本身**（此前是失败后重试一次）——profile 的锁文件按常态就钉着冷却期内的版本，pnpm 在每条命令前校验锁文件，所以装卸都要先失败一次才成功 | 真实 profile 副本上量到 **2 个**冷却期内条目（`dsh-context@0.59.1`、`dshmarket@1.66.3`，脚本 `scratch/probe-lock-age.mjs`），并复现原失败：`pnpm install --lockfile-only` → `✗ Lockfile failed supply-chain policy check` + `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]`；加上覆盖后同一条命令 `✓ Lockfile passes supply-chain policies`。插件套件 209 pass / 0 fail（新用例锁住新契约：覆盖在第一次运行上、profile 自身策略与锁文件都不被写、失败不再重跑、策略失败与阻塞构建同时出现时仍被点名） |

**这次取舍的边界（独立安全审查的结论，需写进用户可见处）**：把覆盖放进**每次**运行，等于
dsh-app 这条线上的包操作都在无冷却期条件下运行——对市场主路径（用户在面板里选定确切版本、
registry 回验后 `add name@exact`）这与旧实现**产物完全相同**（旧实现最终也是带覆盖的那次运行
说了算，只是先白跑一次被拒的命令）；变的是两类解析：`installSpec` 的**范围**规格（`^x.y.z`）
会取到最新版而不是最新成熟版，以及 `add` 的传递依赖同理。这是用户明确要求的取舍（这条线要能装
当天发布的包），覆盖本身仍是 per-run：不落盘、不改 profile 的 `pnpm-workspace.yaml`、不改
`minimumReleaseAge` 本身，也不碰市场的版本校验（`validatePackageName` / `validateExactVersion` /
`resolveRegistryVersion` 仍在，覆盖只关 pnpm 的策略）。发布时这一段要进升级说明。


**M3–M5 机制核对（升级本身要跑的那几条）** `[实测]`：

| 编号 | 结果 | 证据 |
|---|---|---|
| M3 | 通过（机制侧 + 工具级） | 组合树里 `schedule`（服务）与 `ui-schedule`（客户端行）都在；真机启动零激活失败；端到端探针 `scratch/probe-schedule-ui.mjs` 用 smoke 的启动形状（临时 home + 随包 overlay 作 `--patch` + 套件插件链接进 profile 自己的 `node_modules/@dsh-app`）读**被服务的 index**：修后 overlay 下 `@deepseek-ai/dsh-client-ui-schedule` **在**（40 951 B / HTTP 200）、修前 overlay 下**不在**（40 205 B）——这正是用户报的那半边功能缺失。**工具级已由用户在真应用里实测通过**（2026-09-28 17:04 UTC）：一句「10s 后提醒我喝水」→ 模型回「已设好提醒…触发时间 17:04:46 UTC」、会话里渲染出任务卡片（喝水提醒 / 仅一次 / 打开）、到点后 `自动化任务` 投递块送达提醒正文；左栏「自动化任务」入口与会话页头的自动化入口都在，输入框占位是「发消息或创建任务…」 |
| M4 | 通过（套件级） | 市场「启用不再连带删掉内核设置行、禁用不再静默不生效」的判据在插件套件里（`plugin-market` 209 pass / 0 fail，含 `toggleManagedDisable` 的文件级往返与幂等用例）。本轮只改了 CLI 调用的参数，未碰该逻辑 |
| M5 | 通过 | 产物三处关键物齐全（`app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`、`runtime/office-skills/scripts/check_office.py`、`app/node_modules/@deepseek-ai/dsh/package.json`）；真机 argv 把办公资产根交给宿主（`…\dsh-app-office\primary-runtime`）、宿主 `web transport ready` —— 0.1.6+ 的宿主缺 `check_office.py` 会直接拒绝启动，ready 即该契约成立 |

**0.2.0 上发现的一处既有第三方偏差（不是我们的代码）** `[实测]`：真实 profile 的 bundle
`dshmarket@1.66.3` 被新线的 peer 检查跳过——

```
dsh: skipping profile bundle "dshmarket": Error: Plugin dshmarket@1.66.3 is incompatible with
dsh 0.2.0-rc.1: peerDependencies {"@deepseek-ai/dsh-settings":"^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2"}.
… Exact-version exemption: not active.
```

它的 peer 范围封顶在 0.1.x，而 0.2.0 收紧成启动即拒（0.1.7 线上只是警告）。出路是作者发新版本、
或在 0.2.0 上显式 `dsh plugin allow-version` 豁免。本升级不改它，但它会让「市场」这个第三方入口
在新线上消失，需在升级说明里对用户讲清（`dsh-context`/`dshmarket` 这类第三方插件装不进来时，
先看这条，而不是先怀疑套件）。

### 阶段 4 — 收尾复跑（改动落地后重跑一遍门禁）`[实测]`

```
npm run typecheck                                    → 0 error
npm run build                                        → dist 刷新（含 overlay、插件 lib）
npm test                                             → 459 tests, 458 pass / 0 fail / 1 skipped
16 个插件套件（逐个）                                 → 全部 exit 0，合计 1 243 pass / 0 fail
npm run check:graph                                  → followed line ^0.2.0-rc.1 / ok — no violations
npm run runtime:build                                → dsh-runtime-win32-x64-0.2.0-rc.1.tgz 重建，
                                                        suiteVersion 5158525c → 7ca94399（市场版本 bump 生效）
npm run verify -- --tgz <新产物>                      → smoke: all checks passed（60 项）
npm run check:plugins -- --kernel <新产物> --home …   → 通过 — 内核就绪，未命中失败信号
真机启动（隔离 DSH_HOME + 新 runtime）                 → host ready (web transport)，无 `patch: … not found`，
                                                        无套件条目激活失败
```

`suiteVersion` 从 `5158525c` 变到 `7ca94399` 是这一步的**关键断言**：它由 16 个插件的
`package.json` 版本算出，市场插件没 bump 时新产物不会被任何已安装实例采纳（v0.12.5 就是这样
悄悄发不出去的）。市场插件已 bump 到 `0.3.1`，所以这条断言过。

### 阶段 5 — 三项残余的收口（2026-09-29）`[实测]`

| 项 | 结论 | 证据 |
|---|---|---|
| 界面侧回归（自动化部分） | `probe-launch-folder.mjs --kernel <新 runtime>` **22 项 PASS**（这条是 AGENTS.md 指定的换线后必跑）；`probe-settings-nav.cjs --lang en-US --sweep` 修掉形状假设后**全绿**：13 条导航行全在面板内、可滚动、合并的「维护设置」一行一图标、两个 tab 顺序与 tab order 正确、可见面板恰好一个且 `children=1`（页面真的挂了）、切走的 tab 仍留在 DOM（`hidden=true, children=1`，状态不丢）、**en-US 下 13 个分区零中文残留** | `scratch/probe-settings-nav6.log` 的 `RESULT: PASS`；窗口截图在 `scratch/shots/` |
| 第三方 `dshmarket` 被新线拒 | **已自解**：作者当天发 `1.66.4`/`1.66.5` 并把 `^0.2.0-rc.1` 加进 peer 范围；你的 `npm run dev`（跑的就是本工作树的新市场代码，它把冷静期覆盖放在命令本身）把它从 `1.66.3` 更新到 `1.66.5` | 真实 profile 锁文件 `dshmarket@1.66.3` → `1.66.5`（mtime 09-29 00:20）；已装包 `peerDependencies` 现含 `^0.2.0-rc.1`；`--dump-config` 里那条 `skipping profile bundle "dshmarket"` 消失 |
| 安全模式下的残留行 | **已修**：`stripSuiteRows` 加 `isSpentFlipRow`（三条件：id 由当前 overlay 以 insert 声明、无 `config`、`disabled` 缺失或恰为 `false`），把老外壳写的「启用」残留摘掉；带 config 的行与 `disabled: true` 的用户决定一律保留 | 真实 profile 副本：`removed: ["ui-schedule"]`、patch 1337 → 1335 行且 diff 只有那两行、`.pre-suite-layer-*` 备份保留、组合树不变；副本切安全模式（`overlay: ''`）后 dump 的 stderr **为空**。新增 5 个单测（含「带 config 的行不摘」「`disabled: true` 不摘」「只被 override 的 id 不摘」） |

**界面探针自身修掉一条形状假设**（tooling，不是内核线回归）：它把「面板已渲染」判为
`panel.querySelector('section') !== null`，而 presets 页的根是 `<div class="dshPresets-section">`
（诊断页用上游原语，里面确有 `<section>`），于是每次运行都两条假 FAIL——正是本仓最怕的
「假绿灯/假红灯掩盖真问题」。判据改为与形状无关的「面板里有元素」，并打印 `children` 计数；
修后重跑 `RESULT: PASS`，且两个面板都 `children=1`、切走的那个仍 `hidden=true, children=1`，
说明这一条查的是真事（页面确实挂了、也确实没被卸载）。

这一改**当场踩了本仓写明的坑**：注释写进模板字面量时带了反引号，`probe-settings-nav.cjs`
在**加载期**就 `SyntaxError`；又因为探针跑在 Electron 主进程里，报错形态是桌面上弹一个原生
「A JavaScript error occurred in the main process」对话框（用户先看到的是这个，而非工具报错），
而当时没有任何门禁看过该文件的语法。处置：① 注释改成无反引号（AGENTS.md §5 的规则）；
② 新增静态门 `test/script-syntax.test.mjs`——用 `node --check` 解析 `scripts/` 下全部
37 个 `*.{mjs,cjs,js}`（不执行，模块/脚本判定与 node 本身一致），约 1.3 s；
③ 负向对照：临时放回同一个反引号错误，门禁如期变红并点名文件，删掉后恢复绿。
根套件因此 463 pass / 0 fail。


