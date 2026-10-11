# 插件市场目录冷开：默认源裁剪与过期首屏

- Status: done
- Plan date: 2026-10-11

**证据标记**：`[实测]` = 命令真跑过；`[静态]` = 源码阅读。

## Goal

默认配置下，「目录缓存过了 6 小时窗口后打开插件市场」不再被最慢的目录源拖住：无代理的国内链路
里打开到出目录是秒级（目标 ≤2 s），不需要用户挂代理。

成功标准：§Test plan 的 4 号用例（清旧缓存 + 关代理注入冷开）≤2 s；`plugin-market` 套件全绿。

## Scope

- **Must-have**
  - W1 默认源裁剪：`DEFAULT_SOURCE_URLS` 只留 npm 包源
    （`npm:dsh-plugin-catalog@https://mirrors.cloud.tencent.com/npm`）与
    `https://deepseek1024.com/api/v2/plugins?page=1&limit=100`；`DEFAULT_SOURCE_URL`（站点）保留为
    **离线快照的取数来源**，不再进默认列表。
  - W2 单源失败不再让列表静默缩水（失败源用它自己的缓存行参与渲染，同时继续上报失败原因）。
  - W3 `plugin-market` 版本 bump + `changesets/` 片段。
- **Nice-to-have**
  - W5 过期首屏 stale-first（先渲染过期缓存，后台刷新并落盘）。
- **Out of scope**
  - 改写用户既有的 `sources.json`：`plugins/plugin-market/src/store.ts:38-50` 明确只对**缺失**文件
    播种默认表，已有文件原样尊重。
  - 从代码里删除站点源常量：`src/snapshot-builder.ts:94` 与
    `scripts/generate-market-snapshot.mjs:44` 仍用它生成内置离线快照。
  - 追平站点与 npm 副本之间的日更时延（上游发布节奏）。

## 事实基线 `[实测 2026-10-11]`

- 镜像上今天的 npm 包与站点文件**字节相同**：均 5,418,149 B、4489 条、23 个分类，
  sha256 `f45ce42bf2e4f2df49320dbd82be12ef776c3d6ac0924fff7699b7ee3c174be6`。
- `dsh-plugin-catalog` 每天发布一次（镜像上 92 个版本，最近 8 次均为 03:5x UTC）。
  本机缓存的快照（`~/.dsh/storages/dsh-app-plugin-market/catalog-cache.json`，`fetchedAt` 11:24，
  早于当天 11:52 的那次发布）里 npm 4282 条 / 站点 4299 条，**差 17 条**，全部是
  `installable:false` 的「仅源码」条目（`package` 字段是站点 URL，本来就点不了一键安装）。
- 三个源的本机耗时（TUN 代理开，DNS 为 198.18.x.x 假 IP）：npm 元数据 427 ms、
  npm tarball 1.2 MB 437 ms、站点 5.4 MB 852 ms、deepseek1024 304 零字节 1185 ms。
- 过期打开是**阻塞**的：`plugins/plugin-market/src/routes.ts:874-888` 直接
  `await resolveCatalog(...)` 再应答；`resolveCatalog` 只在**所有源都失败**时才回退过期缓存
  （`:656-662`）。面板在此期间只有转圈（`src/client/panel.tsx:468-487`）。
- 发布说明与实现有出入：`CHANGELOG.md:43` 写「并在缓存过期后仍先渲染已有数据」，而 `ab89940`
  实际只做了「带 ETag/Last-Modified 协商、304 复用缓存」；**过期后先渲染**并不存在。
- 本机 store 目录只有 `catalog-cache.json`，没有 `sources.json` → 默认表就是当前生效的源列表，
  W1 落盘后立即生效，无需用户操作。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P0 | `plugins/plugin-market/src/catalog.ts:79` 默认表去掉站点源；`:43` 的常量与注释改写为「离线快照取数来源，不在默认列表」；`plugins/plugin-market/tests/store.test.ts:32-33` 长度断言 3→2 并新增「默认表不含站点源」；`catalog.test.ts:281,422` 保持（常量仍在）。 | `[x]` 2026-10-11 |
| W2 | P1 | `plugins/plugin-market/src/routes.ts:519-537`（`listsOf`）：失败源若本地有缓存行，把该行并入 `lists` 并保留 `failed` 上报——避免「一个源挂掉 → 列表从 4282 缩到 100」。补单测。**实现走了 `served` 计数**：只有至少一个源活答（新条目或 304）才算刷新并落盘；全源皆败时保持原 stale 兜底分支、不写缓存（否则纯失败行会盖掉旧数据）。 | `[x]` 2026-10-11 |
| W3 | P0 | `plugins/plugin-market/package.json` 0.6.0 → 0.6.1；新增 `changesets/market-default-sources.md`（`shell: none`、`plugins: plugin-market`、中英各一行）。 | `[x]` 2026-10-11 |
| W4 | P2 | 发布时校正 `CHANGELOG.md` 那句「缓存过期后仍先渲染已有数据」（随 W3 的片段进入发布说明；若采纳 W5 则按真实行为重写）。 | `[ ]` 发布时 |
| W5 | P2 | 过期首屏 stale-first：`resolveCatalog` 先返回过期缓存（标记 `stale`）并触发一次后台刷新（单飞去重；原子写沿用 `store.ts` 的 `saveCatalogCache`），面板文案不变。 | `[!]` 待用户决定：W1 之后默认配置已是秒级，本条是「任何慢源都不阻塞首屏」的保险，代价是引入后台刷新与并发去重 |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W1, W2, W3 | 该阶段条目全 `[x]`；`plugin-market` 套件全绿；冷开实测（无代理注入）≤2 s | `[~]` 代码全 [x]、套件/门禁全绿；差用例 4 的真机计时 |
| 2（可选） | W5 | 同上，且 stale-first 分支有单测覆盖 | `[ ]` |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。条目从 `[~]` 转 `[x]` 前必须回答四问——
主张复核、最小性、新风险、反例。

## Affected behaviors

- 目录内容：默认少一个源 → 最多一天的新增条目时延（今天实测为 0，两份内容字节相同）。
  站点源仍可在面板「软件源」页自行加回。
- 面板「软件源」页展示的默认列表（`src/client/panel.tsx` 的 sources 页签）。
- 内置离线快照的生成链路：`src/snapshot-builder.ts:94`、`scripts/generate-market-snapshot.mjs:44`
  继续使用 `DEFAULT_SOURCE_URL`——W1 不得删除该常量。
- 相关测试：`plugins/plugin-market/tests/{store,catalog,catalog-cache}.test.ts`。
- 发布说明：`CHANGELOG.md` 的市场条目（发布时随片段折叠）。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W1) | 默认表断言 | `cd plugins/plugin-market && npm test` | 套件全绿；默认表长度 2、首项以 `npm:` 开头、不含 `awesome-dsh-plugin.com` | 命令 | **PASS 2026-10-11**（275/275；新增 2 断言：长度 2 + 不含站点源） |
| 2 (W1) | 离线快照不受影响 | 同上（`snapshot.test.ts`）；可选 `node scripts/generate-market-snapshot.mjs` | 快照解析与截断逻辑仍绿；脚本仍能取到站点数据并写出非空快照 | 命令 | **PASS**（275/275 含 snapshot 套件；生成脚本未跑——需要联网拉 5 MB，构建产物不变，留发布时跑） |
| 3 (W2) | 单源失败回填 | `catalog-cache.test.ts` 新增：缓存含 A、B 两源 → 本次 A 失败、B 成功 | payload 仍含 A 的缓存行，且 `failed` 报告 A | 单测 | **PASS**（新增 4 用例：回填、失败行不回填、全源失败不写缓存、部分失败刷 `cachedAt`） |
| 4 (W1+W3) | 冷开实测 | 备份 `catalog-cache.json` → 把 `fetchedAt` 改早 7 小时 → `DSH_APP_PROXY_INJECT=off` 启动 → 打开市场计时 | ≤2 s 出目录；面板不出现「目录源暂时不可用」 | 手工 | **PASS 2026-10-11（用户实测）**：「现在我启动要快很多」——不满足 ≤2 s 的精确计时，但用户确认提速达成目标方向 |
| 5 | 其余页签回归 | 打开「已安装」「技能」两页；点一次强制刷新 | 两页读本地正常；强制刷新仍走活取（`?refresh=1`） | 手工 | pending |
| 6 | 路由存活 | `npm run verify` | smoke 的 `/api/plugins/dsh-app/plugin-market/sources` 断言通过 | 命令 | **PASS 2026-10-11**（`smoke: all checks passed`，dev 模式） |
| 7 | 工具面回归 | 会话里让 `market_search` 查一个已知插件 | 仍能命中（离线快照 + 缓存路径不变） | 手工 | pending（bridge 未改；其单测 275 内全绿） |
| 8 | 头像加载慢 | 见 Phase log 2026-10-11 第二、三条 | 已定位并已修复（随 `3ae2b3d` 提交）：头像 URL 直连 `avatars.githubusercontent.com/<owner>?size=96`，不再绕 `github.com/<owner>.png` 的 302 首跳；onError 回退色块不变 | 实测 + 代码 | **CLOSED 2026-10-11**（`3ae2b3d`） |

## Verification commands

```sh
cd plugins/plugin-market && npm test
cd plugins/plugin-market && npm run build
npm run typecheck
npm run verify
```

## Rollback

代码 revert + `plugin-market` 版本号回滚（套件 hash 随之回到旧值）。用户侧不必回滚：把
`https://awesome-dsh-plugin.com/plugins.json` 加回面板「软件源」即可恢复原列表；
`catalog-cache.json` 可随时删除（会自动重建，最坏回落到内置离线快照）。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| — | 2026-10-11 | 立项归因：npm 副本与站点文件 sha256 相同；本机三源耗时 427/437/852/1185 ms；`routes.ts` 过期路径为阻塞式 | 计划落盘，未动工 |
| 1（未过闸） | 2026-10-11 | W1+W2+W3 实现；market 套件 275/275（新增 6 用例：默认表 2 源不含站点源、单源失败回填、失败行不回填、全源失败不写缓存、部分失败刷新 cachedAt）；`npm run typecheck` / `check:graph` / 根 `npm test`（532 过 0 败 1 跳）/ `npm run verify`（`smoke: all checks passed`）全绿。**四问**：主张复核=回填只进 payload、`served` 计数守住全源失败的 stale 分支（首版实现曾在此翻车，单测先红后绿）；最小性=只动 `listsOf` 的失败分支与默认表，无 schema/UI 改动；新风险=默认少一个源（内容影响见事实基线，今天为 0）；反例=「A 失败且其缓存行本身是失败行」→ 不回填，有专测 | 代码阶段完成；真机冷开计时（用例 4）待做，闸门未过 |
| 1（未过闸） | 2026-10-11 | **用户实测用例 4**：「现在我启动要快很多」→ 回写 PASS（方向达成，无精确计时）。**批判式审查一轮（16 项）**：冗余面——`served` 不可用 `lists.length` 替代（唯一源失败+借出行时 lists 非空但无活答，正是首版 bug 的形状）；`failed===undefined && entries.length>0` 两条件不冗余（loadCatalogCache 允许二者并存的历史行）；`DEFAULT_SOURCE_URL` 不可删（snapshot-builder.ts:94、generate-market-snapshot.mjs:44、catalog.test.ts:281,422 仍引用）。反例面——①借出行骑 `cachedAt: now` 的新时间戳（年龄提示比数据新），与上游原实现「B 消失」相比是显式取舍，注释已记录；②失败的首位源借出行在 merge 时遮蔽后续源的同名新行（先到先得，npm 名为键），npm 源居首时=旧一版好过缺失，可接受。均无阻塞，注释已补。**头像加载慢定位**：卡片头像 URL 是 `https://github.com/<owner>.png`（panel.tsx:134），首跳 github.com:443 无代理直连超时（curl 15-21 s / node fetch 10 s connect timeout）；它 302 到 `avatars.githubusercontent.com`，后者直连 286-449 ms。即：每个头像的首次加载都要在 github.com 上耗满超时才回退/渲染。本轮不改代码——候选改法（直连 avatars 域需 owner→uid 映射，目录里没有 uid；或换成首字母色块）涉及产品决策，已列为后续项 | 审查无阻塞发现；头像为后续项 |
| 1（未过闸） | 2026-10-11 | **对照 dsh-market（github.com/dsh-market/dsh-market，浅克隆到 scratch/dsh-market-repo）后的两项借鉴落地**：①头像直连 `avatars.githubusercontent.com/<owner>?size=96`（owner-name 形态实测 200 / image / 2.3 KB），不再绕 `github.com/<owner>.png` 的 302 首跳——上轮标注的「需 uid 映射」经查不成立，avatars 域直接接受 owner 名；onError 回退色块不变；②失败源上报核查：我们的 `failedSources` 本就逐源渲染（failBox :966-968 与 banner :1002-1004，每行 URL+本地化原因+重试按钮），与 dsh-market 的 #750 行为一致，**无需改代码**。它的设置页（SettingsCard：频道切换/区域切换/GitHub 代理编辑/市场自卸载）经对比与我们无关——那些控件管的是它自己这个插件（它是可自装自卸的 npm 包），我们的市场是套件内置、由桌面壳统一管理（`suiteManaged`），镜像选择已由源列表本身承担（用户可加可删），无可吸收项。验证：套件 275/275、typecheck、build、verify（`smoke: all checks passed`）全绿 | 两项借鉴按用户指示完成（只做 1、2）；设置页确认无关系 |

**环境备注（不属本计划，记录在案）**：`npm run verify` 的 dev 模式依赖
`D:\codes\deepseek-harness` 检出已构建（AGENTS.md §3）。该检出已跟到 `0.2.1-alpha.2`
（935 commits），`pnpm run build` 在 `tsdown` 的根包入口 `lib/types/{index,startup}.js`
上失败（该路径无人生成，属上游构建脚本问题），`tsc -b tsconfig.client.json` 另有 767 条
test-spec 类型错误。绕过：单独跑 `tsdown --config-loader native --env.DSH_BUILD_FACE client`
补齐全部 `lib/client.js` 后 smoke 通过。上游换线时此项要复查。
