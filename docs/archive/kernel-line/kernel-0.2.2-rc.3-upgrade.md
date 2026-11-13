# 内核线 0.2.2-rc.2 → 0.2.2-rc.3：跟随、一处打包修正、发版

> 执行 2026-11-13。上一轮记录 [`kernel-0.2.2-rc.2-upgrade.md`](kernel-0.2.2-rc.2-upgrade.md)，
> 本轮计划 [`../../plans/kernel-0.2.2-rc.3-upgrade.md`](../../plans/kernel-0.2.2-rc.3-upgrade.md)，
> 流程判据 [`../../agents/kernel-line-regression.md`](../../agents/kernel-line-regression.md)。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或包内容。

> **预检**（§7.1 的字段）：`npm run check:preflight -- --npm 0.2.2-rc.3`，目标形态 = 已发布包，
> baseline = 已安装的 rc.2 线。**0 blocker / 0 ADAPT / 10 note**。这是预检脚本上线后第一次真实
> 使用，它当场暴露了自己的两处噪声，都已修掉（见 §4）。

## 1 上游动了什么 `[实测]`

`npm view @deepseek-ai/dsh dist-tags` → `{ alpha: 0.2.2-alpha.3, latest: 0.2.2-rc.1, next: 0.2.2-rc.3 }`。
载荷逐文件比对：32 个我们消费的包里只有两个变了。

| 包 | 变动 | 是否打到我们 |
|---|---|---|
| `dsh-client-ui-sidebar` | 新增 HOC 座位 `sidebar.session.action`（`SidebarSessionActionOwnerProps { wide }`），`SidebarRoot.tsx` 把「新建会话」按钮包进 `renderSlot` 并加 `newSessionRow` 容器 | 否，纯新增；我们的 `plugin-sidebar` 提供 Git 视图与 host 路由，不碰这一行 |
| `dsh-client-ui-primitives` | 新增 `IconUploadOutlineRegular` / `IconUploadOutlineMedium` | 否，纯新增 |

声明级 diff 为 0 处；`slots` 82 条（+1，即上面那个座位）；overlay 198 行未动；技能名单仍 4 项；
无新增 peer；`engines` 仍 `node >=24.9.0`。**采纳决定：两个新面都不采纳**——`sidebar.session.action`
目前没有需求（Git / 工作台 / Todo 各有座位），上传图标没有场景。

## 2 适配动作

| 动作 | 结果 |
|---|---|
| 422 处 spec（根 25 + 19 插件 397）→ `^0.2.2-rc.3` | `[实测]` 20 个 manifest |
| 根 `node_modules` + `package-lock.json` 清空后 `npm install` | `[实测]` `kernel-line --resolve` → `0.2.2-rc.3` |
| 19 个插件清空后 `npm install --legacy-peer-deps` | `[实测]` 19/19 ok |

**一处真断裂（构建期）** `[实测]`：`npm run runtime:build` 在 `trimRuntimePayload` 的自检上失败——
`the runtime tree still holds libreoffice-kit after the trim`。

- 原因：rc.3 的 pnpm 树把 `libreoffice-kit` 的私有依赖 `fflate` 嵌在它自己的 `node_modules` 下；
  排除规则只读**最后一段** `node_modules`，于是 `fflate` 被当成它自己留下（12 个文件），
  引擎壳还在、自检就报。
- 修法：路径上任何一层 `node_modules/@deepseek-ai/libreoffice-kit*` 之下都随引擎移出运行时
  （`runtimeFileExclusion` 新增祖先判断），`pruneRuntimeTree` 的「子项全删就删目录」把空壳一并清掉。
- 预检看不见这一类：它不是符号、不是版本号，是打包布局——正是门禁要兜的面。

## 3 门禁与发版 `[实测]`

| 项 | 结果 |
|---|---|
| `typecheck` / `check:graph` / `check:suites:gate` / `check:slots` / `check:touchpoints:gate` | 全绿（`check:graph` 报 `followed line ^0.2.2-rc.3`） |
| `npm test` | 752 用例 / 750 pass / 2 skipped / 0 fail |
| 19 个插件 `npm test` | 19/19 ok |
| `runtime:build`（本机 win32-x64） | exit 0；`manifest.json` → `dshVersion 0.2.2-rc.3`、`suiteVersion ededa5ec` |
| `verify --tgz` | `smoke: all checks passed` |
| `probe-routes.cjs --tgz` | `RESULT: PASS (32 checks)` |
| shell 发布 | tag `v0.19.1`；release 运行 `43419260830`：`prepare-release` / `resolve` / 六个 runtime cell / `mirror runtime` / 四个 app cell 全绿；CI `43419254611` 绿 |
| 六个 cell manifest | 全部 `dshVersion 0.2.2-rc.3` + `suiteVersion ededa5ec`（无混版）；每个 `.sha512` 与 manifest `integrity` 逐一相等 |
| 产物内容 | `tar -xzOf` 读出 `plugin-mcp 0.3.3`、`swarm 0.9.5`、`pdf 0.3.0`、`rewind 0.2.1`、`websearch 0.3.2`、`client-ui 0.6.1`（与 v0.19.0 相同——本轮没有插件行为变更，adoption key 靠 `dshVersion` 变化） |
| 引擎垫片 | 运行时里只有垫片（`libreoffice-kit/index.js` + `lib/cli.js`），没有真引擎；载荷 `office-payload-<cell>-0.2.2-rc.3.tgz` 六 cell 齐备 |
| 发布页 | `gh release edit v0.19.1 --draft=false --notes-file release-notes.md` → 正文 1270 字符，`publishedAt 2026-11-13T12:20:24Z` |
| ModelScope 镜像 | `43424317267` Summary **OK**：`releases/latest` + `releases/archive/0.19.1`、21 个资产；prune 保留 10 个 stable、删 0.18.0；latest cleanup 删 17 个 0.19.0 残留 |

## 4 预检脚本的两处自暴露（已修）

第一次在真实发布日跑，报告 11 个 blocker，全是同一个假阳性：

1. **`deps` 把「线包钉在线版本」当成传递依赖错位**。`dsh-brand 0.2.2-rc.3，本树 rc.2` 是升线前的
   正常状态，归 `line` 检查与 bump 本身管。修法：`deps` 跳过 `@deepseek-ai/*`，并补一条用例
   （一个线包 + 一个第三方包，只有后者是 finding）。
2. **`line` 只看到每个包的第一份拷贝**（前一天 CI 化时修的）：一个脏拷贝塞进非首个插件会被静默
   忽略，而它恰恰会赢下解析。现在按包收集所有拷贝。

修完之后同一份报告是 `0 blocker / 0 ADAPT / 10 note`，只指出两个包变了载荷——与人工比对一致。

## 5 本轮遗留

- `stageOfficeSkills` 的死重量仍未拆（`build-runtime.mjs` 仍往 `runtime/office-skills` 写 4 个技能
  目录，内核已不读），与上一轮登记的 Deferred 项相同：会改 meta 层内容哈希，需整轮复验。
- `dev` 启动器本轮补了「自动解包 `runtime-dist/` 里本线产物」的能力，解决了「仓库已升线、安装版
  仍是旧线」时 `npm run dev` 直接拒绝启动的摩擦。
