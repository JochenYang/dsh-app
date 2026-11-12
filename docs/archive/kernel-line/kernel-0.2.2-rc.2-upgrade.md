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

**本轮状态**：换线、办公载荷、MCP 归内核、hero 层、两条真机链路与两轮审查修复全部完成；
只剩「最后一轮 P2 改动未再走独立审查」与发布面（tag / runtime / payload 产物）两件事。

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

第一轮独立审查提出五条 P1，全部修在这个迁移里（§10 有逐条清单）：写路径改成在 `editor.edit` 的回调里按**文档当时的**
`servers` 计算（原来用 await 之前的快照覆盖整张表，另一个写者新加的服务器会被抹掉）；条目按「在原有裸对象上合并」写入
（原来按字段白名单重建，`reconnect` 这类本版本不认识的开关会在一次开关切换里丢掉）；插件开关如实降级为「本页只读」并改掉
会同时显示「整体停用」和「已挂载」的文案；旧文件的全局 `enabled: false` 映射成逐条 `enabled: false`；校验不过的条目
不再从页面消失，而是带 `invalid` 标记与 `error` 状态显示（管理器可能已经把它挂上、工具是活的）。

真机（rc.2 内核，跑中的窗口里用 CDP 打自家 API）：

```
GET  /servers → {"ok":true,"enabled":true,"filePath":"row \"mcp-manager\" → config.servers","mountAvailable":true,"servers":[]}
POST /server/create（enabled:false）→ servers: [{id:"probe_srv", enabled:false, state:"disabled"}]
profile patch → 708:  mcp-manager.servers.probe_srv（一个存储，没有第二套）
POST /server/delete → servers: []，patch 中已无该键
```

## 5 hero 层：保留我们的品牌层 `[实测]`

rc.2 的 `ui-brand-official` 在官方构建门控**之前**无条件把 `PixelWhale` 注册进新座位 `conversation.hero.frame`
（`packages/client/ui-brand-official/src/client/index.ts:17`），于是在我们这种第三方构建里，首页也出现了一张 `[data-home-whale]` canvas。
**但它是空的**：渲染器自称 "initially transparent"，实测首页空闲时 alpha>8 的像素 0 个，点击空白处才播一段自结束动画
（+1.6s 76180 个像素，+2.5s 衰减回 2）；我们的 `#dshapp-whale-bg` 空闲就有 7529 个。
（早先版本把"两个 canvas 元素都在"写成"两只鲸鱼同时可见"，是只看元素存在得出的错误结论，已作废。）

**定案：两层共存，不否决上游。** 静止状态没有冲突（上游那张画布是透明的），点击时上游播它自己的动画；
`ui-brand-official` 保持默认开启，它的另外两个座位（`sidebar.brand.mark` / `brand.name`）本来就在官方构建门控后，
第三方构建从未注册。若日后觉得点击动画与我们的层打架，overlay 一行 `- id: ui-brand-official / disabled: true` 即可。
复现：`node scratch/whale-click-probe.mjs`（对 `--remote-debugging-port=9222` 的 dev 窗口）。

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

- **办公转换已全程验通** `[实测]`：真机一轮 agent turn 调用 `office_to_pdf`，返回
  `{"status":"exported","outputPath":"scratch/office-probe/out-tool.pdf","sizeBytes":18303,"missingFonts":[]}`
  且文件落盘。**这一步推翻了此前的一个错误结论**：早先我拿 payload 里的真 kit 直接调，看到
  `backend: native` 就判定引擎链通过；经工具走的是垫片，而 rc.2 的 kit 从**消费方解析到的入口**锚定引擎
  （`locate.ts` 的 `createEnginePackageResolver(kitEntry)`）—— 垫片在运行树里、引擎在 payload 里，于是注定
  `unavailable`。修法见 §11 第 2 条；修后经垫片同样转出 18303 字节。
- **`office-docx` 的内置 Python 已验** `[实测]`：带 Python 集的 payload（`0.2.3-py3.12.14`，624.9 MB unpacked）
  装好后，真机 agent turn 调用 `load_workspace_dependencies` 得到
  `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe`，用它
  `import docx, pptx, openpyxl` 退出码 0、`libs ok 1.2.0`；`<userData>/dsh-app-office/primary-runtime`
  是指向 payload 内 `primary-runtime` 的链接，即 `preparePrimaryRuntime` 的新行为。
- **`probe-settings-nav` 在本机跑不了** `[实测]`：它靠 `pnpm dsh web` 在一个**已构建的 harness 检出**里起内核
  （`scripts/probe-settings-nav.cjs:423-435`），本机检出没装依赖也没构建，`DSH_APP_DEV_RUNTIME` 的兜底同样走
  `pnpm dsh`，所以内核从未打印 URL。这是环境前提，不是本轮的回归；`probe-routes`（32 checks）与
  `verify --tgz`（smoke 全过）都已复跑。
- **MCP 挂载已验** `[实测]`：起了一个真 stdio MCP 服务器（`scratch/mcp-probe/server.mjs`），经页面 API 建条目后
  `GET /servers` 返回 `state: "mounted"`、`toolCount: 1`（修复后复跑仍成立），删除后条目与 patch 里的键都消失。
  工具的确切名字（`mcp__probe__ping`）仍未直接观测到，只验到数量与挂载状态。
- **swarm 真机批次已验** `[实测]`：在运行中的窗口里发一轮真实 agent turn（`scratch/composer-turn.mjs`），模型调用了
  `swarm`，两个子代理 `agent-1` / `agent-2` 跑完，transcript 里出现 `[0] one … name: agent-1`。这条同时证明
  item 的 `name` 字段**通过了内核的 output-schema 校验** —— 第一轮审查指出的「字段未声明 → 整个工具返回被拒」正是靠它验的。

## 10 第一轮审查与修复 `[实测]`

| # | 发现（P1） | 修法 | 验证 |
|---|---|---|---|
| 1 | `plugin-swarm` 的 item 加了 `name`，但工具 output schema 是 `additionalProperties: false` 且未声明它 → 内核以 `ToolOutputError` 拒掉整个返回 | `SWARM_ITEM_SCHEMA` 抽成导出常量并声明 `name`；新增一条用例把真实批次 outcome 交给 `validateJsonSchemaValue` | 变异测试：删掉 `name` 声明后该用例红在 `"value.name" is not a declared property`；真机批次通过 |
| 2 | `childName` 只声明未赋值，continuable 分支（默认 provider）永远丢名字 | 在 `startActivation` 之后 `childName = started.name`；continuable 的 mock 补上 `name` | 真机 `name: agent-1` / `agent-2` |
| 3 | `scripts/probe-routes.cjs` 还留着第三份 7 项技能名单，会让「升线后必跑」的探针拒绝每个产物 | 先改成从 `build-runtime.mjs` 解析，后按第二轮审查**直接删掉技能目录断言**（技能来自内核包自带 `assets/`，产物的该目录已无消费者） | 现在 `probe-routes --tgz` 不再检查该目录；`RESULT: PASS (32 checks)` |
| 4 | MCP 写路径用 await 前的快照覆盖整张 `servers`，另一个写者新加的服务器被静默抹掉 | 写改成在 `editor.edit` 回调里按 live `current`/`inherited` 计算；行匹配改结构化；读不到配置就拒绝写 | `store.test.ts` 新增「第二个写者插入的条目仍在」 |
| 5 | 每次保存都按字段白名单重建条目，本版本不认识的开关（`reconnect`）在开关切换时丢失 | `toRawServer(entry, previous)` 在原有裸对象上合并，只有换 transport 才删另一套字段 | `store.test.ts` 新增两条（保留未知字段 / 换 transport 清理） |
| 6 | 插件开关不再能阻止挂载，页面却同时显示「整体停用」与「已挂载」 | 文案与文档改成「本页只读，服务器仍由内核挂载」；状态不再受该开关影响 | 文案与 `wire.ts` 契约一致 |
| 7 | 迁移丢掉旧文件的全局 `enabled: false`，用户关掉的舰队会在升级后被挂起来 | `readLegacyServers` 返回 `disabledGlobally`，导入时逐条写 `enabled: false` | `tests/legacy.test.ts` 新增用例（含日志一行说明） |
| 8 | 管理器能接受、我们校验不了的条目被页面静默隐藏，工具却仍在跑 | `load()` 改为宽松投影：带 `invalid` 标记 + `error` 状态显示，可删除、可改回合法形状 | `store.test.ts` / `status.test.ts` 各一条 |

另修两条安全向 P2：掩码豁免正则两个分支都锚定（原来 `\$\{credential:` 未锚定，任何**包含**它的字面密钥会被明文返回）；
`create` / `import` 也走 `unmaskSecretValues(body, undefined)`，掩码哨兵不再能被存成真实密钥。
`plugin-mcp` 的 `tests/` 补上了 `legacy.test.ts`（此前这次不可逆导入零测试）。
- **构建侧 `stageOfficeSkills`** 仍是死重量（见 §2）。
- 探针：`probe-startup`（启动页）通过；`probe-settings-nav` / `probe-workbench` / `probe-routes` 本轮未复跑。

## 11 真机验证又抓到的两处 `[实测]`

| # | 症状 | 修法 |
|---|---|---|
| 1 | `verify --tgz` 红在「mcp: imported server mounted」：导入后立刻读一次状态，拿到 `starting` | 挂载现在是内核管理器的异步 reconcile，smoke 改成轮询（与 create 路径一致，20 s 预算） |
| 2 | 经工具调用 `office_to_pdf` 恒报 `unavailable`，而直接用 payload 里的 kit 又能转 | rc.2 的 kit 从消费方解析到的入口锚定引擎；垫片在运行树里、引擎在 payload 里。垫片现在把 `resolveEnginePackage` 显式指向 payload 的 `node_modules`，修后经垫片也转出 18303 字节 |

## 12 覆盖补齐（P2 与探针） `[实测]`

| 项 | 做了什么 |
|---|---|
| `probe-whale.cjs` → `probe-whale.mjs` | 旧探针要一个 http URL，而桌面窗口的文档是 `dsh-app://app`（只在应用进程内），宿主 URL 的 token 又被日志脱敏，因此它一直跑不了。改为 CDP 驱动运行中的窗口，量两张 canvas 的**已绘像素**：我们的层空闲有像素、上游空闲 0、点击空白后 62042 像素并自行清空。5 项全过 |
| 新增 `probe-settings-rail.mjs` | `probe-settings-nav.cjs` 需要一个装好并构建过的 harness 检出（它靠 `pnpm dsh web` 起内核），本机没有。新探针走 CDP：设置栏 17 行、每行至多一个原生字形、合并后的「维护设置」恰好一行；英文窗口的 Han 检查在中文窗口下自动跳过并说明原因 |
| `plugin-mcp` 的 P2 | `fleet.list()` 每页只读一次（原先每条一次，O(n²)）；删掉已无人用的 `nextEntryId` / `assertUniqueServerName` / `McpStore.log` / `McpStore.available`；`configured: false` 的记录现在报告为「已移除、内核收尾中」而不是普通条目；客户端未知状态回退成 `starting` 而不是「已停用」；编辑表单不再允许改 `serverName`（host 一律拒，等于每次一个 400）；`package.json` 描述改成新机制；`dsh-tools` 从 peer/dev 里删掉（已无人 import） |
| `plugin-swarm` 的 P2 | schema 测试现在校验**编译后**的 schema，并覆盖 ready / `status_only` / dry-run 三种形态；另加一条源码断言，钉住「注册的就是导出的那个常量，不是内联副本」 |

## 13 第三轮（发版前）审查与修复 `[实测]`

两路原生 reviewer 并行；此前派给 Orca worker「雪洛」的同一任务因模型配额 429 异常终止，没有产出。

| # | 发现（P1） | 修法 | 验证 |
|---|---|---|---|
| 1 | 页面把 `$ENV:NAME` 当占位符教给用户，而这条线只解析 `${credential:NAME}`；旧值被当字面量发给子进程，卡片却显示已挂载 | 占位符、类型 JSDoc、字段注释改成 `${credential:…}`；并在 `status.ts` 补回**真正的生产者**：检出 `$ENV:` 值就挂 `env.legacyRef` 警告 | `status.test.ts` 新增一条（mounted + 1 条警告，字段名正确） |
| 2 | `guardWrite()` 在路由的 `try` 之外调 `store.load()`，读不到行配置时抛出未编码错误（浏览器看到裸 500） | 把读取包进 `try`，失败走同一个 `writeRejection` | `routes.test.ts` 新增一条：盲编辑器 + create → 400 且 `host.code = store.unreadable` |
| 3 | 卡片开关把整条条目回写（页面加载时的快照），两个写者之间改过的字段被回滚/删除 | 新增一字段路由 `POST /server/enable` + `McpStore.setEnabled()`，只改 `enabled`；客户端改用该路由 | `routes.test.ts` 新增一条：改开关不动并发改过的 `command` |
| 4 | `linkPrimaryRuntime` 先删旧链接再建新链接：一次被拒绝的 junction 会让应用带着已毁的链接启动不能 | 先建**暂存**链接（拒绝就抛、旧链接不动），再删除旧链接 + rename 换入；中途失败按 `previous` 重建旧链接 | `primary-runtime-leaf.test.mjs` 11/11；Windows 上 `rename` 不能覆盖目录，实测后改为「暂存优先 + 删除后 rename」 |
| 5 | 两个新探针 `import '../scratch/cdp-lib.mjs'` —— `scratch/` 是 gitignore 的，新克隆里跑不了 | 助手移入 `scripts/lib/cdp.mjs` 并入库，两个探针改指向 | 两个探针在本机 5/5 与 4/4 |
| 6 | 构建期垫片门槛是「包名存在吗」：下一次 provider 改名会再次静默丢能力 | 改成问产物：树里若有包声明 `@deepseek-ai/libreoffice-kit` 而 provider 不在，**构建失败**并指名 | `runtime:build` exit 0 且日志出现 `LibreOffice kit shim: …` |
| 7 | overlay 里 hero 那段注释仍在论证「关掉官方行」，并引用已作废的 752×611 / opacity 0.18 测量，而该行是 `disabled: false` | 注释改成规则本身（我们的层负责静止画面，上游画布静止透明、点击才播；需要时一行关掉即可） | `probe-whale.mjs` W2 依赖该行保持开启 |

非阻塞也已处理：跨 transport 的残留字段一律删除、两个内核服务改为每次调用时解析（激活早于服务挂载不再永久只读）、
插件开关关闭时不再执行旧文件导入、`McpStore` 去掉第三个已删参数（测试同步）、`locale/*.json` 的描述、
`probe-settings-rail` 的 S3 改为 `=== 1`、`probe-whale` 的 W4 增加「层必须存在」前置、`commands.md` 表格断行、
`office-payload.ts` 里与 `pruneOtherVersions` 矛盾的那句、`probe-routes` 的孤立 JSDoc、swarm 两条启动失败路径上的 `name`。

**未处理并已登记**：`stageOfficeSkills` 死重量（Deferred 行）、设置页暴露 `restart`/`probe`（Deferred 行）、
swarm 批次级 schema 没有独立校验（真机一轮 turn 已覆盖整值，但无单测）、`docs/plans/…:94` 的 W13 与 Deferred 已改为一致表述。

## 14 发布 `[实测]`

| 项 | 结果 |
|---|---|
| shell 发布 | `v0.19.0`，tag 与 `main` 同一提交；CI（`43184524734`）两作业全绿；release 运行（`43184563006`）`prepare-release` / `resolve` / 六个 runtime cell / `mirror runtime` / 四个 app cell 全绿 |
| runtime 产物 | `runtime-0.2.2-rc.2` **保持 prerelease**；六个 cell 的 manifest 均为 `dshVersion 0.2.2-rc.2`、`suiteVersion ededa5ec`（无混版）；每个 cell 的 `.sha512` 与 manifest `integrity` 逐一对上 |
| 产物内容 | 从 `dsh-runtime-win32-x64-0.2.2-rc.2.tgz` 里读出六个改动插件的版本：`plugin-mcp 0.3.3`、`plugin-swarm 0.9.5`、`plugin-pdf 0.3.0`、`plugin-rewind 0.2.1`、`plugin-websearch 0.3.2`、`plugin-client-ui 0.6.1` |
| 办公载荷 | 六个 cell 各带 `office-payload-<cell>-0.2.2-rc.2.tgz` + `.sha512` + `.json`，`payloadVersion` 均为 `0.2.3-py3.12.14` |
| 发布页 | `gh release edit v0.19.0 --draft=false --notes-file release-notes.md`（12980 字节）→ 正文 9843 字符，`releases/latest` 指向 v0.19.0 |
| ModelScope 镜像 | `publish-mirror`（`43188542745`）Summary **OK**：`releases/latest` + `releases/archive/0.19.0`、21 个资产；prune 保留最新 10 个 stable 并删除 0.17.9；latest cleanup 保留本次 21 个名字、删掉 17 个 0.18.8 残留 |

发版过程中被 release-check 拦下的一处：`check:graph` 在 `plugin-websearch` 的两个文件里发现字典外的 Han 字符（provider 的 `zh` 说明），
搬到 `plugins/plugin-websearch/src/locales.ts` 后才打 tag。
