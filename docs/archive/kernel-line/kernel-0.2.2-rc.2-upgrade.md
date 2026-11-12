# 内核线 0.2.2-rc.1 → 0.2.2-rc.2：三处真断裂、一次办公载荷收缩、MCP 归内核

> 执行 2026-11-12。上一轮记录在 [`kernel-0.2.2-rc.1-upgrade.md`](kernel-0.2.2-rc.1-upgrade.md)，
> 本轮计划与逐条判定在 [`../../plans/kernel-0.2.2-rc.2-upgrade.md`](../../plans/kernel-0.2.2-rc.2-upgrade.md)，
> 流程判据在 [`../agents/kernel-line-regression.md`](../agents/kernel-line-regression.md)。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或包内容；`[待验证]` = 推断。
>
> 复现材料（gitignore）：`scratch/kernel-0.2.2-rc.2/` —— `ourimports.json`（我们 import 的 98 个符号）、
> `surface.mjs` / `surfaceAll.mjs`（入口导出面）、`declDiff.mjs` / `focus.mjs`（声明差异）、
> `slots.mjs`（SlotMap 抽取）、`peers.mjs` / `peers2.mjs`（peer 差集）、`check-published.mjs`（发布核查）。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh → { alpha: 0.2.2-alpha.3, latest: 0.2.2-rc.1, next: 0.2.2-rc.2 }
rc.1 → rc.2 之间的提交数：1568（rc.1 切在 release 分支，rc.2 合并了 master）
我们声明的 41 个 @deepseek-ai/dsh*：全部在 0.2.2-rc.2；dsh-error / libreoffice-kit@0.2.3 也在
@deepseek-ai/dsh-office-to-pdf 在 rc.2 **没有**版本 → plugin-pdf 的改名必须先于插件安装
```

## 1 三处真断裂 `[实测]`

| # | 类型 | 接触面 | 症状 | 修法 |
|---|---|---|---|---|
| 1 | 破坏（改名） | 宿主服务 id | `dsh-office-to-pdf` → `dsh-office-kit`，服务 `officeToPdf` → `officeKit`；不改则 `ctx.get()` 恒为 undefined，`office_to_pdf` 永远报「没有可用的转换服务」 | `plugin-pdf` 的 import、`ctx.get`、测试夹具与两条包名 |
| 2 | 破坏（参数形状） | 子代理注册面 | `startActivation` 去掉了 `request` 包装（`SubagentActivationSpec` 直接继承 `SubagentStartRequest`） | `plugin-swarm` 两处调用点摊平；**类型门禁抓到，源码比对漏了**（该符号不在我们的具名 import 里） |
| 3 | 破坏（依赖漂移） | 会话投影 | `dsh-session-projection` 依赖 zod 4.6.6 而 `plugin-rewind` 钉 4.4.3，`ZodType` 缺 `validate`/`validateAsync` | `plugin-rewind` 升 4.6.6 |

另有两类配套：`dsh-llm` / `dsh-attachment` 把 `dsh-error` 声明成新 peer（本仓 `--legacy-peer-deps` 不装 peer），6 个 manifest 补上；
`skill-office` 的 `SKILL_NAMES` 从 7 项减到 4 项，构建期与启动期两份名单、两份测试夹具一起收敛。

## 2 办公载荷：从「复制技能 + 物化解释器」到「只回答一个路径」`[实测]`

rc.2 的 `apps/desktop-host` 删掉了 `office.ts` / `office-engine.ts`，改为把自己收到的第四个位置参数写进 `DSH_PRIMARY_RUNTIME`
（`apps/desktop-host/src/index.ts:25`），由 `dsh-tool-workspace-dependencies` 从该目录读 `runtime.json`；技能改由
`dsh-skill-office` 包内的 `assets/` 提供。因此外壳那套「校验 4 个技能目录 + 复制到 `<userData>/dsh-app-office/office-skills`
+ 按 mtime 判断陈旧 + 半拷贝重拷 + 物化 Node 进叶子」全部失去对象：

- `prepareOfficePayload` → `preparePrimaryRuntime(dataDir, primaryRuntime?)`：只回答叶子，有载荷就把它的 `primary-runtime` 链过去，没有就回答而不创建；
- 旧布局（含 `dependencies/node/bin/<node>` 且无 `runtime.json`）在叶子上的真目录会被识别并删除，含 `runtime.json` 的或用户的目录不动。

真机：删掉 `<userData>/dsh-app-office/office-skills` 后启动，`host ready` 1 次、失败 0、`office-skills` 未被重建、旧解释器树被清掉。

**构建侧还剩一处死重量**：`scripts/build-runtime.mjs` 的 `stageOfficeSkills` 仍把 4 个技能目录写进 `runtime/office-skills`，
但已无消费者；拆它会改 meta 层的内容哈希，单独一轮做（计划 Deferred 已登记）。

## 3 办公引擎与垫片 `[实测]`

- kit 版本 0.1.2 → 0.2.3（provider 声明 `@deepseek-ai/libreoffice-kit: 0.2.3`，原生引擎同名同版）。
- **包名换掉后垫片没被打进运行树**：构建日志 `no @deepseek-ai/dsh-office-to-pdf in the tree; no kit shim needed`；
  rc.2 的 provider 用 `import.meta.resolve` + 动态 import 找 kit，kit 已被 trim 掉 → 转换能力静默变成 unavailable。
  `DESKTOP_OFFICE_PROVIDER_PACKAGE` 改指 `@deepseek-ai/dsh-office-kit` 后重新打入；实测新树里
  `import.meta.resolve('@deepseek-ai/libreoffice-kit')` 能解析、动态 import 拿到 `createConverter`。
- payload 构建因 kit 0.2.3 新增 `koffi` 被 `ERR_PNPM_IGNORED_BUILDS` 拒：运行树那份构建脚本白名单抽成
  `buildScriptAllowlistLines()`，两处安装共用一份规则。

## 4 MCP 归内核管理器 `[实测]`

rc.2 的 web-app 新增 `mcp-manager` 行（`@deepseek-ai/dsh-mcp-manager`），一个服务器一个 `dsh-mcp-client` 实例，
按行的 `config.servers` reconcile。我们原来的 `plugin-mcp` 自带 JSON 存储 + 动态 `loader.create` 挂载，形成了第二套舰队。

改成：页面保留、库换成内核的 —— 存储是 `mcp-manager` 行的 `config.servers`（经 `ctx.configEditor.edit` 写入，与内核设置页同一条写路径），
状态读 `ctx.get('mcpManager').list()`，不再有任何动态挂载。旧 `servers.json` 一次性导入（`$ENV:NAME` → `${credential:NAME}`），
导入成功后才把文件改名为 `servers.json.migrated`。

真机（rc.2 内核，跑中的窗口里用 CDP 打自家 API）：

```
GET  /servers → {"ok":true,"enabled":true,"filePath":"row \"mcp-manager\" → config.servers","mountAvailable":true,"servers":[]}
POST /server/create（enabled:false）→ servers: [{id:"probe_srv", enabled:false, state:"disabled"}]
profile patch → 708:  mcp-manager.servers.probe_srv（一个存储，没有第二套）
POST /server/delete → servers: []，patch 中已无该键
```

## 5 hero 层：保留我们的品牌层 `[实测]`

rc.2 的 `ui-brand-official` 在官方构建门控**之前**无条件把 `PixelWhale` 注册进新座位 `conversation.hero.frame`
（`packages/client/ui-brand-official/src/client/index.ts:17`），于是首页同时出现两只鲸鱼：
我们的 `#dshapp-whale-bg`（fixed，752×611，opacity 1，z-index -1）与内核的 `[data-home-whale]`
（absolute，1224×843，opacity 0.18，z-index -1）。

**定案：保留我们的层，overlay 关掉 `ui-brand-official` 一行。** 该行另外两个座位（`sidebar.brand.mark` / `brand.name`）
本来就在官方构建门控后，第三方构建从未注册，所以关掉不损失别的。实测关掉后：我们的 canvas 在且 `is-visible`，
`[data-home-whale]` 计数 0，`slot entry crashed` 0。

（中途曾把「跟官方」读成「删掉自画层」，已回退：那是产品资产，不是换线适配。）

## 6 其余判定

| 项 | 判定 | 依据 |
|---|---|---|
| web 搜索默认 provider 从 `deepseek-official` 换成 `deepseek-search-api`；`web-search-exa` / `web-search-perplexity` 包删除 | 归上游 | 我们 overlay 把 `searchProvider` 指向自家引擎链，自带实现不依赖那两个包 |
| `WebSearchProvider` / `WebFetchProvider` 新增 `title` / `description` | 值得移植（已做） | 不补则内核的 Web search 页只能显示 id |
| Agent Teams 默认开启（base 加 `agent-team` / `tool-agent-team`，web-app 加 `ui-agent-team`） | 归上游（接受默认） | `subagent` 池 16 与 swarm 的 12 之间留 4 个槽位 |
| subagent 命名：`SubagentActivation` 新增必填 `name`，delegation 工具强制 name | 值得移植（已做） | swarm 的 item 结果带上内核名字，报告与 `list_agents` 一致 |
| `tool-subagent-control` 新增 `config: interrupt: false` | 归上游 | 我们没覆盖该行 |
| `dsh-tool-session-query` 是否「不在 CLI 闭包」 | 我们注释里那句是错的 | 两个线的运行树里都有它；不挂它的原因是同名工具重复注册，已改注释 |

## 7 负面证据 `[实测]`

| 检查 | 方法 | 结果 |
|---|---|---|
| 我们 import 的 98 个具名符号 | 按 `exports` 映射定位入口源码，跟随跨包 re-export | 0 丢失 |
| 23 个被 import 包的入口导出面 | 同上 | 0 删除，14 个包只有新增 |
| 客户端座位 | 抽取两侧 `interface SlotMap {}` 块 | 157 → 170，0 退役，我们注册的 12 个全部仍声明 |
| overlay 的 7 个 patch 目标行 | 与 `packages/bundle/{base,web-app}/cordis.patch.yml` 比对 | 全部仍在（`deepseek-account` 行的 name 变了、id 未变） |
| 我们注入 CSS 依赖的类名 | 两侧源码 | `navIcon` / `navList` / `navLabel` / `_centerCol` / `data-phase` 均在 |
| 设置排序 | 两侧 `settings.section` 的 `order` 值集合 | 未变 |
| 内核 CLI `plugin` 命令 | `apps/cli/src/plugin.ts` 逐字比较 | 未变 → plugin-market 的安装调用仍有效 |
| vendor 生态 | `vendor/cordis`、`vendor/schemastery` | 4.1.0 / 3.19.0，不动 |

## 8 门禁结果 `[实测]`

| 门禁 | 结果 |
|---|---|
| 20 个 manifest 的 spec 与安装 | 418 处 `^0.2.2-rc.2`；根 424 包；19 个插件 `--legacy-peer-deps` + build 全成功 |
| 两处版本解析 | 根 `dsh-app-boot`、`plugin-archives` 本地 `dsh-client-connection`、`plugin-client-ui` 本地 primitives 均 `0.2.2-rc.2` |
| 根 `typecheck` / `build` | exit 0 |
| 19 个插件 `plugin-gates` | 19/19（type/import/presence/freshness） |
| `npm test` | 736 用例 / 734 pass / 2 skipped / 0 fail |
| `check:graph` / `check:suites:gate` / `check:slots` / `check:touchpoints:gate` | 全 exit 0 |
| `runtime:build` | `dsh-runtime-win32-x64-0.2.2-rc.2.tgz` + `office-payload-win32-x64-0.2.2-rc.2.tgz`（0.2.3，350.7 MB unpacked） |
| 真机 | rc.2 内核 `host ready`，失败计数 0；MCP 页面 API 走通；英雄层单层 |
| 插件套件 | plugin-mcp 68、plugin-swarm 54、plugin-websearch 231，全 PASS |

## 9 未验证 / 下一轮

- **办公转换的端到端**：kit 0.2.3 的 payload 已构建，但没有走「设置 → 诊断 → 办公组件 → 下载」把它装进应用再跑一次
  `office_to_pdf`；`office-docx` 的 `workspace-dependencies` 分支同样未验（本机 payload 是 `0.1.2-py3.12.14`，与新线要求不同）。
- **MCP 真挂载**：本轮用 `enabled: false` 的条目验了写路径与单一存储；一个真实服务器连上、工具以
  `mcp__<key>__<tool>` 注册的完整链路未跑（需要一次真实 stdio/HTTP 服务器）。
- **构建侧 `stageOfficeSkills`** 仍是死重量（见 §2）。
- 探针：`probe-startup`（启动页）通过；`probe-settings-nav` / `probe-workbench` / `probe-routes` 本轮未复跑。
