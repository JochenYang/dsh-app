# 插件市场支持 Git 安装（github: 目标）

- Status: active
- Plan date: 2026-10-11

**证据标记**：`[实测]` = 命令真跑过；`[静态]` = 源码阅读。

## Goal

目录里 `npm: null` 的 git 插件（实测 1774 条可按本模式安装；另有 166 条 `#path:` monorepo
子包目标不在范围内）可以在面板一键安装：目标校验为 `github:owner/repo` 后原样交给内核 CLI
`plugin add github:…`，装进 `DSH_APP_PROFILE` 指向的 profile（桌面端即 `dsh-app`）；具体提交由
pnpm 解析并记录进该 profile 的 lockfile。

成功标准：§Test plan 1–7 全 PASS；npm 安装路径行为零变化。

## 调研结论（为什么可行、护栏已有多少）

- **内核 CLI 原生支持 git 目标**：本机 `dsh-app` profile 里
  `"@deepseek-ai/dsh-toolkit": "github:omdsh-dev/dsh-toolkit#c3319d9…"` 就是活例 `[实测]`。
- **上游目录自带授权凭据**：`npm: null` 条目带 `install` 命令字符串，目标 token 就是
  `github:owner/repo`；我们的 `npmTargetOf()`（`catalog.ts:462`）已从该命令提取 token，只是
  丢弃非 npm 目标。
- **同类实现的成熟先例**：三级目标解析（npm 名 → release tarball → `github:owner/repo`）是社区
  同类市场验证过的做法；release tarball 快速路径在部分 pnpm 版本上有 integrity 缺失的坑，首版避开。
  **其「安装前钉 commit」的做法首版不采纳**——它依赖 `api.github.com` 的匿名配额，见下条实测。
- **我们的既有护栏（大部分可复用）**：
  - `dependencySourceOf()`（`routes.ts:163`）已能分类 `git` 源——已装视图的「Git 安装」徽章、
    禁止 npm 更新覆盖（`:734`）、同源检查（`:784`）都已工作；
  - `repoKey` 同源护栏（`identity.ts`）：已装 git 版与目录条目同名不同源时会要求确认；
  - 安装串行队列、build-script 白名单流程（`installer.ts`）与目标类型无关，直接复用。
- **需要新增的防线**（registry-only 时代不存在的问题）：
  1. 目标校验器：`github:owner/repo` 语法白名单（`PACKAGE_NAME_PATTERN` 拒收它，必须新增
     `GIT_TARGET_PATTERN`），repo 段两段式、不含 `#` 注入、不接受任意 host（首版只放
     `github:owner/repo`，与上游目录的 `install` 命令形态一致；`git+https://`、任意 git host
     不进首版）。
  2. ~~commit 钉住~~ → **改为不钉（2026-10-11 决定）**：安装前解析 HEAD 需要
     `api.github.com/repos/<repo>/commits/HEAD`，实测（L1）该端点返回 403 且
     `x-ratelimit-remaining: 0`（匿名限流 60 次/小时/IP，走应用代理时出口 IP 与他人共享），
     而 pnpm 真正要拉的 `codeload.github.com` 同一时刻 200 / 540 ms——**钉 commit 成了唯一会失败
     的一环**。替代通道（解析 `info/refs` 的 pkt-line 广告，即 `git ls-remote` 走的 HTTPS）等于
     手写协议解析，违反本仓库「禁止手工编写 parser」的规则。不钉不丢东西：`github:owner/repo`
     正是目录原生 install 命令的形态，pnpm 自己解析 HEAD 并把提交写进 profile 的
     `pnpm-lock.yaml`，此后每次安装都由 lockfile 复现同一提交。
  3. 供应链口径：git 目标没有 registry 的版本/完整性语义，安装确认弹窗必须说明「来自 GitHub
     仓库源码，版本为安装时的 commit」；卡片徽章从「仅源码」改为可安装态。

## Scope

- **Must-have**
  - W1 目标解析：`catalog.ts` 新增 git 目标提取（`install` 命令尾 token 匹配
    `github:owner/repo` 白名单），`installable` 对 git 目标也为 true，条目携带
    `gitTarget` 字段（`package` 字段保持语义不变——npm 名或 surrogate key——避免
    merge/去重/identity 逻辑连锁改动）。
  - W2 安装执行：`installer.ts` 新增 git 安装路径——校验 `GIT_TARGET_PATTERN` → 原样交给
    `plugin add github:o/r`（不钉 commit，理由见上）。与 npm 路径共用串行队列与
    build-script 流程。
  - W3 UI：卡片「仅源码」→「GitHub 源码」可安装态 + 安装确认弹窗写明来源是仓库源码、版本跟随
    默认分支并由 lockfile 记录；已安装视图沿用现有「Git 安装」徽章（`dependencySourceOf` 已覆盖）。
  - W4 版本 bump + changeset。
- **Out of scope**：任意 git host / `git+https://` 目标（首版只放 `github:`，与目录数据形态
  一致）；release tarball 快速路径（同类实现实测过的 pnpm integrity 坑，先避开）；git 安装的
  更新检查（装完由现有「Git 安装」逻辑禁止 npm 更新即可）；模型面 bridge 的 git 安装
  （`bridge-install.ts` 首版保持 npm-only）。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `catalog.ts`：`gitTargetOf(installCommand)` 提取器 + `aggregatedEntriesOf`/`storeEntriesOf` 接线；`CatalogEntry` 增可选 `gitTarget`；`installable = npm 合法 \|\| gitTarget 合法`。测试：提取器正反例（`#path:`、非 github host、命令变形）。 | `[x]` 2026-10-11 |
| W2 | P0 | `installer.ts`：`installGit(target)`（白名单校验 → 原样 `add github:o/r`）；`routes.ts` 的 `/install` 按 `body.gitTarget` 分派；npm 路径不动。测试：校验器正反例、mock CLI 断言 argv 直通。 | `[x]` 2026-10-11 |
| W3 | P1 | 客户端：卡片安装按钮对 `gitTarget` 条目可用；确认弹窗文案（双语词典）说明来源；已安装索引改按依赖 spec 取 repo key（实测目标插件未声明 repository/homepage）；构建脚本重试按钮对 git 行隐藏。 | `[x]` 2026-10-11 |
| W4 | P0 | `plugin-market` 0.6.1 → 0.6.2 + `changesets/market-git-install.md`。 | `[x]` 2026-10-11 |
| W5 | P1 | 真机安装一个 git 源插件验证：落 `dsh-app` profile、manifest 记 `github:owner/repo`、面板显示「Git 安装」、无 npm 更新覆盖提示。 | `[ ]` 待真机 |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1, W2, W3, W4 | 条目全 `[x]`；market 套件全绿；typecheck/verify 绿 | `[ ]` |
| 2 | W5 | 真机安装成功且视图正确 | `[ ]` |

## Affected behaviors

- 目录内容：约 1962 条 source-only 行变为可安装（`installable: true`）。
- 安装链：新增 git 分支；npm 路径零改动（`install()` 签名不变，`/install` 按 body 字段分派）。
- 已安装视图：新出现一批「Git 安装」行——现有逻辑已禁止对它们做 npm 更新（`routes.ts:734`）。
- 同源护栏：git 安装行的 `repoKey` 来自 manifest 的 `repository`/`homepage`，同名异源确认弹窗
  依旧生效（`routes.ts:784`）。
- 供应链面：git 目标无 registry 完整性语义——确认弹窗与「Git 安装」徽章是唯一披露；不加
  任意 host 白名单。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | git 目标提取 | `gitTargetOf('dsh plugin --profile web add github:o/r')` | `'github:o/r'`；`#path:` 片段、非 github host、命令变形 → undefined | 单测 | pending |
| 2 (W1) | 目录条目形态 | mock 源含 npm 行 + git 行 | git 行 `installable: true` 且带 `gitTarget`；npm 行不变；merge 去重不串键 | 单测 | pending |
| 3 (W2) | 目标校验器 | `github:o/r` / `github:o/r#<sha>` / `git+https://…` / `github:o` / 注入形 | 前两者过；其余拒绝且报因 | 单测 | pending |
| 4 (W2) | CLI argv | mock runCli 捕获 argv | `['add', 'github:o/r']`——目标原样直通、无多余 flag | 单测 | **PASS**（`hands the CLI the catalog target verbatim`） |
| 5 (W2) | HEAD 解析失败 | mock API 404/超时 | 可行动报错（含 repo 名），不产生半安装 | 单测 | pending |
| 6 (W3) | 面板文案 | git 条目卡片 | 「GitHub 源码」可安装 + 确认弹窗说明来源 | 单测/手工 | pending（代码就位，真机待看） |
| 7 | 回归 | npm 安装一个已知插件 | npm 路径行为与 0.6.1 完全一致 | 命令 + 手工 | pending |
| 8 (W5) | 真机 | 装一个 git 源插件 | 见 W5 | 手工 | pending |

## Verification commands

```sh
cd plugins/plugin-market && npm test
cd plugins/plugin-market && npm run build
npm run typecheck
npm run verify
```

## Rollback

revert + 版本号回滚；已装 git 插件留在 profile（内核 CLI 原生支持，卸载走现有 uninstall）。
目录缓存可删（自动重建）。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| — | 2026-10-11 | 调研：内核 CLI 原生支持 git 目标（本机 dsh-app profile 活例）；同类市场的三级目标解析先例；我们既有 `dependencySourceOf`/`repoKey` 护栏可复用 | 计划落盘，待审核 |
| 1 | 2026-10-11 | W1–W4 实现；market 套件 292/292、tsc、build、`verify`（`smoke: all checks passed`）全绿。**独立审查**（`/review`）查出 1×P1 + 3×P2：① `api.github.com` 匿名配额实测剩余 0 → 钉 commit 全失败（已按选项 B 改为不钉，删 60 行）；② 构建脚本重试按钮对 git 行必然 400（已隐藏并给手工说明）；③ bridge 对 git 行报 `installable: true` 而工具装不了（已改 false）；④ 已安装索引取错源——实测目标插件未声明 `repository`/`homepage`，装完卡片仍显示安装按钮（已改按依赖 spec 取 key） | 修复完成，待真机 W5 |
