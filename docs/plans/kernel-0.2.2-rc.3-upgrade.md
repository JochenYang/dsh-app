# 内核线 0.2.2-rc.2 → 0.2.2-rc.3：一次小版本跟随

- Status: done
- Plan date: 2026-11-13
- 上一轮记录：[`../archive/kernel-line/kernel-0.2.2-rc.2-upgrade.md`](../archive/kernel-line/kernel-0.2.2-rc.2-upgrade.md)
- 本轮执行记录：[`../archive/kernel-line/kernel-0.2.2-rc.3-upgrade.md`](../archive/kernel-line/kernel-0.2.2-rc.3-upgrade.md)
- 流程判据：[`../agents/kernel-line-regression.md`](../agents/kernel-line-regression.md)

> **预检**（§7.1 的字段）：`npm run check:preflight -- --npm 0.2.2-rc.3`，目标形态 = 已发布包
> （baseline = 已安装的 rc.2 线）。结果 **0 blocker / 0 ADAPT / 10 note**：声明 0 处变化，
> `slots` 82 条（比 rc.2 多 1，属于纯新增），`overlay` 198 行未动，技能名单仍 4 项，
> 无新增 peer，`engines` 仍是 `node >=24.9.0`，`payload` 只有两个客户端包变了
> （`dsh-client-ui-sidebar` 8 个文件、`dsh-client-ui-primitives` 5 个文件）。

> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读包内容或源码。

## 1 上游这一版动了什么 `[实测]`

`npm view @deepseek-ai/dsh dist-tags` → `{ alpha: 0.2.2-alpha.3, latest: 0.2.2-rc.1, next: 0.2.2-rc.3 }`。
逐文件比对两个变动的包：

| 包 | 变动 | 是否打到我们 |
|---|---|---|
| `dsh-client-ui-sidebar` | 新增 HOC 座位 `sidebar.session.action`（`SidebarSessionActionOwnerProps { wide }`），`SidebarRoot.tsx` 把「新建会话」按钮包进 `renderSlot`，新增 `newSessionRow` 容器样式 | 否，纯新增。我们的 `plugin-sidebar` 提供 Git 视图页签与 host 路由，不碰这一行 |
| `dsh-client-ui-primitives` | 新增 `IconUploadOutlineRegular` / `IconUploadOutlineMedium` | 否，纯新增 |

**采纳决定**：两个新增面都不采纳。`sidebar.session.action` 目前没有需求（我们要挂的是 Git/工作台/Todo，
都已各有座位）；上传图标没有场景。理由记录在此，避免下一轮重新评估——
按 `kernel-line-regression.md` §2.3 的口径，新增面"值得移植"需要它真的解决一个我们有的问题。

## 2 适配动作

| 动作 | 结果 |
|---|---|
| 422 处 spec（根 25 + 19 个插件 397）`^0.2.2-rc.2` → `^0.2.2-rc.3` | `[实测]` 20 个 manifest |
| 根 `node_modules` + `package-lock.json` 清空后 `npm install` | `[实测]` 57 个内核包、`dsh-tools 0.2.2-rc.3`；`kernel-line --resolve` → `0.2.2-rc.3` |
| 19 个插件 `node_modules` 清空后 `npm install --legacy-peer-deps` | `[实测]` 19/19 ok |
| 预检（已安装线） | `[实测]` 0 blocker / 10 note |

**一处真断裂（构建期）** `[实测]`：`npm run runtime:build` 在 `trimRuntimePayload` 的换手断言上失败——
`the runtime tree still holds libreoffice-kit after the trim`。

- 原因：rc.3 的 pnpm 树把 `libreoffice-kit` 的私有依赖 `fflate` 嵌进它自己的
  `node_modules/`，而排除规则只读**最后一段** `node_modules`，于是 `fflate` 被当成它自己
  （12 个文件）保留下来，留下一个只剩私有依赖的引擎壳。
- 修法：排除规则改为「路径上任何一层 `node_modules/@deepseek-ai/libreoffice-kit*` 之下都随引擎一起走」，
  `pruneRuntimeTree` 的「子项全删就删目录」把空壳一并清掉。
- 这类断裂预检看不见（它不是符号、不是版本号，是打包布局），正是第 3 节门禁要兜的面。

## 3 门禁结果 `[实测]`

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 751 用例 / 749 pass / 2 skipped / 0 fail |
| 19 个插件 `npm test` | 19/19 ok |
| `check:graph` / `check:suites:gate` / `check:slots` | 全绿（`check:graph` 报 `followed line ^0.2.2-rc.3`） |
| `npm run runtime:build` | exit 0；`manifest.json` → `dshVersion 0.2.2-rc.3`、`suiteVersion ededa5ec`；垫片日志 `LibreOffice kit shim: …` |
| `npm run verify -- --tgz <runtime tgz>` | `smoke: all checks passed` |
| `probe-routes.cjs --tgz`（electron） | `RESULT: PASS (32 checks)` |
| offices payload | `0.2.3`、kit 0.2.3、win32-x64，121.0 MB compact / 350.7 MB unpacked |

## 4 发版（已完成）

`v0.19.1` 已发布：release 运行 `43419260830` 全绿（`prepare-release` / `resolve` / 六个 runtime cell /
`mirror runtime` / 四个 app cell），CI `43419254611` 绿；六个 cell manifest 均为
`dshVersion 0.2.2-rc.3` + `suiteVersion ededa5ec`，每个 `.sha512` 与 manifest `integrity` 相等；
镜像 `43424317267` Summary **OK**（`releases/latest` + `archive/0.19.1`、21 个资产、prune 删 0.18.0、
latest cleanup 删 17 个 0.19.0 残留）。逐项证据在
[`../archive/kernel-line/kernel-0.2.2-rc.3-upgrade.md`](../archive/kernel-line/kernel-0.2.2-rc.3-upgrade.md) §3。
