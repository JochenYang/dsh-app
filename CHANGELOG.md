# Changelog

DSH APP 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更（不含历史全量），
与 GitHub Release 的 release notes 保持一致。发布流程见 `docs/agents/build-and-release.md`。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.7]`），然后运行
`node scripts/gen-release-notes.mjs v0.1.7` 生成双语 notes。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，新条目加在列表顶部。

## [Unreleased]

### 中文
- **修复本地代理让两个搜索引擎必然报错**（用户报的：Parallel 报"no parsable JSON-RPC frame"、Bing 报"HTTP 302"）：**根因不是我们的适配**，是那台机器上的本地代理把响应头整包抹掉（实测 `headers: []`），于是两件事必然坏——**压缩体没有 `content-encoding` 就没人能解**（Parallel 直连 50,347 字节合法 JSON-RPC，走代理变成 10,817 字节 gzip），**重定向的 `Location` 没了就没人能跟**（Bing 对中文市场回 `302 → cn.bing.com`，直连 200、十个结果块）。修法两处：所有引擎请求都要求不压缩（`accept-encoding: identity`，与调用方自己的头**合并而不是覆盖**），以及 Bing 在"跟不下去的 3xx"时重试它自己指过的那台主机（`cn.bing.com`，中文市场）。真机复验：应用里探测从 "Parallel 失败 / Bing 失败" 变成 **Parallel 5 条 / 6886 ms、Bing 5 条 / 455 ms**
- **修复注册表请求同样被"会抹掉响应头"的代理弄坏（这次是镜像回退真的没生效）**：上一版只把取目录那处改成不压缩，而**注册表的两处请求没改**——于是 npmjs 不可用时，版本解析走到镜像那一跳也会拿到一堆没被解开的压缩字节，`JSON.parse` 失败，界面说"暂时取不到最新版本"。**实测对照**：同一个镜像地址，默认请求回来是 8,738 字节的 gzip（响应头为空），加 `accept-encoding: identity` 同一请求回来是 22,000 字节的合法 JSON。现在两条注册表请求都带上这个头。造条件用的是"只拦 npmjs、其余照常"的本地代理：**修之前** `/update` 回 `update.latestUnknown`，**修之后**回 `update.upToDate`（版本经镜像解析成功）
- **修复插件市场的目录源在"会抹掉响应头"的代理后面必然失败**：市场取目录时默认允许压缩，而实测本机的本地代理返回的响应**一个头都没有**（`headers: []`）——压缩后的字节还在，但说明它压缩的 `content-encoding` 没了，于是谁也没法解压，`JSON.parse` 直接失败。用户看到的是「**目录源返回了无法解析的 JSON**」，也就是**把传输问题说成了你配的源坏了**。现在取目录时显式要求不压缩（`accept-encoding: identity`）：同一个坏路径下，一个源从 1,036,056 字节的压缩垃圾变成 3,918,492 字节、4183 条的合法 JSON，另一个变成 95,330 字节的合法 JSON。真机复验：市场刷新从"两个源全失败、缓存停在 2 天前"变成 **4253 个插件、0 个失败、缓存更新到当下**。代价是带宽（这两个源压缩前约 1 MB 与 4 MB，仍远低于 8 MB 上限），而忽略这个头的源行为不变
- **启动画面现在跟随你的主题设置**：外壳里负责解析持久化偏好的那个函数**写对了、但从来没有被调用**——于是启动画面与窗口底色一直只看系统偏好（实测：偏好是深色时，启动画面仍是 `data-theme="light"`、底色纯白）。补上那次调用后，启动画面从第一帧（550ms 采样）就是深色。新增一条**结构性断言**盯住"这个函数必须被调用"这一类，因为**没有返回值的接线是单元测试看不见的**——而这个函数此前在 11 条单测里一直是绿的
- **修复上一次误判留下的两处损坏**：① 被外壳注释掉的**两行自定义模型配置已恢复**——后果比看起来重：模型页空白、输入框因「当前模型不可用」被禁用、用量统计显示为空，三件事是**同一个根因**，恢复后一起好了（真机核对：模型菜单回到 `DeepSeek-V4.1-Flash`、模型页列出 11 个提供商、用量页回到 2219 次请求 / 611.19M tokens）；② 目录形态预设迁移成注册行时**漏写了显示名字段**——这个包的字段表是 `id`/`plugins`（必填）加 `name`/`description`/`order`（显示），原来只写了 `id` 与 `description`，于是「自进化模式」在选择器里退回显示目录名 `rsi-dev`；读取一直都在，是渲染时漏掉了，所以补的是**迁移渲染**那一处，并加了两条测试（有名字要带上、名字等于 id 时不写冗余字段）。**本机真机复验**：选择器显示「自进化模式」，触发菜单的「技能」分区里 7 个技能一个不缺
- **修复外壳误把「本来能加载」的行注释掉**：外壳每次启动会检查 profile 里每一行的包能不能解析，解析不到就注释掉它（防止「条目未激活」让整个界面打不开）。但它查的是共享回退位那**两处目录**，而内核宿主读的是**安装闭包表**——那份目录只是这张表的**镜像、会滞后**；它还把**子路径按目录拼**（任何 `包/子路径` 都必然失败）、把**嵌套组合里的名字**（某份预设内部有 35 个）也当成顶层条目来判。实测后果：用户自己的「自进化模式」预设被**整行**注释掉，两行自定义模型配置也被注释掉。三处现在都改对了（多查"安装闭包"这处权威位置、子路径按**包根**判、只判一行**自己的**条目），真机复验跳过数 **3 → 0**。**注意：新判据只防将来，不会自动解除已经被注释的行**——本机受影响的那两行已按同一判断手工恢复（见本列表第一条）
- **插件在插件管理页显示自己的名字与图标**：16 个套件插件现在各自声明多语言标题、描述与图标（`locale/<语言>.json` 加 `package.json` 的 `icon`），插件管理页不再显示 `@dsh-app/plugin-…` 这样的包名。**漏掉 `exports["./locale/*.json"]` 会静默退回包名、不报任何错**，所以新增一条门禁盯住四件事：`en.json` 在、`exports` 与 `files` 两行在、每个语言文件的标题与描述非空、图标存在且合法
- **诊断页新增「组合静态检查」**：让内核在**不启动 profile** 的前提下组合一遍配置，报出它没能静态校验的条目，并把每条诊断**归因到具体哪一行**——「我们的行」与「别人的行」分开计数，因为内核自带的四个预设在一份**全新 profile** 上就会报出同样的内容，只给一个错误数会让人去查错地方
- **四个文档插件的交付步骤改为登记成品**：导出成功后，若当前会话提供 `present` 工具，就用它把成品登记为本次交付——**没登记过的文件不会出现在会话的交付卡片里**（提示是条件式的：裸预设没有这个工具）
- **目录形态的旧预设会自动迁移**：0.1.7 不再从 `.agent-presets/<名字>/` 读预设，这样写的预设会凭空消失。启动时会把它们声明成新机制要求的那一行，**追加到用户自己的那一层**（`$DSH_HOME/cordis.patch.yml`），并把唯一依赖相对路径的那行改成绝对路径；`!!js` 表达式**逐字保留**（整块缩进嵌入，不是解析后重新序列化——后者会丢掉标签、把 `disabled` 变成恒真的字符串），旧文件改名留存、**绝不删除**
- **子代理与用量统计的配置改由内核保存**（`plugin-swarm` / `plugin-usage`）：可调旋钮改成声明式配置字段，改完**立即生效、重启仍在**，不再依赖各自目录下的 `config.json`（旧文件首次启动时导入并改名留存）。写回时**总是带上全部可调字段**——那一行会整行替换 overlay 的行，漏字段会让没碰过的旋钮掉回默认值
- **内核线更新到上游 0.1.7-alpha.1**（适配清单见 `docs/kernel-0.1.7-alpha.1-regression.md`）。这一线改了几件我们必须跟的事：宿主新增 `platform-session` 消息（外壳过去把**任何**不认识的 IPC 当成非法并杀掉子进程，现在只记 tag 后忽略）；用户设置从 `$DSH_HOME/settings.yaml` 搬进 profile 的 `cordis.patch.yml`（该文件由外壳每次启动重建，所以外壳现在用一个尾部标记把内核写的行原样保留，并给旧文件留了安全回退）；客户端设置服务改名 `settingsScope` → `configForms`；会话日志升级到 V4（旧内核不会列出新格式的会话）；Office 转换结果从 base64 字符串改为字节；宿主 argv 去掉了 profile 解析模式那一段（我们继续发的 `link` 会被当成包管理器脚本，宿主侧包操作全坏）
- **套件移除快速文件搜索插件**（`plugin-fff`）：上游默认预设已内置 `glob`/`grep`（ripgrep），宿主层再注册一套会让模型同时看到五个搜索工具；而它的运行时依赖是第三方**原生 addon**，按平台分发、随包构建，属于没必要的脆弱面。工具由上游承接，`fffind`/`ffgrep`/`fff-glob` 下线；五处名册与构建脚本同步，套件由 17 个插件变为 16
- **开发版启动改为跟随本地 runtime**：`npm run dev` 不再探测并直接跑 `../deepseek-harness` 源码树（源码没构建就会启动上一版产物——本机实测检出落后三次构建、还带着 0.1.6 的符号），默认改为启动**已安装的运行时**，与生产同一个内核；需要对着实时源码时显式给 `DSH_APP_DEV_RUNTIME`，想指定一棵已构建的 runtime 用 `DSH_APP_DEV_KERNEL`
- **会话数据的三道防护**：内核回滚前先扫一遍 `$DSH_HOME/sessions` 里有没有新格式（V4）世代，有就把提示从"已回滚"换成"这些会话暂时不会出现在列表里、文件仍在磁盘上、请先不要清理"；归档删除的前置条件改用内核自己的活动 seam（`workspace/session-activity`，与 `archiveSession` 同一套判定，替掉了我们自造的 mid-turn 猜测，且判不出来时按"可能有活在跑"处理）；`/prune` 的最终判据落到文件系统——"这个内核列不出来"不等于"日志没了"，否则回滚之后会把用户的归档记录清掉
- **若干静默失效的修复**：首屏主题读的文件已被内核改名（窗口会退回系统默认，现在按行序问三处地址）；用量统计的水位在日志迁移后会永久少算（现在按日志格式做见证，格式变化时先删该会话旧行再重折，避免把少算换成多算）；配置备份漏掉改名后的设置文件；插件市场只连 npmjs（现在 npmjs 连不上时回退 npmmirror，且"连不上"与"没有这个包"分开判定）；websearch 的引擎会计遇并发多查询会被覆盖（改为按 query 记账）
- **归档管理改用公开 API**：`/prune` 过去要伸进 workspace registry 的私有写链才能移除一个归档记录，0.1.7 提供了 `unarchiveSession`——顺带消掉"内核加字段、我们整体重写时丢字段"这类未来缺陷
- **修复用量统计页面滚动卡顿**：热力图 53 周共 371 个格子各画一道内嵌细边，滚动设置面板时滚容器每帧都要把它们重新光栅化一遍（实测：帧间隔 p95 27.8ms，空闲时 6.9ms，每次滚动掉 7 帧）。现在把网格提升为独立的合成层，滚动只是移动一张缓存纹理（实测 p95 13.9ms、掉帧 0）。布局不受影响：在 556/520/460/400/300px 五个面板宽度下，网格宽度、格子尺寸、缩放模板与溢出回退行为与改动前逐项一致
- **清理一次性探针**：删除 19 个只服务过一次调查、且已无任何引用的探针（9 个 `probe-advanced-*`，以及 `probe-close-dialog`、`probe-fff`、`probe-heatmap`、`probe-retry-card`、`probe-shell-update`、`probe-startup-window`、`probe-usage`、`probe-websearch`）。保留 7 个仍有活引用、删掉会弄红其它东西的：`probe-drag`（被 `desktop-chrome-css` 测试读取）、`probe-launch-folder`（被递归删除守卫测试审计，也是内核线升级后的步骤）、`probe-settings-nav`（改设置分区后的步骤）、`probe-mirror`（README 的连通性自检）、`probe-in-frame-dialog` 与 `probe-update-card`（各自模块的 JSDoc 指明由它们执行）、`probe-whale`（`whale-background` 的诊断接口专为它暴露）

### English
- **Fix two search engines that always failed behind a local proxy** (reported: Parallel said "no parsable JSON-RPC frame", Bing said "HTTP 302"): the cause is **not** our adaptation, it is the local proxy on that machine returning responses with **no headers at all** (measured: `headers: []`), which breaks two things by construction — **a compressed body with no `content-encoding` cannot be decoded** (the Parallel endpoint answered 50,347 bytes of valid JSON-RPC directly and 10,817 bytes of gzip through that path), and **a redirect with no `Location` cannot be followed** (Bing answers the zh market with `302 → cn.bing.com`; direct it is 200 with ten result blocks). Two fixes: every engine request now asks for an uncompressed body (`accept-encoding: identity`, **merged with** the caller's headers rather than replacing them), and Bing retries the host it named itself (`cn.bing.com` for the zh market) when it cannot follow a 3xx. Measured in the app: the engine probe went from "Parallel failed / Bing failed" to **Parallel 5 results / 6886 ms and Bing 5 results / 455 ms**
- **Fix the registry requests broken by the same header-stripping proxy (the mirror fallback was not really working)**: the previous change asked for an uncompressed body on the catalog path only, and left the **two registry requests** untouched — so with npmjs unreachable, the version resolution reached the mirror and still got compressed bytes nothing could decode, `JSON.parse` failed, and the panel said the latest version could not be fetched. **Measured**: the same mirror URL answered 8,738 bytes of gzip with an empty header set by default, and 22,000 bytes of valid JSON with `accept-encoding: identity`. Both registry requests now carry the header. The condition was built with a local proxy that refuses only npmjs: **before** the fix `/update` answered `update.latestUnknown`, **after** it answers `update.upToDate` (the version resolved through the mirror)
- **Fix the plugin market's catalog sources failing behind any proxy that strips response headers**: the catalog fetch advertised compression by default, and the local proxy measured here answers with **no headers at all** (`headers: []`) — the compressed bytes arrive, the `content-encoding` that explains them does not, so nothing can decode them and `JSON.parse` fails outright. What the user sees is "**the catalog source returned unparsable JSON**", i.e. **a transport problem reported as their source list being broken**. The fetch now asks for `accept-encoding: identity`: down the same broken path one source went from 1,036,056 bytes of gzip to 3,918,492 bytes / 4183 valid entries, and the other to 95,330 bytes of valid JSON. Measured on a real boot: the market's refresh went from "both sources failed, cache stuck at two days old" to **4253 plugins, 0 failures, cache updated to now**. The cost is bandwidth (those sources are ~1 MB and ~4 MB uncompressed, well under the 8 MB cap), and a source that ignores the header behaves exactly as before
- **The startup page follows your theme setting now**: the function that resolves the persisted preference was written correctly and **never called** — so the splash and the window chrome only ever followed the OS preference (measured: with a `dark` preference the splash still painted `data-theme="light"` on white). With the call in place the splash is dark from its first frame (550ms sample). A **structural assertion** now guards this class of defect, because **wiring with no return value is invisible to unit tests** — and that function had been green under eleven of them
- **Repair the two kinds of damage the earlier misjudgement left behind**: ① the **two commented-out custom model-configuration rows are restored** — the consequence was heavier than it looked: an empty model page, a composer disabled by "the current model is unavailable", and a usage page showing no records, all three from ONE root cause and all three cured by the restore (measured on a real boot: the model menu is back to `DeepSeek-V4.1-Flash`, the model page lists 11 providers, and usage is back to 2219 requests / 611.19M tokens); ② migrating a directory-shaped preset into a registration row **dropped its display-name field** — that package's field table is `id`/`plugins` (required) plus `name`/`description`/`order` (display), and only `id` and `description` were written, so "自进化模式" fell back to the directory id `rsi-dev` in the chooser. The value was always read; the renderer dropped it. The fix is that one renderer, with two tests (a name travels through; a name equal to the id is not written twice). **Verified on a real boot**: the chooser shows 自进化模式, and the trigger menu's skills section carries all seven of the preset's skills
- **Fix the shell commenting out rows that COULD load**: at startup the shell checks whether each row's package resolves and comments out the ones that do not, so an "entry did not activate" cannot leave the window unusable. But it checked the two MIRROR directories under `$DSH_HOME/profiles/node_modules`, while the kernel host resolves through the **installation closure table** — that directory is a copy of the table and lags behind it. It also built a SUBPATH's path out of the whole specifier (so any `pkg/sub` failed by construction) and judged names inside NESTED compositions (35 of them in one preset) as if they were top-level entries. Measured consequence: the user's own "self-evolving" preset was commented out **entirely**, as were two custom model-configuration rows. All three are fixed (the closure is consulted as the authoritative position, a subpath is judged by its package root, and only a row's OWN entries are judged), and a real boot shows the skip count go from three to zero. **Note: the new rule only prevents this going forward — rows already commented out are not restored automatically**; the two this machine had were restored on the same judgement by hand (see the first entry above)
- **Plugins name themselves in the plugin manager**: all sixteen suite plugins now declare a localized title, description and icon (`locale/<language>.json` plus `icon` in `package.json`), so the plugin manager shows a real name instead of `@dsh-app/plugin-…`. **Omitting `exports["./locale/*.json"]` falls back to the package name with no error at all**, so a new gate guards the four things that matter: `en.json` present, the `exports` and `files` rows present, a non-empty title and description in every language file, and an icon that exists and is legal
- **The diagnostics page gains a static composition check**: it has the kernel compose the profile WITHOUT starting it and report every entry it could not type-check, **attributing each finding to the row it points at** — "our rows" and "everybody else's" are counted separately, because the kernel's own four presets report the same findings on a brand-new profile and a bare error count sends a reader hunting in the wrong place
- **The four document plugins register their deliverable**: after a successful export, the model declares the artifact with `present` when the session provides that tool — a file that was never declared never reaches the session's delivery card (the instruction is conditional: the bare preset does not mount it)
- **Directory-shaped presets migrate themselves**: 0.1.7 no longer reads presets from `.agent-presets/<name>/`, so a preset written that way disappears. At startup it is now declared as the row the new mechanism wants, appended to **the user's own layer** (`$DSH_HOME/cordis.patch.yml`), with the one relative path rewritten to an absolute one; `!!js` expressions travel **verbatim** (the composition is embedded by indenting its text, not parsed and re-serialized — the latter drops the tag and turns `disabled` into a truthy string), and the old file is renamed aside, **never deleted**
- **Subagent and usage configuration move to the kernel** (`plugin-swarm` / `plugin-usage`): the tunable knobs are declarative config fields now, so a change applies immediately and survives a restart, with no per-plugin `config.json` (an existing file is imported on first start and renamed aside). Every write carries **all** editable fields — that row replaces the overlay's row wholesale, so a missing field would drop an untouched knob back to its default
- **Kernel line moved to upstream 0.1.7-alpha.1** (the full adaptation list lives in `docs/kernel-0.1.7-alpha.1-regression.md`). That line changed several things we had to follow: the host sends a new `platform-session` message (the shell used to treat ANY unknown IPC as invalid and kill the child — it now logs the tag and ignores it); user settings moved from `$DSH_HOME/settings.yaml` into the profile's `cordis.patch.yml`, a file the shell rebuilds on every start (it now keeps what the kernel wrote behind an explicit tail marker, with a safe fallback for older files); the client settings service was renamed `settingsScope` → `configForms`; the session log is V4 (an older kernel does not list a newer log at all); Office conversion results arrive as bytes instead of a base64 string; and the host's argv dropped the profile-resolution mode (the `link` we kept sending was read as a package-manager script, breaking every in-app package operation)
- **The suite drops its fast file-search plugin** (`plugin-fff`): the default upstream preset already mounts `glob`/`grep` (ripgrep), and a second set registered on the host plane left the model looking at five search tools; its runtime dependency was a third-party NATIVE addon, shipped per platform and built into the artifact — a fragile surface with nothing to show for it. Upstream keeps the capability; `fffind`/`ffgrep`/`fff-glob` are gone, the five roster places and the build scripts follow, and the suite goes from seventeen plugins to sixteen
- **Dev startup now follows a local runtime**: `npm run dev` no longer probes and runs `../deepseek-harness` straight from source (an unbuilt checkout boots the PREVIOUS build — measured on this machine: three builds behind HEAD, still carrying 0.1.6 symbols). It boots the INSTALLED runtime by default, the same kernel production runs; name `DSH_APP_DEV_RUNTIME` to work against live sources, or `DSH_APP_DEV_KERNEL` to point at a built runtime tree
- **Three guards for session data**: before a kernel rollback the shell now scans `$DSH_HOME/sessions` for newer-format (V4) generations and, when it finds any, replaces "rolled back" with "those sessions will not appear in the list for now; their files are still on disk, so please do not clean up yet"; the archive-delete fence now asks the kernel's own activity seam (`workspace/session-activity`, the same one `archiveSession` refuses on) instead of our mid-turn guess, and treats "cannot tell" as "work may be running"; and `/prune` lets the filesystem have the last word — "this kernel cannot list it" is not "the log is gone", or a rollback would delete the user's archive records
- **Several silent failures fixed**: the splash read a settings file the kernel had renamed (the window fell back to the OS default; it now asks three addresses in the order the lines introduced them); the usage statistics' watermark under-counted forever after a log migration (a log-format witness now drops it, and that session's rows are removed before the log is folded again — otherwise the under-count would have become a double-count); the config backup missed the renamed settings file; the plugin market only ever talked to npmjs (npmjs → npmmirror now, with "unreachable" kept distinct from "no such package"); and the websearch chain accounting was overwritten by concurrent queries (keyed by query now)
- **The archive manager uses the public API**: `/prune` used to reach into the workspace registry's private write chain to remove a record; 0.1.7 publishes `unarchiveSession` — which also retires a whole class of future defects where a field the kernel adds is dropped by our whole-state rewrite
- **Fix the usage page's scroll hitch**: the heatmap's 53 weeks are 371 cells, each painting an inset hairline, so scrolling the settings pane made the scroller re-rasterize all of them every frame (measured: p95 frame gap 27.8ms against 6.9ms idle, 7 dropped frames per scroll). The grid now has its own compositor layer, so the same scroll moves a cached texture (measured p95 13.9ms, 0 dropped frames). Layout is unaffected: at 556/520/460/400/300px panel widths the grid width, cell size, fit template and overflow fallback are identical to before
- **Delete the one-off probes**: 19 probes that served a single investigation and hold no live reference are gone (the nine `probe-advanced-*` files, plus `probe-close-dialog`, `probe-fff`, `probe-heatmap`, `probe-retry-card`, `probe-shell-update`, `probe-startup-window`, `probe-usage` and `probe-websearch`). The seven with a live caller stay, since deleting them would break something else: `probe-drag` (read by the `desktop-chrome-css` test), `probe-launch-folder` (audited by the recursive-delete guard test, and the post-kernel-bump step), `probe-settings-nav` (the settings-section step), `probe-mirror` (the README connectivity check), `probe-in-frame-dialog` and `probe-update-card` (named by their modules' JSDoc), and `probe-whale` (owns the diagnostics `whale-background` exposes)

## [v0.13.1] - 2026-09-21

### 中文
- **设置页收敛为一个「维护」分区**：用量统计、预设包、诊断三个页面此前各占一行导航，现在合并为同一个分区下的三个页签（顺序不变：用量 → 预设包 → 诊断）。页签沿用内核自己「内置插件」分区的做法——切换过的页签保持挂载，所以已加载的数据与滚动位置不会丢；只启用其中一个插件时，它直接渲染为页面本身，不画多余的页签条
- **用量热力图改为整年视图**：窗口从半年扩到 53 周，并新增三档粒度——**每日 / 每周 / 累计**（每周档整列显示该周合计，累计档按阅读顺序显示累计量，三档共用同一张网格，切换时形状不变）；补齐两个锚点数字（活跃天数、单日最高及其日期）与窗口合计，月份标签移到网格下方，行序改为周一为首；格子宽度随面板实测缩放（先让格间距让路，再压格子尺寸），窄窗口不再把最新的周挤到看不见的滚动区外
- **修复用量记账的三处缺陷**：① 历史回填整条是死代码——它按 `entry.id` 读会话列表，而上游返回的是包装结构（id 在 `entry.header.id`），于是每次扫描都是 `inspected 0`，**全新安装看不到任何历史用量**；② 落盘失败会**静默丢行**——待写行在写盘前就被清空、水位却已提升，之后既不会重试也不会被回填重读，用量统计从此永久偏低；现在写成功才清缓冲、行落盘才写水位；③ **fork 会话重复计数**——子会话的日志物理包含父会话的前缀，回填会把它按子会话再记一遍，现按内核声明的 `inheritedEventCount` 跳过继承段
- **修复跨夏令时的日桶错位**：按天分桶此前用固定 86 400 000 毫秒步进，在有夏令时的时区会让窗口起点偏移一小时（实测：回拨那天起点变成 01:00 而非 00:00），该日首小时的用量被整个丢弃，且卡片总数与柱状/热力图之和不再相等。现在改为日历步进（`setDate`/`setHours`），并补上回归测试
- 另外：插件版本号的补丁位改为**单位数进位**（`0.8.9` → `0.9.0`，不再堆叠 `0.8.10`），规则写进 `plugins/AGENTS.md` 与发布文档；设置导航探针补上中文模式的判定门槛与正确的运行路径
- **会话记忆改为「模型主动保存 + 只整理已有卡片」**：移除全局作用域（它的卡片会被注入到每个项目的会话里，而多数模型并不会去写它；旧卡片与归档在启动时迁入 `projects/legacy-global/`，可看可删），也不再从会话里自动抽取记忆——保存由模型在任务收尾时用 `memory_save` 主动完成，后台只保留整理通道（合并近似主题、清理重复与流水账）。设置页的项目记忆新增**「整理」按钮**：跳过卡数下限、指纹、冷却与空转退避（点击本身就是授权），但保留总开关、单飞与全部落盘守卫；结果按八种状态回报（已整理 x 条 / 没有需要改动的 / 提案被拒 / 已有整理在进行 / 需要打开中的会话借模型路由 等），不再把「提案全被拒」说成「不需要改动」

### English
- The settings panel collapses into one **Maintenance** section: usage statistics, preset packages and diagnostics each held a nav row of their own and are now three tabs of one section (same order: usage → presets → diagnostics). The tabs follow the kernel's own built-in-plugins pattern — a visited tab stays mounted, so loaded data and scroll position survive a switch, and a single remaining contribution renders as the page itself with no strip to choose from
- The usage heatmap becomes a full-year view: the window grows from 26 to 53 weeks and gains three granularities — **daily / weekly / cumulative** (weekly shows each week's total across its column, cumulative shows the running total in reading order, and all three share one grid so switching never changes its shape); it now carries the two anchoring numbers (active days, busiest day with its date) and the window total, month tags move under the grid, rows read Monday-first, and the cell size scales to the measured panel (the gap gives way first, then the cells), so a narrow window no longer pushes the newest weeks behind an unannounced scrollbar
- Three usage-accounting defects are fixed: (1) the historical backfill was dead code — it read the session list as `entry.id` while upstream returns a wrapper whose id lives on `entry.header.id`, so every scan reported `inspected 0` and **a fresh install saw no history at all**; (2) a failed flush **silently dropped rows** — the pending batch was cleared before the write while the watermark had already advanced, so neither a retry nor the backfill would ever reproduce them and the totals stayed permanently low; rows are now cleared only after the write lands and the watermark only after its rows are on disk; (3) **forked sessions double-counted** their parent's usage, because a fork's log physically contains the parent's prefix — the inherited cut the kernel declares (`inheritedEventCount`) is now skipped
- Day bucketing no longer drifts across a DST transition: it stepped by a fixed 86 400 000 ms, which in a DST zone shifted the window's start by an hour (measured: on the fall-back day the start became 01:00 instead of 00:00), dropping that day's first hour of usage and leaving the card totals unequal to the sum of the bars and heatmap cells. It now steps through the calendar (`setDate`/`setHours`), with regression tests
- Also: a plugin's patch field is now a **single digit** (`0.8.9` → `0.9.0`, never `0.8.10`), written into `plugins/AGENTS.md` and the release doc; the settings-nav probe gained its missing zh-CN gate and the correct run path
- **Cross-session memory now saves on the model's own initiative and only tidies what exists**: the global scope is gone (its cards were injected into every project's sessions while few models ever wrote to it; the old cards and their archive migrate into `projects/legacy-global/` at boot, visible and deletable), and nothing extracts memory from a conversation any more — the model saves what it judges durable through `memory_save` before a task ends, and the background pass only consolidates cards that already exist (merging near-duplicates, clearing duplicates and work logs). The project memory rows gained a **Curate button**: it bypasses the card threshold, the fingerprint, the cooldown and the stall back-off (the click is the ask) while keeping the master toggle, single flight and every apply-time guard, and it reports eight coded outcomes (curated N cards / nothing needed changing / proposals refused / a pass is already running / needs an open session to borrow a model route) instead of calling a refused pass "nothing to change"

## [v0.13.0] - 2026-09-20

### 中文
- **内核安装不再可能被静默降级**：从镜像链装上的运行时会先核对自己声明的版本是否与所请求的一致——官方源不可达、元数据由第三方代理回退提供时，代理也无法拿一个自洽的旧版本包顶替；解压同时拒绝指向解压目录之外的链接目标（含 Windows 盘符相对形态）
- **外壳的更新检查改为官方优先**：版本这一事实来源先读官方仓库，镜像退为回退（几百兆的安装包下载仍是镜像优先，且每个候选都要通过元数据里的 sha512）
- **日志脱敏补齐四类没有键名的凭据形态**（`Bearer` 令牌、JWT、`sk-` 前缀、`Set-Cookie`），内核与宿主子进程的输出在落盘与诊断页显示之前都会经过
- **窗口导航围栏收紧**：只放行应用自身来源与启动页文件，其余本地文件一律交给系统打开；`window.open` 打开的应用内子窗口现在同样带上围栏
- **代理自动探测更严格**：只有端口后面的监听者真的会以 HTTP 应答时才注入代理环境——以前任意占用 7897/7890 的本地进程都会被当成代理接收内核的出站流量
- **构建与发布的验证补洞**：CI 现在会跑运行时产物的文件级检查（PPT 模板、PDF 字体这类资源此前从不被验证）；darwin 与 win32-x64 的发布单元会在打包前用宿主自己的代码实际执行一次办公相关的 Python 集（darwin 的两套此前从未运行过就发出去了；win32-arm64 是跨架构构建——宿主会拒绝非本机架构的树，那一套仍无法在 runner 上自检）
- 另外：办公载荷安装改为「先让位、再替换」，替换失败不再丢掉已装好的引擎；套件新增两条静态检查（磁盘上未登记进名册的插件、字典之外的界面文案）；plugin-fff 补上了此前缺失的测试

### English
- A kernel installed through the mirror chain can no longer be silently downgraded: the runtime
  must declare the version that was requested — when the official host is unreachable and a
  third-party proxy answers with the metadata, that proxy cannot substitute a self-consistent
  older build either; extraction now also refuses link targets that point outside the extraction
  root (including Windows drive-relative forms)
- The shell update check reads its metadata official-first: the version is taken from the release
  owner's own copy, with the mirror as fallback (the several-hundred-MB installer download is
  still mirror-first, every candidate gated by the sha512 that metadata carried)
- Log redaction now covers four credential shapes that carry no key name (`Bearer` tokens, JWTs,
  `sk-` prefixes, `Set-Cookie`), applied to child output before it reaches the log file or the
  diagnostics page
- The window's navigation fence is tightened: only the app's own origin and its startup page pass,
  every other local file is handed to the OS, and in-app child windows opened with `window.open`
  now carry the same fence
- Proxy detection is stricter: the proxy environment is injected only when the listener on the
  port actually answers as HTTP — previously any process squatting on 7897/7890 was adopted as a
  proxy and received the kernel's outbound traffic
- Verification gaps in build and release are closed: CI now runs the artifact-level checks on the
  runtime (PPT templates, PDF fonts — this class was never executed before), and the darwin and
  win32-x64 release cells execute the office Python set with the host's own code before packing it
  (the darwin sets had never been run anywhere; win32-arm64 is cross-built and the host refuses a
  tree for another arch, so that one still cannot be self-checked on the runner)
- Also: the office payload installs by moving the old copy aside first, so a failed swap no longer
  loses the working engine; the suite gained two static checks (a plugin on disk that no roster
  carries, UI copy outside the dictionaries); plugin-fff gained the test suite it was missing

## [v0.12.9] - 2026-09-20

### 中文
- **修复「升级后打不开」的一条主因**：内核为「没有补丁」写出的空补丁（`[]`）被我们当成一段内容拼进了档案补丁，而 YAML 读到它就把文档结束掉——整个补丁文件解析失败，新旧内核都起不来、回滚也无效；又因为「内容不变就不重写」，坏文件会一直留着，安全模式也救不了（它只丢套件行）。现在这类空段被识别为空并就地写明原因，**升级后首次启动即自动修复**。同类的另外三种形态一并修掉：CRLF 补丁读不出行、引号里含空格的路径读不出行、以及档案迁移只搬补丁文本不搬它引用的文件（本地插件因此在迁移后丢失）
- **启动前校验两处前提**：复用已安装的内核前会确认它仍带着启动必需的宿主包（残缺的内核树以前会被当成好的用，回滚因此失效）；办公载荷物化后会校验目标（半拷贝或被杀软清掉以前是永久打不开，重装与回滚都治不好）
- **失败时说得清、也能一键修**：若失败来自常驻配置 `$DSH_HOME/cordis.patch.yml` 里某一行指向当前档案没有的包，卡片会直接列出**文件、行号、那一行**，并给出「安装缺失的包并重启」按钮——**不改动你自己的配置**，只把缺的包装进当前档案；装包与插件市场走同一条命令行，并遵守同样的冷却期政策
- 另外：启动页加载不出来时窗口也会显示（以前是完全没有任何界面）；插件市场里停用的插件不再被下一次启动撤销；内核镜像清理不再删掉同一次启动刚链接好的套件

### English
- Fixed a main cause of "it will not open after updating": the empty patch the kernel writes
  for "no patch" (`[]`) was concatenated into our profile patch as if it were rows, and YAML ends
  the document there — so the whole patch file failed to parse, neither kernel line could start
  (rollback included), and because the generator only writes when the content changed, the broken
  file stayed broken: safe mode did not help either, since it only drops the suite rows. Such a
  section is now read as empty with the reason written in its place, and an affected machine
  **heals on its first start after the update**. Three siblings of the same class went with it: a
  CRLF patch yielding no rows, a quoted path containing a space yielding no rows, and a profile
  migration that carried the patch text but not the files it names (so local plugins were lost)
- Two startup preconditions are now verified: an installed kernel tree is checked for the host
  package a start needs (an incomplete tree used to be reused, which made rollback a dead end), and
  the office payload is checked where it was materialized (a half copy or a cleaned-up one used to
  be permanent, since neither a reinstall nor a rollback clears that directory)
- A failure caused by the home layer is now named and fixable: when a row in
  `$DSH_HOME/cordis.patch.yml` points at a package this profile does not have, the card lists the
  file, the line and the row, and offers "install the missing packages and restart" — which
  **changes nothing in your own configuration** and only installs what those rows ask for, through
  the same command line the plugin market uses and under the same release-age policy
- Also: the window appears even when the startup page cannot be loaded (there used to be no
  interface at all), a plugin disabled in the market is no longer re-enabled by the next start, and
  dropping a kernel mirror no longer removes the suite links the same start has just made

## [v0.12.8] - 2026-09-19

### 中文
- **记忆模块加固**：整理流程不再对「本次没有真正读过正文」的卡片提出合并或删除——索引是整份传的，键叫得出来而正文被输入上限截掉，删掉就等于内容无声消失；现在编辑只能引用这一轮真正读到的卡片，并被一个轮转锚点带着走过被省略的尾部，容量受限的记忆库会被逐段覆盖，而不是永远跳过同一批。每次移除都先在该作用域留下 `archive/` 副本，两条后台整理通道的进度游标改为「写入成功才推进」，读不全的库不再把自己记成已整理，模型路由缺失时保留增量而不是判掉没人看过的新内容
- **设置页的记忆面板补齐了「删除」这条路**：归档面板现在列出**所有作用域**的副本（此前只查全局），于是删掉一条项目记忆时看到的 `已删除的记忆（0）` 是假象——副本其实躺在项目目录里；现在能逐条恢复、永久删除，也能清空全局记忆，手动删除与后台整理也分成了两条独立记录
- **新增窗口尺寸记忆**：首次启动按 1440×900 开窗并受工作区约束；之后记住上次的尺寸与位置（最大化状态一并记住），显示器拔掉后不会再把窗口开到屏幕外
- **配置备份的覆盖面扩大**：现在连同 `settings.yaml`（provider、模型清单、默认模型、主题、语言、权限）、`AGENTS.md`、`hooks/` 下的脚本一起导出与导入。密钥本体始终不在包内（存在凭据库），覆盖前 `settings.yaml` 与补丁层会自动留一份 `.bak-import-` 副本；用新版导出的备份在旧版应用上会被整包拒绝，跨机迁移时先把目标机升到同版本

### English
- Memory hardening: the curation pass no longer proposes merge or delete for a card whose body it never
  actually read — the index travels whole, so a key was nameable while its text had been dropped by the
  input cap, and removing it lost content silently. Edits now cite only the cards this pass read, a
  rotation anchor walks the omitted tail so a capped store gets covered piece by piece instead of skipping
  the same cards forever, and every removal leaves an `archive/` copy in its own scope first. Both
  background passes now advance their progress cursor only once the writes land, a store that could not be
  read whole no longer records itself as reviewed, and a missing model route keeps its delta instead of
  retiring material nobody ever judged
- The settings page's memory panel now has the deletion path it was missing: the archive list covers EVERY
  scope (it used to read the global one only, which is why deleting a project memory showed
  `已删除的记忆（0）` while the copy sat in the project directory). Entries can be restored one by one,
  deleted for good, or the global memory cleared wholesale, and a manual deletion is now a separate record
  from a background curation
- New: the window remembers its size. A first run opens at 1440×900 clamped to the work area; after that
  the last size and position are restored (a maximized window comes back maximized), and unplugging a
  monitor can no longer place the window off-screen
- The configuration backup now covers far more: `settings.yaml` (providers, model list, default model,
  theme, locale, permissions), `AGENTS.md`, and the scripts under `hooks/` travel with it. Key material is
  still never in the package (it lives in the credential store), overwriting `settings.yaml` or the patch
  layer first leaves a `.bak-import-` copy, and a backup exported by this version is refused whole by an
  older one — upgrade the target machine first when migrating

## [v0.12.7] - 2026-09-19

### 中文
- 修复「手动安装的新版本不会进入回滚记录」：版本历史原先只有应用内更新这一条写入路径（应用内更新会先写一份待安装记录，下次启动读到它才登记版本号），而手动下载安装包不会写那份记录——于是 0.12.6 手动装上后，历史仍停在 0.12.5，而托盘的「回滚到上一版」是按「历史倒数第二条」算的，实测它会把你退到 **0.12.4** 而不是 0.12.5。现在每次启动都会把「正在运行的版本」与历史对齐（纯函数判定，开发运行跳过）：当前版本会被移到末尾（重装/降级再升级不会留下两条同版本记录、把倒数第二条挤偏），列表仍保持 5 条上限，无法安全拼进安装包文件名的版本号一律不登记。这条修复对任何安装途径都生效——这正是上一版需要手动下载安装包时的痛点
- 顺带说明为什么会有这个缺口：手动安装不写待安装记录，恰恰是它「不残留、不会误删」的原因，两者是同一处设计的两面

### English
- Fixed a hand-installed version never reaching the rollback history: the only writer was the in-app update
  path (an in-app update stages a pending-install record, and the next boot reads it to register the
  version), while downloading and running the installer by hand writes no such record — so after 0.12.6
  was installed manually the history still ended at 0.12.5, and the tray's "roll back to the previous
  version" reads the SECOND-TO-LAST entry: measured, it would have taken the user to **0.12.4** instead of
  0.12.5. Every boot now reconciles the running version with the history (a pure rule, skipped for
  development runs): the current version moves to the end (a reinstall or a downgrade-then-upgrade must not
  leave two entries of one version and shift the second-to-last off the real previous release), the list
  stays capped at five, and a version that cannot be spliced into an installer filename is refused. The fix
  covers every install route — which is exactly the situation the previous release created when it could
  only be installed by hand
- Worth knowing why the gap existed: a hand install writing no pending-install record is precisely what
  makes it leave no residue and delete nothing it should not — two sides of one design

## [v0.12.6] - 2026-09-19

### 中文
- 修复安装办公组件（带 Python 集的那份载荷）后**应用再也起不来**：宿主只用 `argv[4]` 一个参数同时决定两件事——办公技能的资源根取 `dirname(argv[4])/office-skills`，而 `load_workspace_dependencies` 装的是 `argv[4]` 指向的那棵树。上一版为了让工具找到 Python 集，把参数直接指进载荷内部的 `primary-runtime`，资源根因此被算到 `<载荷>/office-skills`——那是任何产物都不带的目录，办公技能插件在启动时硬校验 `scripts/check_office.py` 并抛错（`ENOENT … check_office.py`），失败卡片只显示一句路径。现在参数**永远**是外壳数据目录下的固定叶子 `<dataDir>/dsh-app-office/primary-runtime`，载荷里的 Python 集**链接**到那里（Windows 用 junction，零拷贝）：资源根仍是 `<dataDir>/dsh-app-office/office-skills`（外壳本来就物化在那），而工具通过同一个叶子读到 `runtime.json`。载荷换版本时链接跟着换，内核不声明 Python 集时链接被移除，不留悬空指向已回收的载荷目录。上一版只验证了「载荷能装、工具能答」，没验证「装了载荷之后宿主能不能启动」——现在假宿主与真宿主一样校验那个资源根，两条回归测试覆盖这次的形状，把修复改回旧写法会立刻变红

### English
- Fixed the application refusing to start at all once the office component (the payload carrying the Python
  set) was installed: the host spends ONE argument on two jobs — the office skills' asset root is
  `dirname(argv[4])/office-skills`, while `load_workspace_dependencies` installs the tree `argv[4]` names.
  The previous release pointed that argument into the payload's own `primary-runtime` so the tool could find
  the Python set, which moved the asset root to `<payload>/office-skills` — a directory no artifact carries —
  and the office skill plugin's boot check on `scripts/check_office.py` threw (`ENOENT … check_office.py`),
  surfacing as a failure card whose only detail was a path. The argument is now ALWAYS the fixed leaf under
  the shell's data directory (`<dataDir>/dsh-app-office/primary-runtime`) and the payload's Python set is
  LINKED there (a junction on Windows, so nothing is copied): the asset root stays
  `<dataDir>/dsh-app-office/office-skills` (where the shell already materializes it) and the tool reads its
  `runtime.json` through that same leaf. The link follows a new payload version and is removed when a kernel
  declares no Python set, so nothing dangles into a pruned payload directory. The previous release verified
  that the payload installs and the tool answers, but never that the host still BOOTS with one — the fake
  host now enforces the same asset-root check the real one does, and two regression tests cover the shape
  that broke; reverting the fix turns both red

## [v0.12.5] - 2026-09-19

### 中文
- 修复「插件改动根本没送达用户」：suite 版本号是十七个插件**版本号**的哈希，而它决定内核目录名（`dsh-<内核版本>+suite-<哈希>`），外壳按目录名安装内核——于是插件代码改了但版本号没动时，哈希不变、目录名不变，已安装的用户永远保留旧插件，而本地每一道门禁都是绿的。实测：`office_to_pdf` 发布后用户测试时跑的仍是旧插件（会话里完全没有该工具），市面上另有插件市场的 SVG 转圈、会话记忆与预设包的安全删除、以及 fff 的构建脚本三处修复同样压在这里面。现在这五个插件的版本号已各自提升（market 0.1.5、memory 0.8.4、pdf 0.1.7、presets 0.1.4、fff 0.1.1），suite 哈希随之变化，内核会被重新安装、改动真正送达；并新增一条测试：自上一个发布标签以来任何插件改了代码却没提升版本号就报错
- 发布链路三处修复：①运行时复用判定只看 suite 版本，载荷换了内容也会被「复用」而跳过整个 runtime 矩阵（本次就是这样漏掉新载荷的）——现在逐格比对载荷声明的 Python 集；②Windows 构建机上没有 `unzip`、PowerShell 又拒绝解压没有 `.zip` 后缀的文件（下载缓存按摘要命名），两个 windows 格因此直接失败——改为用 .NET 的 ZipFile 解压；③重建后的分层产物名字带内容摘要，`--clobber` 清不掉旧名字，残留会让镜像守卫判定「有资产不被任何索引引用」而拒绝整份运行时——现在每个格会清掉自己平台上不再被索引引用的分片

### English
- Fixed plugin changes never reaching users at all: the suite version is a hash of the seventeen plugins'
  VERSION numbers, and it names the kernel directory (`dsh-<kernel>+suite-<hash>`) the shell installs by —
  so a plugin whose code changed without a version bump leaves the hash (and the directory name) alone,
  the existing installation is never replaced, and every local gate stays green. Measured: after
  `office_to_pdf` shipped, a user's test still ran the OLD plugin (the session contains no trace of the
  tool), and three more fixes sat in the same blind spot — the market's SVG busy ring, the memory and
  preset packages' link-safe deletes, and plugin-fff's build script. The five plugins now carry bumped
  versions (market 0.1.5, memory 0.8.4, pdf 0.1.7, presets 0.1.4, fff 0.1.1), so the hash changes, the
  kernel is reinstalled and the changes actually arrive; a new test fails whenever a plugin's code
  changed since the last release tag without a version bump
- Three release-pipeline fixes: (1) the runtime reuse rule compared only the suite version, so a payload
  whose contents changed was "reused" and the whole runtime matrix was skipped — which is how this
  release's first attempt shipped the old payload; it now compares each cell's declared Python set,
  (2) Windows runners have no `unzip` and their PowerShell refuses an archive whose path lacks the
  `.zip` extension (the download cache names files by digest), which failed both windows cells — zips
  now expand through .NET's ZipFile, (3) rebuilt layer assets carry new content-digested names that
  `--clobber` cannot remove, and the leftovers made the mirror's completeness guard refuse the entire
  runtime — each cell now prunes its own platform's unreferenced layer assets

## [v0.12.4] - 2026-09-19

### 中文
- 办公组件的载荷补上「primary runtime」这一半（独立 Python 3.12.14 + Node 24.21.0 + pnpm 11.7.0，含 numpy/pandas/python-docx/python-pptx/openpyxl/Pillow/lxml/XlsxWriter 共 13 个发行包）与 LibreOffice 引擎同装同卸：此前该产物只有引擎，宿主自带的 `load_workspace_dependencies` 工具每次调用都在 `…/dsh-app-office/primary-runtime/runtime.json` 上报 ENOENT——模型因此拿不到这套离线依赖，只能去翻用户机器上的 Python。现在每个非 Linux 格由 `scripts/build-primary-runtime.mjs` 按摘要锁定的输入（`scripts/primary-runtime-lock.json`）产出这套运行时并打进载荷，`scripts/smoke-primary-runtime.mjs` 用宿主自己的 `primary-runtime.ts` 验证（安装、五条路径、解释器导入、Node/pnpm 版本、以及该工具真的答得上）。代价是载荷产物从 118.5 MB 涨到 210.9 MB——只有下载办公组件的用户付一次，内核产物本身仍是 80.8 MB 不变；Linux 格不产这套（宿主 `readPrimaryRuntime` 只接受 win32/darwin 清单，Linux 上该工具按上游设计不可用）。载荷校验同时收紧：manifest 声明了 Python 集就必须真的带 `primary-runtime/runtime.json`，否则整份产物在安装时被拒绝——否则又是「装上了但工具照样报错」的静默缺口
- 修复「当前内核未声明办公组件」（开发运行用本地 checkout、旧内核）时 `office_to_pdf` 的错误文案：这类内核根本没有可下载的引擎，之前它却把用户指向「设置 → 诊断 → 办公组件」的下载按钮（那里只会回「无需下载」）；现在按内核是否真的声明了办公组件分成两句，各自指向可行的下一步
- 新增 `office_to_pdf` 工具：把工作区里已有的 Office 文档（.doc/.docx/.xls/.xlsx/.ppt/.pptx）**原样转成 PDF**，走本应用自带的 LibreOffice 引擎（该引擎的按需下载与预览共用），用户机器上不需要装 Office 或 WPS。此前模型要完成这类请求只能自己去翻本机能力——实测它先用 PowerShell 找系统 LibreOffice（没装），再退回 WPS 的 COM 自动化（`Presentations.SaveAs`），结果依赖用户装了什么软件、可能弹出窗口、换台机器复现不出来；现在工具是确定的，页数/页面尺寸/配色/图表保留、文字可选，并如实回报 `missingFonts`（文档声明但本机没有的字体族）。转换失败按引擎原因给可操作中文：引擎未安装时直接指向「设置 → 诊断 → 办公组件」的下载；源文件与输出路径沿用既有工具的工作区纪律（越界、扩展名不符、源文件不存在都在写盘前拒绝），写盘走临时文件 + 重命名
- 修复下载类提示条（内核分层下载、更新下载）里的转圈图标画成了**圆角方块**：宿主的设计系统在 `body` 上设了 `corner-shape: superellipse(1.5)`，于是所有 `border-radius:50%` 都被画成超椭圆——宿主自己的 spinner 都各自显式写 `corner-shape:round` 抵消，我们注入的这份漏了。现在 spinner 与成功/失败徽章都显式声明 `corner-shape:round`（同一处公共样式，两个形状一起修正），并加了断言锁死；顺手修好了同一个探针里早就红着的一条内核更新卡按钮断言（它在读早已改成设计令牌的颜色）

### English
- The office payload now carries the "primary runtime" half (independent Python 3.12.14, Node
  24.21.0 and pnpm 11.7.0 with 13 locked distributions — numpy, pandas, python-docx, python-pptx,
  openpyxl, Pillow, lxml, XlsxWriter) alongside the LibreOffice engine: until now that artifact held
  the engine only, so the host's own `load_workspace_dependencies` tool failed every call with ENOENT
  on `…/dsh-app-office/primary-runtime/runtime.json` — the model could not reach the offline
  dependencies and went hunting for the machine's Python instead. Every non-Linux cell now builds that
  runtime from digest-pinned inputs (`scripts/primary-runtime-lock.json`) via
  `scripts/build-primary-runtime.mjs`, and `scripts/smoke-primary-runtime.mjs` proves a staged tree
  against the host's own `primary-runtime.ts` (install, all five paths, interpreter imports, Node and
  pnpm versions, and the tool actually answering). It takes the payload artifact from 118.5 MB to
  210.9 MB — paid once, only by users who download the office component; the kernel artifact itself
  stays at 80.8 MB. Linux cells ship no such set: the host's `readPrimaryRuntime` accepts only
  win32/darwin manifests, so that tool is unavailable there by upstream design. The payload check is
  tightened with it: a manifest that declares a Python set must actually carry
  `primary-runtime/runtime.json`, or the whole artifact is refused at install — otherwise the same
  silent gap comes back wearing a green install
- Fixed `office_to_pdf`'s error wording on a kernel that declares no office component (development
  runs boot the local checkout, older kernels declare nothing): there is no engine to download at all,
  yet the message sent the user to the 设置 → 诊断 → 办公组件 download button, which answers "nothing to
  download". It now splits into two sentences whose next step is real in each case

- Added the `office_to_pdf` tool: converts an Office document already in the workspace
  (.doc/.docx/.xls/.xlsx/.ppt/.pptx) to PDF as-is through the application's own LibreOffice engine
  (the same on-demand download the preview uses), so the user's machine needs no Office or WPS. Until
  now the model had to improvise: measured, it first looked for a system LibreOffice (absent), then fell
  back to WPS through COM automation (`Presentations.SaveAs`) — a result that depends on what the user
  happens to have installed, can raise windows, and is not reproducible on another machine. The tool is
  deterministic, keeps page count, page size, colours and charts with selectable text, and reports
  `missingFonts` (families the document declares that this machine cannot supply). Failures are worded
  per engine reason: a missing engine points straight at the 设置 → 诊断 → 办公组件 download. Source and
  output paths keep the existing tools' workspace discipline (escapes, wrong extensions and absent
  sources are all refused before anything is written), and the PDF lands through a temp file + rename
- Fixed the spinner in the download toasts (kernel layer download, update download) rendering as a
  ROUNDED SQUARE: the host's design system sets `corner-shape: superellipse(1.5)` on `body`, so every
  `border-radius:50%` paints as a superellipse — the host's own spinners each declare
  `corner-shape:round` to opt out and the card we inject had not. The spinner and the success/error
  badge (one shared style) now say so explicitly, with an assertion pinning it; the same probe's
  long-failing kernel-update-card button assertion (still reading a colour that had moved to design
  tokens) is fixed alongside

## [v0.12.3] - 2026-09-18

### 中文
- 修复 0.12.1 起所有桌面动作失效（打开日志目录、另存为、办公组件…都回「桌面功能拒绝了这次请求」）：0.1.6-alpha.2 那次新增的「客户端流握手认证」又注册了一个会话请求钩子，而 Electron **每个会话只保留最后一个 `onBeforeSendHeaders` 监听器**（在 44.4.1 上实测：被前一个过滤器命中的请求，两个钩子的头都没写），于是它把整套桌面动作的盖章钩子顶掉了；现在两类钩子合成**一个**监听器、按 URL 分派（`installSessionHeaderRules`），并补了测试锁死「只能有一个监听器」这一性质

### English
- Fixed every desktop action failing since 0.12.1 (open-logs, save-as, the office row all answered
  "desktop refused this request"): the stream-handshake auth added with 0.1.6-alpha.2 registered a
  SECOND session request hook, and Electron keeps only the LAST `onBeforeSendHeaders` listener per
  session (measured on 44.4.1: a request matched by the first filter arrived with neither hook's
  headers) — so it silently disabled the stamp hook every desktop action depends on. Both jobs are
  now rules behind one install (`installSessionHeaderRules`), with a test pinning that property

## [v0.12.2] - 2026-09-18

### 中文
- 修复跨内核线切换仍可能删掉自己装的插件：上一次的修复只在 profile 自己的 lockfile 读得到时才对（lockfile 被重写或读不到就会误删），而标记本身只是「当时打算拥有什么」的记录，不是证据；现在移除任何一个名字之前都先要**被当初镜像的那棵运行时树见证**——名字必须真的在那棵树的 `node_modules` 里，标记记录的那棵树已经不在时一律不动，两种情况都记一行 `[suite-profile] left <name> in the profile: …`。宁可留下残留：残留的内核包只在「标记已证明确实镜像过」这一种情况下遮蔽当前线的同名包，而被删掉的用户包谁都恢复不了
- 新增启动前的 profile 自愈：profile 清单里声明了依赖但依赖没装上时，宿主会直接拒绝启动（`cannot resolve profile bundle "@deepseek-ai/dsh-toolkit"`），而失败卡片提供的动作（回退、重试）都会再次启动同一个 profile——手动 `pnpm install` 也不管用，实测它会回一句「Already up to date」而包还是缺的（pnpm 自己的状态文件与 lockfile 一致，只有删掉 `node_modules` 重装才行）。现在启动前会读 profile 清单里的 `dependencies`，发现缺失就用**内核 CLI**（与插件市场同一条调用路径：`node <dsh bin.js> plugin --profile <p> install --config.minimumReleaseAge=0`，cwd 为 profile）跑一次修复，并复用内核 CLI 的解析结果（`DSH_APP_DSH_BIN`）而不是另找一套；运行的 `DSH_HOME` 显式钉在该 profile 所属的 home 上（CLI 是按 `$DSH_HOME/profiles/<name>` 解析 `--profile` 的，不是按 cwd，继承来的 home 会把修复指向另一个 profile 并回一句「Already up to date」）；运行有 180 秒上限、输出经脱敏后才进日志、失败只记一行、不阻断启动——宿主仍照旧报自己的原因。退出码为 0 也不算成功，装完会再读一次树；全部依赖都在时这一步不发任何进程、也不记日志

### English
- Fixed the cross-line switch still being able to delete the market's packages: the previous fix only held while the profile's own lockfile could be read (a rewritten or unreadable one meant a blind delete), and the marker is a record of what a mirror INTENDED to own, not evidence. A name may now only be removed when the runtime tree the marker recorded WITNESSES the mirror having written it — the name has to be in that tree's own `node_modules`, and a marker whose tree is gone removes nothing — with a `[suite-profile] left <name> in the profile: …` line for each name either way. Residue is the deliberate direction of the error: a leftover kernel package shadows this line's copy only in the case the marker already proves a mirror happened, while a deleted user package cannot be recovered
- Added a repair step in front of every host start: a profile whose manifest declares a dependency that is not installed makes the host refuse to boot (`cannot resolve profile bundle "@deepseek-ai/dsh-toolkit"`), and the failure card's actions (rollback, retry) all boot the same profile again — while a hand-run `pnpm install` did not help either (measured: it answered "Already up to date" with the packages still missing, because pnpm's own state files agreed with the lockfile). The step reads the profile's `dependencies` and, when any is missing, restores them through the KERNEL CLI — the same invocation the in-app market installs through (`node <dsh bin.js> plugin --profile <p> install --config.minimumReleaseAge=0`, cwd = the profile), reusing the kernel CLI's resolution (`DSH_APP_DSH_BIN`) rather than inventing another. `DSH_HOME` is pinned explicitly to the home that profile lives under: the CLI resolves `--profile` as `$DSH_HOME/profiles/<name>` and not from its cwd, so an inherited home would aim the repair at a different profile and report "Already up to date" about that one. Bounded at 180 seconds, output redacted before it reaches the log, and a failure only logged: the host start still reports its own reason, exactly as before. A zero exit is not taken as proof — the tree is read again afterwards. When every declared dependency is installed the step spawns nothing and logs nothing

## [v0.12.1] - 2026-09-18

### 中文
- 办公文档转换引擎不再打进内核运行时，改为按需下载一份：运行时只是「内核 + 套件」，LibreOffice 引擎（`@deepseek-ai/libreoffice-kit` 加它按平台发布的 `…-kit-<platform>-<arch>` 引擎包，解包 334.5 MB）改由第二个产物 `office-payload-<platform>-<arch>-<dshVersion>.tgz` 携带，与运行时产物同一次发布、同一套解析规则（官方 host 优先、mirrors 只做传输、sha512 校验）。win32-x64 运行时因此从 197.2 MiB 降到 80.8 MiB（解包 568.3 → 243.2 MiB，文件数 13,888 → 11,833），payload 产物 118.5 MiB；内核更新不再重复搬运这 100 多 MiB，而真正需要转换文档的用户只下载一次。运行时的 `app/node_modules/@deepseek-ai/libreoffice-kit` 位置改放一个几百字节的加载垫片（`scripts/runtime-stubs/libreoffice-kit`）：办公转换插件是**模块顶层静态 import** 这个包名，直接删包会让它整个加载失败（表现为插件树激活失败，而不是「引擎没装」），垫片在调用时才从已安装的载荷目录（内核子进程启动时注入的 `DSH_APP_OFFICE_PAYLOAD`）加载真正的 kit，未安装时以 `unavailable` 类别抛出可操作的中文提示（指向「设置 → 诊断 → 办公组件」的下载按钮）；载荷可在内核运行期间安装，装完立刻生效、无需重启
- 「诊断」设置页新增「办公组件」一行：显示当前内核需要的载荷版本、是否已安装、下载进度（边下边显示百分比）、失败原因与重试/取消按钮。安装落在 `<userData>/dsh-app-office/payload/<payloadVersion>/`，只在「显示已安装」与「重新下载」之间做出区分，校验通过后一次性 rename 生效，失败绝不动上一份可用安装；旧的载荷版本在新版本验证通过后回收。目录名用的是载荷**内容版本**（kit 版本，携带 Python 集时再加 Python 版本），不是内核版本——这正是内核更新或回滚不必重新下载的原因；而发布资产名带内核版本，因为运行时发布的每一项资产都按内核版本寻址（镜像侧的完整性检查也这么读）。载荷不随启动自动下载，也不改 profile 或运行时树
- 六格运行时产物现在各自多带一份 payload 产物（tgz + `.sha512` + 平台后缀的 `office-payload-<cell>.json`），发布流程的完整性检查把它列为必需项：缺了它该平台就没有任何可用的办公转换引擎，而运行时装好之后一切正常，不会有别的地方报红。payload 由构建用独立的 pnpm 工程安装依赖闭包，并用 `supportedArchitectures` 指明目标平台，因此交叉目标那一格（windows x64 跑者构建 win32-arm64）拿到的是**它自己的**引擎，而不是构建机自己的；目标引擎缺失直接让该格构建失败，不发布空载荷
- 内核通道不再写死 `stable`，首启安装也不再只顾随包内核：通道默认取本构建里那颗内核自己的 `channel`（打包版读 `resources/kernel/manifest.json`，仓库与开发运行读 `bundled-kernel/manifest.json`），`DSH_APP_CHANNEL` 仍然覆盖；首启安装与更新提示按 semver 在「通道当前解析到的版本」与「随包内核版本」之间取新者——随包的那颗更新就直接装包内的（不下载），通道的更新就走原有下载流程，解析到的版本还没发布运行时产物时回落到随包内核，更新提示也会把「比通道更新」的随包内核列成可安装项。此前两者分歧时会为了更旧的版本下载，而包里更新的那颗被跳过；通道的新版本产物未发布时，更新提示也只回一句「安装包尚未发布」
- 运行时产物只带目标平台用得上的 payload：上游桌面端打包用的那套排除规则被移进构建（`selectOfficeEngine` 按 kit 自己的声明选引擎 + 逐文件排除），win32-x64 产物因此少 12,716 个文件（解包 106.6 MB）：源码映射 41.1 MB、类型声明 37.9 MB、其它平台的 node-pty prebuild 与调试符号 21.7 MB、domino 测试夹具 5.8 MB、构建缓存与包管理器元数据等；产物从 216.1 MiB 降到 197.2 MiB（解包 674.8 → 568.3 MiB），逐文件清单按实际发布的树生成。目标平台自己的 LibreOffice 引擎照旧保留——本机办公转换要用它，别的平台的引擎本来也不会装到这台机器上
- 支持上游 0.1.6-alpha.2 起的宿主契约：那条线不再经由父子进程之间的字节管道提供界面与接口，改为自己监听回环端口并回报一个带一次性令牌的地址，外壳先把这个令牌换成 cookie，再用它转发窗口的全部请求（令牌只用于换 cookie，不落日志）；那条线的客户端还会**自己开一条 WebSocket 直连宿主**拉流，所以外壳另外把传输地址作为一条 index 注入写进文档、并在会话层为 `ws://127.0.0.1/*` 的握手补上宿主 cookie 与它接受的 origin（非本窗口、非本应用的握手直接取消）。旧线（0.1.5-rc.2、0.1.6-alpha.1）的管道传输一个字节没动，开发模式直接跑上游 master 检出因此重新可启动；代价是这条线会打开一个本机端口（旧线「不监听任何端口」的性质不适用于它），且宿主要求的 office 载荷由构建侧写进运行时：取自打包宿主的同一检出，落在 `<内核目录>/runtime/office-skills`，随内容寻址的 meta 层发布（开发模式仍旧取检出里的资源）
- 修复跨内核线切换会删掉自己装的插件：运行时镜像的回收按顶层目录名执行，而 `@deepseek-ai` 是内核与插件市场共用的 scope，市场装的 `@deepseek-ai/dsh-toolkit` 跟着内核包一起被删，profile 清单里仍声明着它，宿主随即拒绝启动；现在所有权记到包一级，scope 目录要等最后一个包离开才移除，旧版标记里的 scope 名按「当初镜像的那棵树」收窄
- 修复旧线残留的内核包遮蔽当前线的包：收窄若按「当前运行的树」取名单，上一线多出来的包会留在 profile 里，宿主会从 profile 组合出旧线的 `dsh-typert-loader`，终端相关插件因此激活失败；现在按标记记录的镜像来源收窄，残留一并清掉
- 修复两条内核线共用一个窗口时，后一条线跑完会让前一条线的会话列表整块空掉：界面把视图状态存在窗口存储里，0.1.6 线删掉的字段 rc 线仍在读，`Object.entries(undefined)` 让左侧会话列表崩溃（会话本身都还在磁盘上）；窗口现在记住写下状态的线，切到另一条线时重置窗口存储，代价只是视图状态
- 修复 0.12.0 起的市场装卸失败：pnpm 11 的发布冷静期会在每条命令前先校验 lockfile，清单里钉着 24 小时内发布的版本时，装和卸都会被拦下；上一版写的「把被拒版本写进白名单」实测清不掉这道校验（pnpm 11.7.0），现在改成运行那一次临时放开策略（`--config.minimumReleaseAge=0`）后重试一次，profile 与其余运行照旧受冷静期保护
- 插件市场的忙碌指示圈改回与文字同高，并改用 SVG 弧绘制（描边更细、缺口更小）：此前用 16px 的边框圆环，在这个尺寸下看着像缺了一块的「C」，也把按钮行撑高了
- 修复新内核下应用起不来（`duplicate loader entry id`）：品牌层每次启动会把 home 层（你自己写的 MCP / 搜索等行）抄进 profile 的 patch 文件，而 0.1.6 线内核自身的组合器**也会把 home 层当一层加载**，同一行于是出现两次、判定重复，整棵插件树拒绝加载（表现为启动失败并回退）。现在在这条线上不再抄写 home 行，profile 的 patch 里只留一段说明；rc 线与开发模式保持原样（那里宿主只读这一个文件）
- 内核线更新到上游 0.1.6-alpha.2：随包运行时改由该线组装，并把新宿主启动时必需的 office 载荷（`runtime/office-skills`，含 `scripts/check_office.py`）一并打进运行时产物——此前只有开发模式有它，正式运行时会在宿主的启动检查处失败

### English
- The office conversion engine is no longer shipped inside the kernel runtime: it is downloaded on demand instead. The runtime carries the kernel and the suite, while the LibreOffice engine (`@deepseek-ai/libreoffice-kit` plus the per-platform `…-kit-<platform>-<arch>` package, 334.5 MB unpacked) travels in a second artifact, `office-payload-<platform>-<arch>-<dshVersion>.tgz`, published with the same release and resolved through the same rules (official host first, mirrors as transport only, sha512 verified). The win32-x64 runtime drops from 197.2 MiB to 80.8 MiB (unpacked 568.3 → 243.2 MiB, 13,888 → 11,833 files) and the payload artifact is 118.5 MiB — kernel updates no longer move that 100+ MiB, and a user who does convert documents downloads it once. The specifier `app/node_modules/@deepseek-ai/libreoffice-kit` now holds a few-hundred-byte loader shim (`scripts/runtime-stubs/libreoffice-kit`): the conversion provider imports that name STATICALLY at module scope, so simply removing the package makes it fail to LOAD (which reads as a plugin-tree fault, not as a missing engine). The shim loads the real kit out of the installed payload (`DSH_APP_OFFICE_PAYLOAD`, injected into the kernel child at spawn) at call time, and rejects with the kit's own `unavailable` category plus an actionable Chinese sentence pointing at the Settings → 诊断 → 办公组件 download button while the payload is absent. A payload installed while the kernel runs takes effect immediately — no restart
- The 诊断 settings page gained an "Office components" row: it shows the payload version this kernel needs, whether it is installed, live download progress, the classified failure reason, and retry/cancel buttons. The install lands in `<userData>/dsh-app-office/payload/<payloadVersion>/`, becomes visible only through one atomic rename after the sha512 and the inner manifest were verified, never touches a working install when it fails, and the previous version is reclaimed once the new one verifies. The directory is named for the payload's CONTENT version (kit version, plus the Python version when a Python set is carried) rather than the kernel version — that is what makes a kernel update or a rollback reuse what is already on disk — while the release ASSET name carries the dsh version, because every asset of a runtime release is version-addressed (the mirror's completeness check reads it that way). Nothing downloads automatically
- Each of the six runtime cells now publishes its own payload artifact (the tgz, its `.sha512`, and a platform-suffixed `office-payload-<cell>.json`), and the release completeness check requires all three: without them that platform has no engine at all, while the runtime itself installs and boots perfectly, so nothing else would turn red. The payload's dependency closure comes from its own pnpm project, with `supportedArchitectures` naming the target, so a cross-target cell (win32-arm64 built on a windows x64 runner) gets ITS engine instead of the build host's; a payload without the target's engine fails that cell rather than shipping an empty one
- The kernel line is no longer hardcoded to `stable`, and a first run no longer installs whatever bundle it happens to ship: the channel defaults to the bundled kernel's own `channel` (`resources/kernel/manifest.json` when packaged, the repo's `bundled-kernel/manifest.json` in a repo or dev run) with `DSH_APP_CHANNEL` still overriding it, and both the first-run install and the update offer now take the NEWER of the channel-resolved version and the bundled version — a newer bundle installs from disk with no download, a newer channel version keeps the existing download flow, and a resolved version whose runtime artifact is not published yet falls back to the bundle instead of stopping at "artifact pending". Until now the two could disagree and the shell downloaded an older kernel while a newer one sat in its own resources, and an unpublished artifact left the update prompt with nothing to offer
- The runtime artifact now carries only the payload its target platform can use: the exclusion rules upstream's desktop packaging applies are ported into the build (`selectOfficeEngine`, driven by the kit's own declaration, plus the per-file rules), which takes 12,716 files (106.6 MB unpacked) out of the win32-x64 artifact — source maps 41.1 MB, type declarations 37.9 MB, other platforms' node-pty prebuilds and debug symbols 21.7 MB, domino test fixtures 5.8 MB, build caches and package-manager metadata — shrinking it from 216.1 MiB to 197.2 MiB (674.8 → 568.3 MiB unpacked), with the per-file inventory generated from the tree that actually ships. The target's own LibreOffice engine stays: that is the one office conversion loads on that platform, while the other platforms' engines are not installed on this machine to begin with
- Support for the host contract of upstream 0.1.6-alpha.2 and later: that line no longer exports the UI and the API routes over the child's byte pipes — it binds its own loopback port and reports a URL carrying a one-shot token, which the shell trades for a cookie and then uses to forward every request the window makes (the token is used for that exchange only and never logged). That line's client also opens its OWN WebSocket stream straight to the child, so the shell writes the transport address into the boot document as an index row and, at the session, attaches the child's cookie and an accepted `origin` to every `ws://127.0.0.1/*` handshake from the main window (any other handshake is cancelled). The older lines (`0.1.5-rc.2`, `0.1.6-alpha.1`) keep their pipe transport byte for byte, so the dev checkout can run upstream master again; the price is that this line opens a local port — the old line's "no port is bound" property does not apply to it — and the office payload that line asks for is now staged into the runtime by the build — read from the same checkout the host is packed from, laid down at `<kernelDir>/runtime/office-skills` and carried by the content-addressed meta layer (dev reads the checkout's own assets)
- Fixed the cross-line switch deleting the market's own packages: the runtime mirror was reclaimed by top-level directory name, and `@deepseek-ai` is shared between the kernel and the in-app market — so `@deepseek-ai/dsh-toolkit`, still declared as a bundle in the profile manifest, was deleted along with the kernel packages and the host refused to boot. Ownership is now recorded per package, a scope directory goes away only with its last package, and a bare scope in an older marker is narrowed against the tree it mirrored
- Fixed a previous line's leftover kernel packages shadowing this line's: narrowing against the tree running NOW keeps every package the old line had and this one does not, so the host composed the old line's `dsh-typert-loader` out of the profile and the terminal plugins failed to activate. The narrowing now follows the runtime recorded in the marker, leftovers included
- Fixed the release build's session list going blank after the other kernel line had run: the UI persists its view state in the window's own storage, and a field the 0.1.6 line drops is one the rc line still reads with `Object.entries` — the left session list crashed with every session still on disk. The window now remembers which line wrote the state and resets that storage when the line changes; the cost is the window's view state and nothing else
- Fixed installs and uninstalls failing in the market since 0.12.0: pnpm 11's release-age cooldown checks the lockfile before EVERY command, so a profile pinning a version published inside 24 hours is blocked for both. Recording the rejected versions in the exclusion list (what 0.12.0 did) does not clear that check — measured on pnpm 11.7.0 — so the command now runs once more with the policy lifted for that run (`--config.minimumReleaseAge=0`), leaving the profile and every other run under the cooldown
- The market's busy ring is back to the label's own size (12 px) and drawn as an SVG arc with round caps instead of a bordered box: the 16 px border ring read as a letter "C" and made the button line taller
- Fixed the app failing to start on the new kernel (`duplicate loader entry id`): the brand seam copies the home layer
  (the MCP / search rows you write yourself) into the profile's patch file on every start, and the 0.1.6 kernel's own
  composer loads that home layer as a layer TOO — the same row then reaches the loader twice and the whole plugin
  tree is refused (the boot fails and rolls back). The patch no longer repeats those rows on this line; the frames
  line and a dev checkout keep the copy, whose host reads only that file
- Kernel line moved to upstream 0.1.6-alpha.2: the bundled runtime is assembled from that line, and the office payload
  the new host requires at boot (`runtime/office-skills`, `scripts/check_office.py` included) now ships inside the
  runtime artifact — until now only a dev checkout had it, and a released runtime failed the host's own start check

## [v0.12.0] - 2026-09-17

### 中文
- 界面改由内核自带的 desktop host 提供：窗口不再从本机 HTTP 端口加载，页面与接口都走父子进程之间的字节管道，应用从此不监听任何端口——本机上任何进程都再也连不上这个界面；启动、崩溃恢复与内核切换的路径一并改到这条通道，启动失败提示里的「端口被占用」也随之消失
- 两条内核线都能启动：宿主包版本不同，子进程的启动参数形状不同，profile 的处理也不同——rc 线把运行树镜像成 profile 里的「已安装树」（首次启动会多花十几秒，之后按标记跳过，中断过的镜像下次自动重做），alpha 线保持原样
- 桌面能力改由界面直接调主进程：打开日志目录 / 通知 / 另存为 走应用自己 origin 上的一个 POST 动作端点（每个请求由主进程盖章，只有主 frame 能通过），旧的「回环 HTTP + token」本地小服务整个退休；诊断页的「桌面功能」恢复可用
- 17 个套件插件全部迁到新传输：宿主端路由改挂在 `/api/plugins/dsh-app/<插件名>/…`（只收 GET/HEAD/POST），客户端只换前缀，页面行为不变；每个插件补了 patch 版本号，套件版本随之变动
- 修复诊断页所有读取失败：页面跑的还是迁移前的旧客户端包，桌面功能、日志目录、日志尾与诊断包导出全都读不出来；换成新的客户端包后四项都正常
- 修复开着代理时抓取与搜索报「非公网地址」：改为直接启动宿主后，内核的代理策略不再有人装载，TUN/fake-IP 环境下被解析成 198.18.x.x 的域名一律被当成非公网地址拒绝；现在子进程的环境里带代理时就先把策略装上（装不上只影响代理，启动照旧）
- 修复市场卸载插件撞上发布冷静期而失败：pnpm 11 默认对 24 小时内发布的版本不放行，而卸载这条路径没有 pnpm 自带的宽限处理，清单里钉了新版本的插件就卸不掉；现在把被拒的版本写进 profile 的白名单后重试一次，其余包仍受冷静期保护
- 修复市场装/卸报「未能定位内核命令行工具」：市场要靠内核 CLI 装删插件，而它按自身位置和进程入口去猜，在工作区开发时（插件在应用仓库、CLI 在另一个检出）猜不到；现在外壳把当前内核 CLI 的绝对路径直接交给它
- 修复启动卡在 Failed to load plugins：上游实验包 Agent Teams 的客户端半在它自己的版本里激活不了，而一个客户端插件失败会让整页被判废（不是警告），窗口除了这句错误什么都到不了；这个 loader 行现在被显式禁用，等上游重发后按注释恢复（删掉该行，或在 `$DSH_HOME/cordis.patch.yml` 里写 `disabled: false`）
- 已知限制：打开日志目录 / 通知 / 另存为 只在应用界面里可用——宿主的 HTTP 客户端是一个 Node 子进程，解析不了 `dsh-app://` 这个协议，命令行里调不到这三个动作
- 套件改用自有 profile：内核改为以 `--profile dsh-app` 启动，你在终端里的 `dsh` / `dsh web` 继续用 `web`，两边的插件世界互不干扰。首次运行后台建好新 profile 并把你手写的 patch 层（禁用行、MCP 行）带过去；第三方插件不搬，改在应用内的插件市场里重装——市场里会直接出现「旧 profile 还有 N 个插件未安装 / 全部安装」的入口，一键按原规格装到当前 profile（npm 区间、本地 tarball、GitHub、https 包都支持）。旧 profile 一个字节不动，随时可回去。会话、设置、凭据、workspace 与插件 storages 都与 profile 无关，不受影响；生效的 profile 通过 `DSH_APP_PROFILE` 传给内核，市场与预设总是装到应用真正读取的那个
- 首启不再像卡死：新增本地启动页（品牌标 + 版本号 + 五步进度 + 下载可暂停/继续 + 失败卡三动作「重试 / 打开日志目录 / 退出」，失败文案按原因分层：摘要不符只建议更换网络，不给「稍后重试」这种错建议）。窗口用与主界面一致的自定义边框，深/浅色跟随界面「外观」设置，底部一句话：首先您要健康，其次才是其次
- 内核更新改为分层下载：运行时拆成 node / vendor / dsh / suite 等层并逐层校验与缓存，dsh 升级只需下载变化的那几层（约 10 MB，而不是 100 MB 以上）；层缓存未命中或任何一层失败会自动回退到整包，装不上这种情况不会发生
- 内核运行时改用 pnpm 组装：依赖树不再由 npm 的扁平化决定，构建可复现（锁定 overrides、关闭 pnpm 的发布冷静期），并产出逐文件清单
- 桌面能力：启动文件夹直达：把文件夹拖到应用图标（或 `dsh-app.exe D:\某个项目`）即把该文件夹开成工作区并开会话；应用已在运行时第二次启动只聚焦现有窗口、复用空白会话，不会开第二个窗口
- 设置页新增「诊断」：桌面功能状态、内核日志尾部、一键打开日志目录，以及导出纯文本诊断包（不含密钥与会话内容，且按界面语言生成）
- 界面语言全量中英双语：外壳（启动页、托盘、对话框、更新提示）与全部套件插件页跟随系统语言，也可用 `DSH_APP_LOCALE` 强制；网络搜索等页面的英文界面不再残留中文（宿主只回状态码，文案由界面渲染）
- 设置导航更好用：列表可在小窗口滚动（此前最后四项够不着）、顺序按语义分带（模型 → 集成 → 生态 → 子代理 → 系统 → 会话数据）、「诊断」有了专属图标，不再是通用齿轮
- 深色主题两处可读性缺陷：关闭弹窗与更新提示卡的主按钮此前是白字白底（深色下看不见），改用与主界面一致的成对颜色令牌
- 工程护栏：新增打包产物冒烟（asar 关键条目 / 静态资源 / 内置内核三件套）、插件依赖图静态校验，CI 覆盖全部插件测试套件
- Windows 应用更新维持原样：差分下载实测只省约 44%，换取的是每台机器常驻一个完整安装包与更复杂的下载链，权衡后放弃
- 文档：README 中英各加「下载与安装」章节（Windows SmartScreen / macOS Sequoia「仍要打开」一步到位），并补齐内核分层、诊断页、启动页的说明
- 并行子代理：设置页左侧导航从通用齿轮图标换为「一拖三」调度节点的专属图标（沿用网络搜索、会话记忆等插件的导航图标约定），不影响设置项本身
- 会话记忆重构为「按主题的记忆」：存储从每个作用域一个按日期追加的条目文件，改为一个主题一个纯文本 .md 文件加自动维护的索引；同一主题再次记录会覆盖更新而不是越攒越多，纠正旧记忆一步到位（原来要「先遗忘再保存」两步）。旧记忆启动时自动迁移，原文件保留为 memory.legacy.md 归档，固定的条目跨迁移保留。新写入带重复防护：换个名字重述同一件事会被拦下并指到已有记忆；每次写入后做一次零成本整理（精确重复合并、可疑重叠记录留档），后台策展改为按主题合并/删除/重写，超过 30 个主题或 16KB 时收到带具体数字的强制瘦身指令。设置页改为按主题列出记忆、可展开正文、按名称固定或删除，分类标签中文化
- 会话记忆接口变化（仅影响自己写自动化调用的人）：memory_save 新增必填的主题名与索引摘要参数，memory_recall 支持按主题名精确读取单条，memory_forget 优先按主题名删除
- 网络搜索：默认引擎顺序改为 **AnySearch → Bing → Parallel → Exa → SearXNG**，依据是 4 个可用引擎在 5 类查询上的完整实测（延迟与命中质量都测）。中文长查询下 Bing 会退化成百度百科/知乎旅游攻略这类泛化结果，而 AnySearch、Exa、Parallel 都能命中 weather.com.cn、nmc.cn 等权威源；Parallel 在同为托管端点的两者中速度（1958ms vs 3070ms）与命中率都优于 Exa，因此排在 Exa 之前。免费无密钥引擎仍排在计量端点之前，让计量额度只在免费引擎失败时才动用
- 代理看门狗：注入的代理中途消失时（例如关掉梯子），自动重启 dsh 服务并重新探测，改用直连模式继续工作，无需手动操作托盘菜单。只对本 shell 自己注入的代理生效，用户自己导出的代理变量不受干预
- 代理自适应：启动时自动探测本机代理端口（Clash/mihomo 等），只在确认有代理在监听时才注入代理变量。TUN/fake-IP 模式下 `web_fetch` 因此能正常工作（走代理分支跳过地址校验），而关掉代理时也不会因为指向已关闭的端口把搜索、抓取、直连全部拖挂
- 网络搜索：SearXNG 默认排到最后，未配置实例时不再进入尝试列表并显示「未配置实例」。实测公共实例已普遍关闭 JSON API（返回 HTML 或反爬页），预置清单或空跑只会浪费一次往返并污染回退说明——自建实例请在设置页填入地址
- 网络搜索：新增端到端自检（走真实 `ctx.web.search`），显示当前生效的搜索来源、实际引擎、缓存命中，以及回退链的真实说明
- 网络搜索：「搜索来源」改为两张状态卡，各自显示真实可用性（可用/不可用/未知）及不可用原因——内核未挂载上游 provider、或缺少 DeepSeek Key，都在切换前被告知，而不是切换后才失败
- 网络搜索管理（新插件 `plugin-websearch`）：把原先手写在 `~/.dsh/cordis.patch.yml` 里的 exa / parallel 两个 MCP 轮询配置收进「设置 → 网络搜索」页面，统一管理引擎顺序、启停、密钥与回退策略。底层不是新工具，而是注册一个 `ctx.web` 搜索 provider（`dsh-app`），因此模型看到的仍是内核自带的 `web_search`，schema、引用与结果渲染全部沿用上游。内置 5 个引擎（AnySearch、Bing、Parallel、Exa、SearXNG），首选失败或返回空结果时自动回退到下一个并在结果顶部注明实际生效的引擎；支持「固定顺序」与「轮询」两种策略
- 网络搜索管理：移除 DuckDuckGo 两个引擎（中国大陆需代理，且限流严重，等于给每次搜索加一个必然失败项），改以 AnySearch 补位——匿名 JSON API、无需密钥、结构化返回，实测中国大陆直连可用
- 网络搜索管理：引擎密钥支持字面值或 `$ENV:变量名` 引用，读取时一律脱敏为 `••••••`；配置存于 `$DSH_HOME/storages/dsh-app-plugin-websearch/config.json`，写入为原子替换
- 网络搜索管理：`- id: web` 覆盖行必须同时写 `searchProvider` 与 `fetchProvider`——patch 语义是整行替换 config，只写前者会导致 `web-fetch-http` 被重新注册，并使整棵插件树因重复条目而启动失败

### English
- The UI is served by the kernel's own desktop host: the window no longer loads from a local HTTP port — the page and its API travel as framed bytes over the two processes' pipes, so the app listens on nothing (no other process on the machine can reach this UI again). Boot, crash recovery and kernel switching all moved onto that channel, and "the port is already in use" is gone from the startup failure messages
- Both kernel lines boot: the child's argv shape follows the host package's version, and so does the profile anchor — the shipped rc line mirrors the runtime into the profile as an installed tree (its first boot spends a dozen-odd seconds on it, later boots skip it by marker, and an interrupted mirror is redone), while the alpha line keeps the seeded profile
- Desktop actions are the UI calling the main process directly: open the log directory / notify / save-as are POSTs to an action endpoint on the app's own origin (the shell stamps every request, and only the top frame passes), so the old loopback-plus-token local server retired entirely; the diagnostics page's 桌面功能 reads available again
- All 17 suite plugins moved onto the new transport: host routes register under `/api/plugins/dsh-app/<plugin>/...` (GET/HEAD/POST only) and the client halves only swap their prefix, so page behaviour is unchanged; every plugin took a patch bump, which moves the suite version with it
- Fixed the diagnostics page, where every read failed: the page was still running the pre-migration client bundle, so the desktop-feature status, the log directory, the log tail and the diagnostics export were all unreachable; with the new client bundle all four work
- Fixed "not a public address" from fetch and search while a proxy is on: spawning the host directly left the kernel's outbound proxy policy uninstalled, so under TUN/fake-IP every name resolved into 198.18.x.x and was refused as non-public; a child whose environment carries a proxy now gets that policy installed first (when it cannot be installed, only the proxy is affected and the boot proceeds as before)
- Fixed market uninstalls dying on pnpm's release-age cooldown: pnpm 11 withholds a version published inside 24 hours, and the remove path wires none of pnpm's own grace handling, so a plugin whose manifest pinned a fresh version could not be uninstalled at all; the rejected versions are now recorded in the profile's exclusion list and the command retried once, with every other package still under the cooldown
- Fixed the market's "could not locate the kernel CLI" on install and uninstall: the market drives the kernel CLI for both and guessed its location from its own path and the process entry script, which finds nothing in a dev workspace (the plugins live in this repo, the CLI in another checkout); the shell now hands it the absolute path of the active kernel's CLI
- Fixed a boot stuck on "Failed to load plugins": the upstream experimental Agent Teams package cannot activate its client half against the loader shipped in the same version, and one failing client plugin rejects the whole page (it is not a warning), leaving the window with nothing but that line; the row is now explicitly disabled, with a note on how to restore it once upstream republishes (drop the row, or write `disabled: false` in `$DSH_HOME/cordis.patch.yml`)
- Known limitation: open the log directory / notify / save-as work only inside the app's UI — the host's own HTTP client is a Node child process, which cannot resolve the `dsh-app://` scheme, so the three actions are unreachable from the command line
- The suite now boots its own profile: the kernel runs `--profile dsh-app`, while your own `dsh` / `dsh web` runs keep `web` — the two plugin worlds no longer touch each other. On first run the shell creates that profile in the background and carries your hand-written patch layer over (disables, MCP rows); third-party packages are not carried — the in-app market grows a "N plugins from the previous profile are not installed here / install all" entry that reinstalls them into the current profile at their declared specs (npm ranges, local tarballs, GitHub and https packages included). The old profile is untouched, so you can always go back. Sessions, settings, credentials, workspaces and plugin storages are profile-independent and unaffected; the profile in force is exported as `DSH_APP_PROFILE`, so the market and presets install into the profile the app actually reads
- First launch no longer looks like a hang: a local splash window (brand mark + version + five-step progress + a pausable download + a failure card with 重试 / 打开日志目录 / 退出, whose wording is layered by cause — a checksum mismatch only ever suggests changing networks, never "retry later"). It wears the same custom chrome as the main window, follows the 外观 setting for light/dark, and carries one fixed line at its foot: 首先您要健康，其次才是其次
- Kernel updates are now layered: the runtime is split into node / vendor / dsh / suite layers, each verified and cached independently, so a dsh bump downloads only the layers that changed (about 10 MB instead of 100 MB+). Any miss or failure falls back to the single tarball, so an update can never fail for being clever
- The kernel runtime is assembled with pnpm: the dependency tree no longer depends on npm's flattening, the build is reproducible (pinned overrides, pnpm's release cooldown disabled), and every file lands in a manifest
- Desktop: launch a folder straight into a workspace: drop a folder on the app icon (or run `dsh-app.exe D:\some-project`) and it opens as a workspace with a session. Launching again while the app is running only focuses the existing window and reuses the blank session — never a second window
- New 诊断 settings page: desktop-feature status, the kernel log tail, a button that opens the log directory, and a plain-text diagnostics package export (no keys, no session content, written in the UI's language)
- The whole UI is bilingual: the shell (splash, tray, dialogs, update prompts) and every suite plugin page follow the system language, overridable with `DSH_APP_LOCALE`; English pages such as Web search no longer show Chinese (the host sends status codes, the page renders the copy)
- The settings rail is usable: the list scrolls in a short window (its last four rows used to be unreachable), the order is grouped by intent (model → integrations → ecosystem → subagents → system → session data), and 诊断 has its own glyph instead of the generic gear
- Two dark-theme readability defects: the close dialog's and the update card's primary buttons were white-on-white (invisible in dark mode); both now use the main UI's paired colour tokens
- Engineering guards: a packaged-artifact smoke test (asar entries / static assets / bundled kernel), a static plugin-dependency-graph check, and CI coverage for every plugin test suite
- Windows app updates stay as they were: measured differential download saved only about 44%, at the cost of a resident full installer on every machine and a more complex download chain, so it was dropped
- Docs: README (both languages) gained a Download & install section (Windows SmartScreen / macOS Sequoia "Open Anyway" in one pass), plus notes on kernel layers, the diagnostics page and the splash
- Parallel subagents: the settings-page nav icon changes from the generic gear to a dedicated one-orchestrator-three-workers glyph (same convention as the search and memory sections); the settings themselves are unchanged
- Memory rebuilt around topics: storage moves from one date-stamped append-only file per scope to one plain-text .md file per topic plus a host-maintained index; saving the same topic again rewrites it instead of piling up, and correcting a memory is one step (no more forget-then-save). Existing memories migrate automatically at boot (the old file is kept as memory.legacy.md, pins survive the migration). New writes are duplicate-guarded: restating a fact under a fresh name is rejected with a pointer to the card that covers it; every write triggers a free maintenance pass (exact-duplicate merge, overlap suspects logged), and the background curator now merges/deletes/rewrites by topic with a mandatory shrink directive (with concrete numbers) past 30 topics or 16KB. The settings page lists memories by topic with expandable bodies, pin/delete by name, and localized category labels
- Memory tool contract change (only affects hand-written automation): memory_save gains required topic and summary parameters, memory_recall reads one card by exact topic, and memory_forget matches topic names first
- Web search: the default engine order is now **AnySearch → Bing → Parallel → Exa → SearXNG**, grounded in a full head-to-head of all four working engines across five query shapes (latency and hit quality both measured). On long Chinese queries Bing degrades into generic results (Baidu Baike, Zhihu travel guides) while AnySearch, Exa and Parallel all hit authoritative sources (weather.com.cn, nmc.cn); among the two hosted endpoints Parallel beats Exa on both speed (1958ms vs 3070ms) and relevance, so it now precedes it. The keyless engines still precede the metered ones, so quota is only spent when the free engines fail
- Proxy watchdog: when an injected proxy disappears mid-session (the user closes their VPN), the shell restarts the dsh server, re-detects, and continues without a proxy — no tray-menu trip required. It only acts on a proxy this shell injected; a proxy the user exported themselves is left alone
- Adaptive proxy: the shell probes for a local proxy (Clash/mihomo and friends) at boot and injects the proxy variables only when one is actually listening. Under TUN/fake-IP mode this makes `web_fetch` work (the proxied branch skips address validation), while a closed proxy no longer drags down search, fetch and direct requests by pointing them at a dead port
- Web search: SearXNG now sorts last, is dropped from the attempt list when no instance is configured, and reports an explicit 未配置实例 state. Public instances have largely disabled the JSON API (they answer HTML or an anti-bot page), so a preset list or a blind attempt only spends a round-trip and pollutes the fallback note; point it at a self-hosted instance in the settings page
- Web search: a new end-to-end self-check drives the real `ctx.web.search` and reports the active provider, the engine that actually answered, cache hits, and the chain's own fallback note
- Web search: 搜索来源 became two status cards, each showing its real availability (ready / unavailable / unknown) with the reason when unusable — an unmounted upstream provider or a missing DeepSeek key is surfaced before the switch, not after it fails
- Web search manager (new `plugin-websearch`): the hand-written exa / parallel MCP rotation previously living in `~/.dsh/cordis.patch.yml` is now managed from a 设置 → 网络搜索 settings page covering engine order, enablement, keys and fallback strategy. The mechanism is not a new tool but a `ctx.web` search provider (`dsh-app`), so the model still sees the kernel's own `web_search` — schema, citations and result rendering all stay upstream. Five built-in engines (AnySearch, Bing, Parallel, Exa, SearXNG) fall through automatically when a preferred one fails or returns nothing, with a note naming the engine that actually answered; both fixed-order and rotating strategies are supported
- Web search manager: dropped the two DuckDuckGo engines (proxy-only from mainland China and aggressively rate-limited, so they added a guaranteed failure to every chain) and added AnySearch in their place — an anonymous keyless JSON API with structured results, verified reachable directly from the mainland
- Web search manager: engine keys accept literal values or `$ENV:NAME` references and are always masked to `••••••` on read; config lives in `$DSH_HOME/storages/dsh-app-plugin-websearch/config.json` and is written atomically
- Web search manager: the `- id: web` override row must name BOTH `searchProvider` and `fetchProvider` — patch semantics replace the whole config object, so naming only the former re-registers `web-fetch-http` and fails the entire plugin tree on a duplicate entry

## [v0.11.9] - 2026-09-14

### 中文
- 打包修复：套件插件的运行时资源此前从未随运行时产物分发——构建只拷贝了 `package.json` 与 `lib/`，于是 PPT 的模板库与 PDF 的内嵌中文字体在安装包里根本不存在（模板面板打开是空的、中文 PDF 会缺字体）。现在按各插件自己声明的 `files` 契约拷贝资源目录，构建日志逐插件打印所拷贝的条目与体积；同时补齐了从未随包分发的 `cordis.patch.yml`。冒烟检查补上防漏断言：模板数量、每套模板的封面预览、PDF 字体可读，以及直接解包核对资源目录——把资源从产物里删掉后冒烟会红，旧故障形态无法再溜过去
- 会话记忆：收紧写入门槛——单条上限 500→200 字符，超长直接拒绝并要求改写成一行事实；提炼 prompt 增加正反示例（工作日志、协议字段表、逐文件改动清单为反例，协作偏好、无人记录的坑为正例），比纯规则更有效
- 会话记忆：三条写路径（工具保存、后台提炼、策展合并）机械剥离 commit id——只匹配独立的 7-12 位字母数字混合十六进制串，纯数字（计数/时间戳）与目录名后缀不受影响
- 会话记忆：超长对话的提炼摘录从「保头丢尾」改为「保尾 + 短头」——决策、结论与用户纠正几乎总在对话尾部，旧截断恰好丢掉最有价值的部分
- 会话记忆：memory_recall 新增 query 关键词过滤，返回命中行与文件真实条数，过滤视图不再被误当作全量；常驻注入的指引块瘦身约三分之一
- 会话记忆：会话中途的 memory_save 不再压制整段增量——改为记录保存点事件序号，后台提炼只跳过保存点之前的内容，之后的对话照常获得第二意见
- 会话记忆：策展新增超预算收缩——超过 30 条或 6KB 的文件收到带具体数字的强制瘦身指令，非固定条目「存疑即删」；收缩后仍超标的文件保持待策展（下一轮继续），空转一轮则记账防止烧循环，失控长大的文件会被逐步压回可用范围

### English
- Packaging fix: suite plugins' runtime assets were never shipped with the runtime artifact — the build copied only `package.json` and `lib/`, so the PPT template library and the PDF bundled CJK font simply did not exist inside the installer (the template panel opened empty and Chinese PDFs missed their font). Asset directories are now copied from each plugin's own `files` contract, the build log prints every copied entry with its size, and `cordis.patch.yml` — also never shipped before — now travels with the plugin. The smoke suite gained anti-regression assertions: template count, a cover preview for every template, PDF font readability, and a direct unpack check of the runtime artifact; deleting the assets from the artifact makes smoke fail, so the old failure shape can no longer slip through
- Memory: tighter write gates — one entry is capped at 200 chars (was 500) and oversized input is rejected with a request to rewrite it as one lean fact; the distill prompt now carries accepted/rejected examples (work logs, protocol field maps and file-by-file change lists rejected; collaboration preferences and undocumented pitfalls accepted), which beats rules alone
- Memory: commit ids are stripped on every write path (tool save, background distill, curator merge) — only a standalone 7-12 char mixed letter/digit hex run matches, so pure-digit counts, timestamps and directory-slug suffixes pass through
- Memory: the distill excerpt of an oversized delta now keeps the newest tail plus a short head prefix — decisions, outcomes and user corrections live at the END of a delta, exactly what the old head-keep cut dropped
- Memory: memory_recall gains a query keyword filter returning the matched rows and the file's true entry count, so a filtered view is never mistaken for the whole file; the always-injected guidelines block is a third leaner
- Memory: a mid-session memory_save no longer suppresses the whole delta — it records the save point as an event seq, the background pass skips only the pre-save span, and later conversation still gets its second opinion
- Memory: the curator now shrinks over-budget files — beyond 30 entries or 6KB it receives a mandatory shrink directive with the concrete numbers and a "when in doubt, delete" rule for non-pinned rows; a file still over after shrinking stays due (the next sweep continues the diet) while a no-op pass records itself to avoid a burn loop, so grown files converge back to a usable size

## [v0.11.8] - 2026-09-13

### 中文
- 应用内更新支持国内镜像：检查更新与下载安装包优先走 ModelScope 镜像（大陆网络无需代理），失败时自动回退到 GitHub 与既有的加速前缀；即使更新元数据能取到、但安装包下载被墙，也会自动改走镜像完成下载（校验值与 GitHub 同源，完整性不受影响）
- 更新下载单源超时从 10 分钟收敛到 3 分钟（四路候选最坏约 12 分钟而不是 40 分钟），失败时的提示里给出镜像手动下载地址
- 发布镜像通道改用官方 SDK 上传（其提交自带重试与指数退避），并对镜像作业做串行化，修复此前偶发的"平台拒绝提交"；版本索引改为合并式重建并自校验，避免读改写竞态
- 更新相关入口的版本号校验收紧，拒绝可疑路径形式

### English
- In-app updates now use a China-reachable mirror: both the update metadata and the installer download try the ModelScope mirror first and fall back to GitHub and the existing accelerator prefixes; if the metadata resolves but the installer download is blocked, the mirror is still tried last, so the update completes through it (integrity is unchanged because the checksums come from the same release)
- The per-source download timeout drops from 10 minutes to 3 minutes (four candidates now worst-case around 12 minutes instead of 40), and failure dialogs point at the mirror's manual download page
- The release mirror uploads through the official SDK (whose commit step retries with exponential backoff) and the job is serialized, fixing the intermittent platform-side commit rejection; the version index is rebuilt by merging and self-checking instead of read-modify-write
- Version guards on the update entry points are tighter and reject suspicious path forms

## [v0.11.7] - 2026-09-13

### 中文
- 插件市场（新）：侧边栏设置上方的入口改为右侧抽屉（无遮罩、左缘把手收起，不再与窗口按钮打架）；内置两个目录源（含国内可达源），支持中文分类、作者搜索、卡片信息与"仅源码"标注；**按仓库地址识别插件身份**——本地 tgz 或 Git 安装的插件不再被同名包静默覆盖，覆盖必须显式确认；安装遇到 pnpm 构建脚本拦截时可一键"放行并重试"；已安装页显示版本与"有更新"，支持单个与批量更新；首屏改为两段式（已安装列表读本地事实立即显示，联网更新信息异步补上），目录走磁盘缓存与内置离线快照，断网也有内容可浏览
- 办公套件（新，四个格式）：PPT、Word、Excel、PDF 四个模式全部使用本地引擎渲染（不经服务端、离线可用）；输入框下方四个胶囊入口，点击即进入会话级模式并自动在输入框携带对应技能引用；四个模式互斥，切换时即时替换；PPT 提供 30 个模板（含从开源结构版式导入的新几何族）、原生可编辑图表，以及"模板风格/自由创作"两种通道；PDF 可把工作区里的 PDF 读成材料，也能生成带页码的报告
- 办公套件排版规范：四格式共用一套设计标准——中文文档首行缩进 2 字符、两端对齐、标点避头尾；表格统一为极简水平线、数字右对齐且同列小数位一致、千分位、负数括号、比率按百分比、合计行强调、三套可选配色谱；渲染前强制校验（结构、容量、规范），不合格直接拒绝导出并给出逐条修复指引
- 预设与备份（新）：`.dshpreset` 预设包导出/导入（对名称与路径做围栏）；配置备份导出/导入——自动排除凭据文件、扫描密钥内容、按实际解压体积防 zip 炸弹、恢复失败自动还原
- 更新与恢复（新）：可"跳过此版本"，可回滚到上一版本；新增安全模式（托盘一键进入，只加载官方内核，用于排查插件问题）；启动失败时按类别给出诊断（插件树冲突／端口占用／模块缺失）并可一键转入安全模式
- 发布与构建：新增 ModelScope 镜像通道（正式发布后自动执行，失败不阻塞主发布，结果写入 CI 摘要；修复了上传凭据外泄，以及一处导致该通道从未真正跑通的缺陷）；新增内核升级前的插件兼容性 dry-run（`npm run check:plugins`）；修复运行时构建的包脚本白名单，以及探针脚本在含空格路径下的问题

### English
- Plugin market (new): the entry above Settings opens a right-edge drawer (no scrim, a handle on its left edge to collapse it, no overlap with the native window buttons); two built-in catalog sources (including one reachable from mainland China), with Chinese categories, author search, card details and a "source-only" marker; **plugin identity is now the repository address** — a locally installed tgz or Git plugin is never silently replaced by a same-named package, and replacing it requires an explicit confirmation; blocked pnpm build scripts can be approved and retried in one click; the installed tab shows versions and available updates, with single and batch updates; the first paint is two-phase (the installed list renders immediately from local facts, update information follows asynchronously) and the catalog is served from a disk cache plus a bundled offline snapshot, so it stays browsable without network
- Office suite (new, four formats): PPT, Word, Excel and PDF all render through local engines (no server round-trip, usable offline); four capsules below the composer enter a session-scoped mode and seed the matching skill reference into the input; the four modes are mutually exclusive and switch instantly; PPT ships 30 templates (including a new geometry family imported from open-source structural layouts), native editable charts, and both a template-styled and a free-form authoring channel; PDF can read workspace PDFs as material and produce paginated reports
- Office suite typography: one shared design standard across the four formats — Chinese documents get a 2-character first-line indent, justified paragraphs and forbidden line-break punctuation rules; tables use minimal horizontal rules, right-aligned numbers with consistent decimals per column, thousands separators, parenthesised negatives, percentages for ratio columns, emphasised total rows and three selectable palettes; rendering is gated on validation (structure, capacity, conventions) so a failing project is refused with per-item repair guidance
- Presets and backup (new): `.dshpreset` export/import with name and path fencing; configuration backup export/import that excludes credential files, scans for secret content, verifies actual inflated size against zip bombs, and rolls back a failed restore
- Updates and recovery (new): skip a version, roll back to the previous one; a Safe Mode (one tray click, official kernel only) for diagnosing plugin problems; startup failures now classify into plugin-tree conflicts, port conflicts and missing modules, with a one-click switch into Safe Mode
- Release and build: a new ModelScope mirror channel (runs after the release is published, never blocks the main release, and reports into the CI summary; fixed a credential leak on upload and a defect that had prevented the channel from ever completing); a pre-upgrade plugin compatibility dry-run (`npm run check:plugins`); fixed the runtime build's package-script allowlist and probe scripts on paths containing spaces

## [v0.11.6] - 2026-09-11

### 中文
- 修复窗口空闲时空烧约 10% CPU：标题栏取色同步靠一个「颜色不变就不 resolve」的 Promise 让同步循环安静阻塞，但页面脚本里还留了一条"颜色已知就直接 resolve"的短路，于是每次调用都立刻返回，主进程与渲染进程之间每秒来回 5000–8000 次 `executeJavaScript`——窗口开着什么都不做也要占约 4% 主进程 + 5% 渲染进程（GPU 反而是 0，正是 IPC 空转而非绘制开销的破绽），风扇和续航都跟着受影响；去掉短路后回到 0%

### English
- Fixed the ~10% CPU burnt while the window sits idle: the title-bar colour sync parks its loop on a promise that resolves only when the colour changes, but the page script also short-circuited once a colour was already known — so every call returned at once and the main process ping-ponged `executeJavaScript` with the renderer 5000-8000 times a second. An idle window cost ~4% of the main process and ~5% of the renderer (with the GPU flat at 0, the giveaway that this was IPC spin and not painting), and the fan and battery life followed. Removing the short-circuit brings it back to 0%

## [v0.11.5] - 2026-09-11

### 中文
- 会话记忆：后台提炼的空转与漏跑一起修——主 agent 在本轮已主动写过记忆时直接让位，新增内容不足 4000 字符时不再调用模型（最近 16 次调用里 7 次返回 0 条，空耗 2.4 万 tokens）；静默窗口内重复触发改为重排定时器，不再吞掉那一段内容
- 会话记忆：设置页的单条删除也要确认了，弹窗把该条原文引回来（超长截断），标题区分「删除该条记忆」与「删除已固定的条目」——此前只有"清空全局"和"删项目"有确认，逐条删除点一下就没了，而全局列表里放着的正是你亲手固定过的条目
- 会话记忆：修复注入预算下固定条目被整条丢弃——超预算的 pin 现在截断注入，一个长 pin 不再独吞预算、把它后面的 pin 全饿死
- 会话记忆：写入范围不再由模型决定——提炼 prompt 与 JSON 契约都不再提供 scope 字段，只按会话工作目录判定，唯一能写项目记忆的后台通道再也不会被内容诱导去写全局文件
- 会话记忆：提炼读到的既有记忆封顶 12000 字符（取最新），超长文件不再把 prompt 撑爆
- 会话记忆：策展（curator）不得再动固定的条目——引用 pinned 行的编辑一律拒绝
- 会话记忆：后台直连调用加 180 秒超时（与调用方取消区分开）；模型把引用的原文排在结论 JSON 前面时也能正确取出结论
- 会话记忆：精确匹配改为 Unicode 感知——纯假名、西里尔文、带音标拉丁文的条目此前会被规范化成空串，导致删除与去重误伤
- 会话记忆：设置页文案澄清全局与项目各自的写入来源（全局只能由 AI 主动保存或手写，项目由后台提炼补记）

### English
- Memory: the background distiller's wasted runs and missed runs are fixed together — it stands down when the agent already saved this turn, and it never calls the model when a session's new content is under 4000 characters (7 of the last 16 runs returned 0 entries, ~24k tokens burnt); a trigger landing inside the quiet window is rescheduled instead of swallowed, so that content no longer waits for a later window
- Memory: single-row deletes in the settings page confirm too now, through the same dialog that quotes the row back (truncated when long), with the heading separating "delete this row" from "delete a pinned row" — previously only clearing the global file and deleting a whole project asked, while one click dropped a row for good, and the global list is exactly where the rows you pinned by hand live
- Memory: fixed pinned rows being dropped outright once the injection budget ran out — an over-budget pin is clipped into the budget instead, so one long pin can no longer swallow the budget and starve the pins behind it
- Memory: the write scope is no longer the model's choice — neither the distill prompt nor its JSON contract offers a scope field any more; it follows the session's working directory, so the one background channel that writes project memory can no longer be talked into writing the global file
- Memory: the existing memory a distill reads is capped at 12000 characters (newest first), so an oversized file can no longer blow up the prompt
- Memory: the curator may no longer touch a pinned row — any edit citing one is rejected
- Memory: the background direct call now times out at 180s (kept distinct from a caller abort), and a conclusion still parses when the model puts a quoted excerpt ahead of its JSON
- Memory: exact matching is Unicode-aware — kana-only, Cyrillic and accented-Latin rows used to normalize to an empty string, which made deletion and dedupe hit the wrong entries
- Memory: settings copy spells out where each store is written from (the global file only via the agent's own saves or by hand, project files via the background distill)

## [v0.11.4] - 2026-09-10

### 中文
- 修复 Windows 上内核激活后 `current.json` 写不完整：写入器的目录 fsync 在 Windows 必然失败（EPERM）且会向上抛出，而抛点在 rename 之后——文件已更新、函数却报失败，导致激活后写入的字段（已采纳标识 `bundledStamp` 等）从未落盘，于是每次启动都重新解压一次内核、`cleanup` 还会删掉刚激活的目录；目录 fsync 改为尽力而为
- 记忆策展（curator）改为直连模型调用：此前它仍起只读子代理，而那个子代理没有任何工具（`toolFilter: allow []`），等于为一次 JSON 回答付整套会话生命周期的钱，单次 7k–47k tokens；现与提炼共用直连通道，成本降一个数量级，宿主侧校验（逐字引用、去重、编辑上限）完全不变
- 记忆插件彻底移除子代理通道：提炼的 `distillBackend` 开关、`ctx.subagents` 依赖与 `@deepseek-ai/dsh-subagent` 声明一并删除——少依赖一个内核 API 就少一处「类型全绿、运行时炸」的漂移面
- 策展规则新增「删除工作日志式条目」：只报告"这次做了什么"的条目（完成清单、逐文件改动清单、任务摘要）会被清掉，而不是越积越多
- 策展开始记入 LLM 审计（来源 `curate`），设置页终于能看到它的开销

### English
- Fixed `current.json` being written incompletely on Windows: the writer's directory fsync always fails there (EPERM) and throws, and it throws AFTER the rename — so the file was updated while the call reported failure, and every field written after that point (the adopted-bundle `bundledStamp` among them) never landed. The result was a full runtime re-extraction on every start and a `cleanup` that deleted the directory it had just activated. The directory fsync is best effort now
- The memory curator now calls the model directly. It was the last background path spawning a read-only subagent, and that child declared no tools at all (`toolFilter: allow []`) — a whole session lifecycle paid for one JSON answer, 7k–47k tokens per run. It shares the distiller's direct channel now, an order of magnitude cheaper, with host-side validation (verbatim citations, dedupe, edit cap) unchanged
- The subagent channel is gone from the memory plugin entirely: the distiller's `distillBackend` switch, the `ctx.subagents` inject and the `@deepseek-ai/dsh-subagent` dependency are removed — one fewer consumed kernel API is one less place for silent type-green/runtime-throw drift
- The curator's rules gained a work-log clause: entries that merely report what a session did (completion lists, file-by-file change lists, task summaries) are deleted instead of accumulating
- Curate runs are audited at last (`source: 'curate'`), so the settings page can show the curator's cost

## [v0.11.3] - 2026-09-10

### 中文
- 修复内核更新后应用内跳转被丢给系统浏览器：窗口的导航守卫在创建时记下服务 origin，而内核更新会重启服务、换到新端口，守卫仍拿旧 origin 把站内链接判成外部链接；现在每次重载窗口前都会刷新
- 修复启动期一次崩溃被计两次：子进程在启动窗口内退出时，rejected 的 `start()` 与 `onExit` 会各驱动一次恢复流程，导致跳过退避重试直接回滚或退出；现在只上报一次
- 首装失败现在会弹出对话框说明原因（此前只有托盘 tooltip，无窗口时用户什么都看不到）；未安装内核时手动「检查内核更新」会直接安装，而不是提示"内核已是最新版本"
- 更新通道不再跨线回退：registry 缺少该通道对应的 dist-tag 时，不再退而取 rc/alpha 版本并当作正式版更新提供
- 修复 Session 导出完成提示重复弹出：下载监听挂在共享 session 上，窗口重建后会叠加，一次下载弹两次（且可能打到已销毁的窗口）
- 内核更新检查改为互斥（定时与手动不再并发探测）；归档接口的围栏失败改为立即返回 403，不再让连接空等

### English
- Fixed in-app navigation being handed to the system browser after a kernel update: the window's navigation guard captured the server origin at creation, but a kernel update restarts the server on a new port and the guard kept the old origin, so in-app links were classified as external; it is now retargeted before every window reload
- Fixed a startup crash being counted twice: when the child exited during startup, both the rejected `start()` and `onExit` drove the recovery path, skipping the backoff retry and jumping straight to rollback or exit; it is reported once now
- A first-run install failure now raises a dialog explaining it (previously only a tray tooltip, invisible with no window); a manual kernel check with nothing installed installs instead of reporting "内核已是最新版本"
- The update channel no longer falls back across lines: a registry lacking the channel's dist-tag no longer substitutes an rc/alpha version and offers it as a stable update
- Fixed duplicate Session-export toasts: the download listener lives on the shared session and stacked when a window was rebuilt, firing twice per download and possibly at a destroyed window
- Kernel update checks are serialized (timer and tray no longer probe concurrently); archive routes answer a fenced request with an immediate 403 instead of holding the connection

## [v0.11.2] - 2026-09-10

### 中文
- 安全：mcp / hooks / memory / swarm / usage 五个插件的设置接口补齐 loopback 围栏——此前只校验 Origin 与 Host 同源，而 DNS rebinding 下两者都指向攻击者域名因而通过；其中 mcp 的「新建服务器」可借这条路径执行任意 stdio 命令
- 内核线不再有两份：跟随哪条线由 `package.json` 的 `@deepseek-ai/dsh*` 依赖决定（`scripts/kernel-line.mjs` 推导 dist-tag 并断言版本满足该依赖），v0.11.1 那种「alpha 内核 + rc 代码 + CI 全绿」的错配从本版起会直接构建失败
- 复用已发布的内核产物更严格：`runtime-<版本>` 只有在 6 个平台齐全且套件版本与当前树一致时才复用，套件有变必重建
- 内核采纳改按身份判断：`current.json` 记录已采纳的 bundled 运行时标识，不再把用户在线更新过的内核降级回内置版本
- 修复内核安装成功后误报「安装失败」并触发联网重装：解压完成后清理 staging 失败（Windows 文件锁）会把已成功的激活当成失败上报；现清理改为尽力而为，失败时先重读磁盘状态再决定
- 内核日志落盘到 `<logs>/dsh-kernel.log`：此前只走 stdout，在打包后的 Windows 应用里不可见，这类问题完全无法取证
- 修复发版流水线在「复用已发布内核」时产出空 release：app 任务缺少 `!cancelled()`，runtime 被跳过时 GitHub 会连带跳过全部 app 任务

### English
- Security: the settings APIs of mcp / hooks / memory / swarm / usage now require a loopback Host — they compared Origin against Host only, which DNS rebinding satisfies because both carry the attacker's domain; mcp's "create server" could execute an arbitrary stdio command through that path
- The kernel line no longer exists in two copies: which line a build follows comes from the `@deepseek-ai/dsh*` dependencies in `package.json` (`scripts/kernel-line.mjs` derives the dist-tag and asserts the version satisfies them), so the v0.11.1 mismatch of an alpha kernel beside rc code — with CI green — now fails the build outright
- Reuse of a published runtime is stricter: `runtime-<version>` is reused only when all six cells are present AND that release's suite version matches this tree's; a suite change always rebuilds
- Adopting the bundled kernel is now identity-based: `current.json` records which bundle was adopted, so a kernel the user updated online is never downgraded back to the installer's
- Fixed a successful kernel install being reported as "安装失败" and followed by a pointless network reinstall: a staging-cleanup failure after activation (a Windows file lock) surfaced as an install failure; cleanup is now best effort and the first-run path re-reads the on-disk state before deciding
- Kernel diagnostics now land in `<logs>/dsh-kernel.log`; they previously went only to stdout, invisible in a packaged Windows app, which left this class of failure with no evidence at all
- Fixed the release pipeline producing an empty release on the "reuse published kernel" path: the app job lacked `!cancelled()`, so GitHub skipped every app job whenever the runtime matrix was skipped

## [v0.11.1] - 2026-09-10

### 中文
- 会话归档：删除恢复为物理删除——v0.11.0 因上游移除私有 `locate()` 而降级成"只删归档记录"，归档会话删掉又回到列表；现改走 rc 线公开的 `resolveCurrentLog` 真正删除日志目录。同时删除不再移除归档记录：该记录是客户端的可见性栅栏，移除它会立刻广播"取消归档"，而浏览器仍握着旧列表快照，已删除的会话会短暂弹回会话列表（刷新才消失）；保留的记录由面板「清理」回收
- 会话归档：修复迁移前格式的老会话永远删不掉、一直提示"日志已不存在"——上游 `resolveCurrentLog` 只对当前格式的日志作答，旧会话能列出却解析不出路径；现补一条按后端目录布局定位会话目录的回退，并在删除前校验目录名与会话日志文件
- 会话记忆：提炼提示词加入否定清单，不再把工作日志、commit 号、"已完成"汇报、逐文件改动清单写进长期记忆（实测一段混合会话中三条流水账被拒、耐久偏好正常保存）；`memory_save` 直存此前不会触发后台策展，现已接上；修复存量 `- [分类] 日期 日期 内容` 双日期行

### English
- Session archives: deletion is physical again — v0.11.0 had degraded it to dropping the archive record after upstream removed the private `locate()`, so a deleted archive came back to the list; it now uses the rc line's public `resolveCurrentLog` to remove the log directory. Deletion also stops touching the archive set: that set is the client's visibility fence, and removing a record broadcasts "unarchived" while the browser still holds a stale list snapshot, briefly popping the deleted session back into the sidebar until a reload; the kept record is reclaimed by the panel's 清理 action
- Session archives: fixed pre-migration sessions that could never be deleted and always reported "日志已不存在" — upstream `resolveCurrentLog` answers only for logs in the current format, so an old session listed but resolved to no path; /delete now falls back to locating the session directory by the backend's own layout, validating the directory name and the presence of session log files before removing anything
- Memory plugin: the distill prompt gained an explicit NEVER list, keeping work logs, commit ids, "already done" reports and file-by-file change lists out of long-term memory (a mixed transcript had three work-log lines rejected while the durable preference saved); direct `memory_save` calls now fire the background curator; legacy `- [category] date date content` rows are repaired

## [v0.11.0] - 2026-09-10

### 中文
- 内核跟进 dsh 0.1.5-rc.1：依赖全线对齐；归档删除改为逻辑删除（上游移除物理删除 API，记录移除后由上游生命周期回收文件）；用量回填改用 `open/read` 新 API；修复 Linux/macOS 内核 node 路径（`node/bin/node` → `node/node`，否则非 Windows 全新安装无法启动）
- 侧边栏文件管理退役：上游 sidebar 已原生支持文件管理，删除自带文件树（约 650 行）避免冗余；Git 页保留
- 记忆直调修复：子调用丢失 `this` 导致每次提炼抛错（审计 5 连错、0 token），现已绑定并补回归测试；食用审计验证单次提炼约 11k tokens
- 全仓冗余清理与加固（88 文件）：死代码删除、错误 fail-closed、日志脱敏、完整性校验加强、构建脚本收敛；发布流程改用 `needs.runtime.result` 判定产物来源

### English
- Kernel follows dsh 0.1.5-rc.1: all deps aligned; archive deletion is now logical (upstream removed physical deletion APIs — records drop, files reclaimed by upstream lifecycle); usage backfill uses the new `open/read` API; fixed the kernel node path on Linux/macOS (`node/bin/node` → `node/node`, fresh installs otherwise fail to boot)
- Sidebar file manager retired: upstream ships file management natively, so the built-in file tree (~650 lines) is removed; the Git tab stays
- Memory direct-channel fix: the detached stream call lost `this` and every distill threw (5 audit errors, 0 tokens); now bound with a regression test; audit shows ~11k tokens per distill
- Repo-wide redundancy cleanup and hardening (88 files): dead code removal, fail-closed errors, log redaction, stronger integrity checks, converged build scripts; release flow now keys artifact source on `needs.runtime.result`

## [v0.10.0] - 2026-09-10

### 中文
- 记忆插件：后台提炼改走直接模型调用——此前每个静默窗口起一个只读子代理（完整会话生命周期，token 开销大）；现默认一次 `ctx.llm.stream` 直调加宿主侧 JSON 解析，同样的提炼质量、约一个数量级的 token 消耗；保留子代理通道为可配置回退（`distillBackend`）
- 记忆插件：修复提炼/策展合并时条目内容带 `- [分类] 日期` 前缀导致落盘双前缀的问题——宿主侧强制剥离，提示词明确禁止，并一次性清洗存量坏数据
- 记忆插件：后台 LLM 消耗可观测——每次提炼/策展调用记 tokens/耗时/状态到 `llm-audit.json`（新增 `/llm-audit` 路由），设置页「最近提炼」显示通道与 token 消耗
- 模型高级设置页：provider 支持自定义请求头——每个 provider 可配多组 HTTP 请求头（如 OpenCode Go 要求的 `x-opencode-session`），与适配器解析规则一致校验，冲突时提示重载

### English
- Memory plugin: background distill now calls the model directly — each quiet window previously spawned a read-only subagent (full session lifecycle, heavy token cost); now a single `ctx.llm.stream` call plus host-side JSON parsing delivers the same quality at roughly an order of magnitude fewer tokens; the subagent channel stays as a configurable fallback (`distillBackend`)
- Memory plugin: fixed distill/curate merges persisting double-prefixed lines (`- [category] date` echoed into content) — the host strips the prefix, the prompt bans it, and legacy bad rows are repaired once on boot
- Memory plugin: background LLM cost is now observable — every distill/curate call logs tokens/duration/status to `llm-audit.json` (new `/llm-audit` route), and the settings "recent distills" list shows the channel and token spend
- Advanced Models page: per-provider custom request headers — each provider route accepts HTTP header pairs (e.g. the `x-opencode-session` OpenCode Go requires), validated against the same rules as the adapter resolver, with reload prompting on conflict

## [v0.9.9] - 2026-09-09

### 中文
- 修复会话页顶部右侧按钮被窗口控制按钮遮挡：alpha.1 新增的最右侧角落按钮（侧边栏展开）贴着标题栏右边缘，正好压在原生最小化 / 最大化 / 关闭按钮之下，文件管理图标与相邻工具按钮点不到；现将角落按钮整体左移让出控制条，同行工具按钮随之让位，空出的区域仍可拖动窗口

### English
- Fixed session-page top-right buttons hidden under the window controls: the far-right corner button added in alpha.1 (sidebar expand) sits flush against the header edge, right beneath the native minimize / maximize / close buttons, leaving the file-manager icon and neighboring utility buttons unclickable; the corner is now shifted left of the control strip with the row's utilities following, and the vacated zone stays draggable

## [v0.9.8] - 2026-09-09

### 中文
- 修复卡在损坏 alpha.1 内核的用户无法自动恢复：v0.9.7 内置的是 rc.1 内核，启动漂移检查不处理版本回退，已装坏版 alpha.1 的用户收不到修复；本版内置完整的 alpha.1 内核（10 个套件插件齐全），启动时自动重新激活，无需手动删除内核目录
- 修复打包脚本遗漏 MCP 管理器与 Hooks 桥（上一版代码已修，本版起实际生效）：运行时产物现包含全部 10 个套件插件；五处插件名单已锁定同步
- 打包通道跟随 alpha 线（0.1.5-alpha.1），未来发版自动打包最新 alpha 内核

### English
- Fixed users stuck on the broken alpha.1 kernel never auto-recovering: v0.9.7 bundled an rc.1 kernel and the boot drift check does not handle version downgrades, so users already on the broken alpha.1 got no fix; this version bundles the complete alpha.1 kernel (all ten suite plugins) and re-activates it automatically on boot, no manual kernel-directory deletion needed
- Fixed the packaging script omitting the MCP manager and hooks bridge (code fixed in the previous version, effective from this one): runtime artifacts now contain all ten suite plugins; the five plugin-list sites are pinned in sync
- Packaging channel follows the alpha line (0.1.5-alpha.1); future releases automatically bundle the newest alpha kernel

## [v0.9.7] - 2026-09-09

### 中文
- 修复设置页自有插件项全部消失：打包脚本的插件名单漏掉了新增的 MCP 管理器与 Hooks 桥，overlay 引用了运行时里不存在的包，插件组合失败后所有套件页面（含侧边栏文件/Git 视图）静默缺失；名单已补齐并与 overlay、桌面壳、冒烟探针、CI 预构建五处锁定同步。已在坏内核上的用户更新到本版后会自动重新激活完整内核，无需手动操作

### English
- Fixed all suite plugin sections disappearing from settings: the packaging script's plugin list missed the newly added MCP manager and hooks bridge while the loader overlay already inserted them, so plugin composition failed and every suite page (including the sidebar file/Git views) silently went missing; the list is now complete and pinned in sync across the five list sites (build script, overlay, desktop shell, smoke probe, CI pre-build loop). Users already on the broken kernel will automatically re-activate the complete kernel after updating to this version, no manual steps needed

## [v0.9.6] - 2026-09-09

### 中文
- 内核更新支持多线自选：检查更新时同时查询正式版 / 候选版 / 测试版三条线，有新版本的线各自成为一个可安装选项（如 rc 用户看到更新的 alpha），后台常驻卡片与托盘手动检查弹窗都可逐线选择；每个选项发布前都经过安装包可用性探测，不会给出装不了的选项
- 新增 MCP 服务器管理器：设置页可直接添加、管理 MCP 服务器（表单 / JSON 双模式编辑、批量 JSON 导入、显示名自动生成），服务器启用后动态挂载、工具数量实时可见
- 新增外部 Hooks 桥：设置页可管理 Claude Code / Codex 兼容的 hooks.json 桥接，也支持免配置文件、手写规则的 DSH 原生格式（工具执行前拦截、执行后阻断反馈、智能体步骤前阻断或注入上下文、会话开始时注入）；确认框统一走应用内弹窗样式
- 新增会话提醒：通过套件 overlay 启用上游日程服务，会话内可创建定时提醒，到期自动跟进一条消息
- 新增归档会话全文搜索：设置页搜索框按关键词检索历史会话（标题 / 时间 / 工作目录 / 内容摘要），无结果时给出明确提示
- 修复长期运行后应用白屏：dsh 每次启动服务生成新的随机认证 Cookie，Electron 持久会话不断累积，Cookie 头超过 16KB 上限后服务端返回 431——现每次加载窗口前清理过期认证 Cookie，用户已确认白屏消失

### English
- Kernel updates now offer every line for the user to pick: each check queries the stable / beta / alpha lines together, and any line carrying something newer becomes its own installable option (e.g. an rc user sees a newer alpha); both the persistent background card and the manual tray-check dialog list per-line choices. Every option passes an artifact-availability probe first, so uninstallable options are never shown
- New MCP server manager: add and manage MCP servers from settings (form / JSON dual-mode editing, bulk JSON import, auto-generated display names); enabled servers mount dynamically with live tool counts
- New external hooks bridge: manage Claude Code / Codex compatible hooks.json bridges from settings, plus a DSH-native rule format with no config file required (pre-execution deny, post-execution block with feedback, pre-step block or context injection, session-start injection); confirmations use the in-app dialog style throughout
- New session reminders: the upstream schedule service is enabled through the suite overlay — create timed reminders inside a session and get an automatic follow-up message when due
- New archived-session full-text search: the settings search box finds past sessions by keyword (title / time / working directory / content snippet) with a clear hint when nothing matches
- Fixed the app white-screening after long use: dsh mints a fresh random auth cookie on every server start and Electron's persistent session accumulated them until the Cookie header exceeded the 16KB limit and the server answered 431 — stale auth cookies are now cleared before each window load, and the fix is user-confirmed

## [v0.9.5] - 2026-09-06

### 中文
- 优化后台记忆策展的触发频率与成本：策展清扫新增 10 分钟冷却窗口（冷却期内的多次触发合并为一次尾延清扫），并新增按文件内容 hash 的变更检测——自上次策展完成后没有任何写入的记忆文件直接跳过。此前活跃会话每 60 秒提炼落库一次就会把所有达标项目库全量重扫一遍，未变化的文件每轮白耗约 1.7 万 token
- 修正 README 中蒸馏静默时长的文档漂移（写的是 5 分钟，实际 60 秒）

### English
- Optimized background memory curation frequency and cost: sweeps now respect a 10-minute cooldown (requests inside the window coalesce into one trailing sweep) and a per-file content-hash change check — memory files untouched since their last completed pass are skipped entirely. Previously an active session saving entries every 60-second quiet window re-ran full curation over every above-threshold project file, burning ~17K tokens per unchanged file each round
- Fixed a README drift on the distill quiet window (said 5 minutes, actually 60 seconds)

## [v0.9.4] - 2026-09-06

### 中文
- 修复 swarm 并行批次全员误报失败：编排器在子代理结算后读取会话统计（失败详情、token 用量）时访问了未声明的 `agents` 服务，内核依赖注入抛 `cannot get property "agents" without inject`，把每个实际已完成的子代理都记为失败——成果本身保留在子会话中未丢失；已补服务声明，并把该统计读取改为降级安全（读取失败只损失统计与失败详情，不再影响结算结果）
- 后台记忆维护子代理（提炼/策展）标签统一加 `memory-maint:` 前缀：策展器会清扫所有项目的记忆库、与触发会话所属项目无关，前缀避免这类代理被误认为当前会话自身的工作

### English
- Fixed swarm batches reporting every item as failed: after children settled, the orchestrator read session metrics (failure detail, token usage) through the undeclared `agents` service, so the kernel DI threw `cannot get property "agents" without inject` and marked every actually-completed child as failed — the completed work itself stayed intact in the child sessions; the service is now declared, and the metrics read degrades safely (a failed read only loses metrics and failure detail, never the outcome)
- Background memory maintenance subagents (distiller/curator) now carry a unified `memory-maint:` label prefix: the curator sweeps every project's memory file regardless of which session triggered it, and the prefix keeps these agents from being mistaken for the current session's own work

## [v0.9.3] - 2026-09-06

### 中文
- 修复 Windows 应用更新点击「立即安装」后安装向导不出现：v0.9.1 移除 cmd 包装时保留了 windowsHide 标志，该标志会被 Windows 应用到 GUI 进程的首个窗口——安装进程在后台隐身运行，用户看不到任何界面；已移除该标志，并为安装进程启动失败补充日志

### English
- Fixed the Windows update flow showing no installer wizard after clicking "Install now": v0.9.1 dropped the cmd wrapper but kept the windowsHide flag, which Windows applies to a GUI process's first window — the installer ran invisibly in the background and the user saw nothing; the flag is removed and a spawn-failure log line was added

## [v0.9.2] - 2026-09-05

### 中文
- 修复后台记忆提炼与策展器静默失效：dsh 0.1.2-alpha.4 删除了 `Session.events` 读取器（改为 `snapshotEvents()`），提炼器读取旧属性拿到 undefined 后抛错、被 fail-soft 静默吞掉——自升级 alpha.4 起后台提炼从未真正运行（主动记忆 memory_save 不受影响）；改用 `snapshotEvents()` 后已实测恢复（含提炼活动记录的会话短 id 显示修复）
- 修复 swarm 子代理的失败诊断与 token 统计失效：同一根因导致失败原因读取静默降级、续跑 watermark 计算抛错
- 修复归档会话删除被全部拦截：同一根因导致「进行中」判定恒真，所有归档会话被误判为不可删除

### English
- Fixed the background memory distiller and curator silently never running: dsh 0.1.2-alpha.4 removed the `Session.events` getter in favor of `snapshotEvents()`, so the distiller read `undefined`, threw, and had the failure swallowed by its fail-soft path — no background distill ran since the alpha.4 upgrade (proactive `memory_save` was unaffected); it now reads via `snapshotEvents()` and is verified running end-to-end (the distill activity's short session id fix included)
- Fixed swarm child failure diagnostics and token accounting: the same root cause silently degraded failure-reason reads and threw on resume-watermark computation
- Fixed archived sessions being undeletable: the same root cause made the mid-turn check always true, fencing every archived session from deletion

## [v0.9.1] - 2026-09-05

### 中文
- 修复：Windows 应用更新点击「立即安装」时不再闪烁黑色终端窗口——安装向导改为直接启动（此前经 cmd.exe 包装，detached 控制台窗口无法完全隐藏）；安装结果改为下次启动时按版本号确认，取消或失败会提示重试，安装包残留自动清理

### English
- Fix: clicking "Install now" for a Windows app update no longer flashes a console window — the installer wizard is spawned directly (the detached cmd.exe wrapper could not be fully hidden); install completion is now confirmed by version comparison on the next boot, with a retry prompt on cancel/failure and automatic cleanup of the leftover installer

## [v0.9.0] - 2026-09-05

### 中文
- 并行子代理（swarm）失败分级：子任务失败按错误码分为传输/内容/结构三类——只有限流、断流、超时等传输类失败会压低批次并发并进入自动重试；任务本身做不到（拒绝、超长）或调用不合法的失败不再拖垮整批吞吐；配额耗尽只降速不空重试，批次全失败时按失败类型给出可执行的下一步建议
- swarm 拆分质量：新增 `shared_context`（公共背景写一次、注入每个子代理）、`dry_run`（只校验并预览每个子代理的完整指令，不真正执行）、拆分质量提示（过短/过粗的子任务随结果返回改进建议）；系统提示补充好/坏拆分范例
- swarm 批次 token 预算：`token_budget` 参数或配置项达到预算后停止启动新子任务（在途任务正常完成），未启动项标记中止并保留 childId 可随时恢复；结果新增每项耗时、失败分类、错误码、token 用量与批次总耗时/总用量
- swarm 自适应调度升级：未显式指定并发时，池子在持续稳定完成后可探测性爬过配置上限（最高 64），探针失败会记住本批次的实际上界不再反复撞墙；显式指定 `max_concurrency` 时严格钉死；出厂默认起始并发 6→8、上限 8→16、启动间隔 2s→1s
- swarm 设置页：设置页新增「并行子代理」区块——启用开关、自适应开关与全部调度参数可视化编辑，保存后下一次调用即时生效（仅启用/禁用需重启）；用户配置独立落盘，不再被应用更新覆盖
- swarm 修复：自动重试此前从未真正等待重试轮次（结算监听会把子代理上一轮的旧结果重复交付），修复后重试正确等待新一轮完成；调度卡片新增耗时、token 用量与失败分类显示

### English
- Swarm failure classification: item failures are classified as transport/content/structural from the child session's error code — only transient transport failures (rate limit, disconnects, timeouts) throttle the batch pool and qualify for auto-retry; task-level refusals or unsound calls no longer drag down the whole batch's throughput; quota exhaustion throttles without pointless retries, and a fully failed batch now suggests the actionable next step per failure class
- Swarm split quality: new `shared_context` (write shared background once, injected into every child), `dry_run` (validate and preview each child's full prompt without running anything), and split-quality hints (stub or vague items return improvement suggestions with the result); the system prompt gains good/bad split examples
- Swarm batch token budget: once the `token_budget` argument or config value is spent, the batch stops launching new work (in-flight children settle normally), and unstarted items report aborted with their childId preserved for later resume; results now carry per-item duration, failure class, error code, token usage, plus batch totals
- Swarm adaptive scheduling upgrade: unpinned batches may probe past the configured concurrency ceiling (up to 64) on sustained clean completions, and a probe failure ratchets the exploration bound down so the batch stops rediscovering the same wall; an explicit `max_concurrency` pins the pool strictly; shipped defaults move to 8 initial / 16 ceiling concurrency and a 1s launch stagger
- Swarm settings page: a new 并行子代理 settings section edits the enable toggle, adaptive toggle, and every scheduling knob visually — saved values apply to the next swarm call with no restart (only enable/disable needs one); user configuration persists in its own file, no longer overwritten by app updates
- Swarm fixes: auto-retry never actually waited for the retry epoch (the settlement watcher re-delivered the child's previous terminal result) — retries now correctly await the new epoch; the batch card additionally shows duration, token usage, and failure classes

## [v0.8.1] - 2026-09-03

### 中文
- 会话归档修复：归档管理器在内核 rc 线上不再报"读取归档会话失败"（适配投影缓存 `cachedSnapshot` 必传的 inheritedEventCount 参数），日志完好的归档会话不再被误判为"无日志记录"（兼容 alpha/rc 两代内核 `list()` 的不同返回形状，删除与清理路径同步修复）

### English
- Session archives fix: the archive manager no longer fails with "failed to read archived sessions" on the rc kernel line (adapting to the projection cache `cachedSnapshot`'s required inheritedEventCount argument), and archived sessions with intact logs are no longer misclassified as stale "no-log records" (normalizing the different `list()` entry shapes across the alpha/rc kernel lines; delete and prune paths fixed alike)

## [v0.8.0] - 2026-09-03

### 中文
- 快速文件搜索（plugin-fff）：新增 `fffind` / `ffgrep` / `fff-glob` 三个工具——基于 FFF 原生搜索引擎（Rust C 引擎，平台二进制随内核运行时分发），支持模糊文件/目录路径搜索、文件内容检索与 glob 匹配，性能数倍于常用 glob 实现；索引按会话工作区隔离复用，搜索结果只返回工作区内的相对路径，不越权读取工作区之外
- 插件套件扩展为 8 个插件：plugin-fff 的运行时依赖（FFF 原生绑定）随内核运行时安装，内核/套件更新照常解耦；新增探针脚本 `probe-fff.mjs` 覆盖三个工具的成功路径与错误分支

### English
- Fast file search (plugin-fff): new `fffind` / `ffgrep` / `fff-glob` tools — built on the FFF native search engine (Rust C library, platform binaries shipped with the kernel runtime), covering fuzzy file/directory path search, content grep and glob matching, an order of magnitude faster than typical glob implementations; per-workspace shared indexes, and results are only ever relative paths inside the session's workspace — nothing outside is read
- Plugin suite grows to 8 plugins: plugin-fff's runtime dependency (the FFF native binding) installs with the kernel runtime, keeping kernel/suite updates decoupled as usual; a new probe script `probe-fff.mjs` covers all three tools' happy paths and error branches

## [v0.7.9] - 2026-09-03

### 中文
- 并行子代理（swarm）：新增 `tool_filter` 参数——批量任务可为每个子代理限定工具集（如只读批量仅保留读/搜索工具），批量分析、审阅、查找不再有子代理误写文件的风险；不指定时维持原行为（全工具集），恢复（resume）的子代理沿用其创建时的工具集
- 插件套件工程：7 个插件的 `@deepseek-ai/*` 开发依赖与内核 rc 线对齐，移除四个插件陈旧的独立 node_modules/lockfile（其 alpha.3 双实例导致插件 typecheck 长期报错）；swarm 适配内核 rc.1 的 subagent API（`followup` → `sendMessage`，会话事件读取改为结构化切片）——全部插件 typecheck 与 build 全绿

### English
- Swarm: new `tool_filter` parameter — scope every child's tool set per batch (e.g. keep only read/search tools for read-only batches), so analysis/review/lookup batches no longer risk a child writing files the parent never audits; omitting it keeps the previous full-tool behavior, and resumed children keep the tool set they were created with
- Plugin suite engineering: all 7 plugins' `@deepseek-ai/*` devDependencies are aligned with the kernel rc line, and the four plugins' stale standalone node_modules/lockfiles were removed (their alpha.3 dual instances had kept plugin typecheck red); swarm was migrated to the rc.1 subagent API (`followup` → `sendMessage`, session event log read via a structural slice) — every plugin now typechecks and builds green

## [v0.7.8] - 2026-09-03

### 中文
- 内核升级至 dsh 0.1.2-rc.1：上游 0.1.2 版本线已从 alpha 推进到 rc 阶段（发布在 npm `next` 通道）；CI 打包通道同步从 alpha 切到 beta（next），未来发版自动跟随 rc 线最新版本
- 内核更新检查不再被钉在旧预发布线上：预发布内核（alpha/rc）现在跨 alpha/next/latest 三个通道查询并跟随最高版本，上游换线（如 alpha → rc）后用户能自动跟上，不再受困于已停更的旧线；稳定版内核行为不变（仍只跟随正式版通道）

### English
- Kernel upgraded to dsh 0.1.2-rc.1: the upstream 0.1.2 line has moved from alpha to rc (published on the npm `next` tag); the CI packaging channel switches from alpha to beta (next) so future releases automatically follow the newest rc build
- Kernel update checks no longer strand users on a stale prerelease line: prerelease kernels (alpha/rc) now query all three dist-tags (alpha/next/latest) and follow the highest version, so users automatically keep up when upstream moves a line forward (e.g. alpha → rc); stable kernels are unchanged (still follow the formal-release tag only)

## [v0.7.7] - 2026-09-03

### 中文
- 记忆插件（会话记忆）：注入策略升级为「每分类保留最新 + 固定优先」——全局/项目记忆不再整文件尾部截断，五类条目按配额各保其最新 N 条，单类不会挤占其他类别；固定条目在任何预算下都注入
- 记忆插件：新增条目「固定」——设置页固定（📌）的条目始终随会话注入、不受注入预算截断影响；全局与各项目拥有独立固定集；新增条目级删除（精确内容匹配，不误伤仅含相同片段的其他条目）
- 记忆插件：新增后台整理器（curator）——后台提炼保存条目后自动合并近义条目、清理过时条目、修正分类，记忆文件不再单向膨胀；整理提案由只读子代理提出、宿主逐条验证后原子落盘
- 记忆插件：设置页条目列表可折叠——全局默认显示最近 5 条、可展开查看全部；项目记忆可展开逐条明细并逐条固定/删除
- 记忆插件修复：无工作目录的会话也能沉淀全局偏好（此前被直接跳过）；后台提炼去重从「子串误杀」改为内容精确匹配（如已有「用 pnpm 跑 typecheck」不再吞掉「用 pnpm」）；设置页跨源请求由挂起改为 403 明确拒绝；整理器单轮编辑上限在两个阶段都生效
- 记忆插件工程：新增 25 个单测（`npm test`），覆盖注入选择、固定、蒸馏去重与整理器编辑验证；插件套件 README/AGENTS 插件清单与论坛帖记忆描述同步修正

### English
- Memory plugin: injection upgraded to "newest-per-category + pinned-first" — the global/project files are no longer tail-truncated wholesale; each of the five categories keeps its newest quota so one category cannot crowd out another; pinned entries inject under any budget
- Memory plugin: entry pinning — a pinned (📌) entry is always injected, immune to the injection budget; the global file and each project have independent pin sets; plus per-entry delete (exact-content, never hits rows that merely share a phrase)
- Memory plugin: new background curator — after the distiller saves entries, it merges near-duplicates, prunes stale entries and re-categorizes, so a memory file no longer grows monotonically; a read-only subagent proposes edits and the host validates each before an atomic rewrite
- Memory plugin: foldable entry lists in settings — global shows the newest 5 by default with an expand-all toggle; projects expand into per-entry rows with pin/delete
- Memory plugin fixes: sessions without a workspace now distill global preferences too (previously skipped); distill dedupe is exact-content instead of substring ("用 pnpm" no longer gets eaten by a stored "用 pnpm 跑 typecheck"); cross-origin settings requests answer 403 instead of hanging; the curator's per-run edit cap applies in both stages
- Memory plugin engineering: 25 unit tests shipped (`npm test`) covering injection selection, pinning, distill dedupe and curator edit validation; plugin-suite README/AGENTS plugin lists and the forum post's memory description are synced

## [v0.7.6] - 2026-09-02

### 中文
- 升级内置内核至 dsh 0.1.2-alpha.4：shell 依赖、内核运行时与插件套件全部对齐 alpha 通道最新版（内核更新与 shell 更新保持解耦，alpha.4 运行时产物随本版本重新构建发布）
- 记忆插件（会话记忆）：后台提炼静默窗口统一为 1 分钟——代码早已生效，设置页 3 处「5 分钟」文案此前未同步，本次对齐（开关提示、副文案、最近提炼说明）
- 记忆插件：设置页「最近提炼」记录改为折叠展示——默认显示最近 5 条，超出显示「查看全部（N 条）」可一键展开/收起
- 记忆插件：修复「最近提炼」记录中来源会话全部显示为「session-」的问题——短 id 此前截取的是会话 ID 的词缀而非 UUID 段，现显示真实 UUID 前 8 位（如 49ce2455），跨记录可区分；后台提炼子代理的工作流标签同步修复

### English
- Upgraded the bundled kernel to dsh 0.1.2-alpha.4: the shell deps, kernel runtime and the plugin suite now all align with the latest alpha channel (kernel updates stay decoupled from shell updates; the alpha.4 runtime artifacts are rebuilt and republished with this release)
- Memory plugin (cross-session memory): the background-distill quiet window is now uniformly 1 minute — the code was already live, but three spots of the settings copy still said "5 minutes" and are now in sync (toggle notice, hint, and the "最近提炼" note)
- Memory plugin: the "最近提炼" (recent distill) list in settings now folds — 5 rows show by default and a "查看全部（N 条）" button expands/collapses beyond that
- Memory plugin: fixed the "最近提炼" rows all showing "session-" as the source session — the short id previously sliced the session-id prefix instead of the UUID segment; rows now show the first 8 hex of the real UUID (e.g. 49ce2455) and are distinguishable; the background-distill subagent's workflow label is fixed the same way

## [v0.7.5] - 2026-09-01

### 中文
- 修复内核重复解压导致的启动卡顿：启动时的内置内核漂移检查用 tarball 哈希比较，而同一版本内核的 tarball 无法跨构建字节复现（文件时间戳/顺序不同）——两次构建的同一版本哈希不同，检查每启动都判定「内容漂移」并重新解压约 1 万个小文件，启动出现分钟的等待与重复「解压完成」。现改为比较语义标识 `(dshVersion, suiteVersion)`（运行时与内置 manifest 均携带，suiteVersion 是 suite 内容的稳定指纹）：同版本直接启动不再解压，suite 真实变化或 dsh 版本升级仍会重新激活

### English
- Fixed the startup stall from repeated kernel extraction: the boot-time bundled drift check compared tarball sha512s, but a packaged runtime tarball is not byte-reproducible across builds (file mtimes/order differ) — two builds of the same version hash differently, so the check judged every boot as content drift and re-extracted ~10k small files, causing minutes of startup and a repeated "解压完成". It now compares the semantic identity `(dshVersion, suiteVersion)` (carried by both the runtime and bundled manifest; suiteVersion is the stable suite-content fingerprint): a same-version install boots without extraction, while a genuinely changed suite or a newer dsh still re-activates

## [v0.7.4] - 2026-09-01

### 中文
- 修复插件设置卡片无法点击：桌面 chrome 的拖拽区规则把官方插件卡头部（header 按钮）也标成了窗口拖动区，真实鼠标点击被原生拖拽吞掉——现在 header 按钮自身退出拖拽区，空白区域仍可拖动窗口
- 插件套件遗留适配修复：模型高级设置页补上 `remote.llm`/`remote.settings` 注入声明（Cordis 拒绝未声明的嵌套服务访问，此前页面报「加载失败」）；热力图格子的原生 title 移除，只保留主题化自定义 tooltip；新会话页鲸鱼背景的 hero 定位匹配 alpha.3 的 DIV 输入框（此前选择器只认 textarea，鲸鱼偏左）
- 关闭窗口改为三次选择弹窗：最小化到托盘 / 退出程序 / 取消——退出不再是静默动作，默认最小化到托盘（Enter），Esc 取消
- 确认与通知弹窗全部主题化：关闭、内核更新可用、应用更新流程、各失败与状态提示统一走注入式弹窗（颜色取自官方 `--dsw-alias-*` 主题令牌，浅色/深色自动适配）；页面不可用（未加载/崩溃）时回退系统原生框，保证任何情况都有消息
- 品牌插件链接加入所有权护栅：`$DSH_HOME/profiles/node_modules/@dsh-app` 下与用户安装的真实包同名时会跳过而非删除，避免误删用户数据

### English
- Fixed the plugin settings cards not opening: the desktop chrome drag-region rule also marked official plugin card headers (button headers) as window drag regions, so real mouse clicks were swallowed by the native drag handling — header buttons now opt out of the drag region while blank header areas still drag the window
- Remaining suite adaptation fixes: the Advanced Models page declares `remote.llm`/`remote.settings` in its inject (Cordis refuses undeclared nested service access, which previously failed the page load); the usage heatmap drops the native title and keeps only the themed custom tooltip; the whale hero layout matches the alpha.3 DIV input bar (the old selector only matched a textarea, leaving the whale off-center)
- Closing the window now prompts a three-way choice: minimize to tray / quit / cancel — quitting is no longer a silent act; the default is minimize to tray (Enter), Esc cancels
- All confirmation and notice dialogs are themed: close, kernel update available, app update flow, and every failure/status notice go through the injected dialog (colors from the official `--dsw-alias-*` theme tokens, light/dark auto-adaptive); when the page is unavailable (not loaded or crashed) it falls back to the native box so a message is always shown
- Suite plugin links now carry an ownership fence: a real package a user installed under `$DSH_HOME/profiles/node_modules/@dsh-app` is skipped rather than deleted instead of being silently removed

## [v0.7.3] - 2026-09-01

### 中文
- 内核升级至 dsh 0.1.2-alpha.3，新增 alpha 内核更新通道（`DSH_APP_CHANNEL=alpha` 解析 npm `alpha` dist-tag）；预发布版本自动按版本类型走对应通道（alpha→alpha，rc→beta）
- 插件套件完整适配 alpha.3：上游移除了 dsh-client-runtime 并重构 client 运行时，7 个插件全部迁移到新的 Cordis Context/ctx.remote/dsh-client-store 体系；模型高级设置页改用官方 joinProviderDirectory 目录（host 模型目录上游已删除，hand-declared 路由整表编辑保持不变）
- 修复服务器健康检查误判：dsh web 以 303 + Set-Cookie + Location 交换会话 cookie，健康轮询此前因无 cookie jar 落到裸 `/` 拿到 401，90 秒超时后误杀健康服务——现在手动完成 token→cookie 交换后再探测
- 移除品牌 minimap：上游官方 turn rail（全历史分页、点击跳转）已覆盖同功能，683 行组件与配套探针脚本一并退役

### English
- Kernel updated to dsh 0.1.2-alpha.3, with a new alpha kernel update channel (`DSH_APP_CHANNEL=alpha` resolves the npm `alpha` dist-tag); prerelease builds now auto-select their matching channel (alpha→alpha, rc→beta)
- The plugin suite is fully adapted to alpha.3: upstream removed dsh-client-runtime and rebuilt the client runtime, so all seven plugins now use the Cordis Context / ctx.remote / dsh-client-store system; the Advanced Models page joins the configurable-provider directory like the official page (the host model catalog was removed upstream; hand-declared route full-table editing is unchanged)
- Fixed the server health check misfiring: dsh web exchanges the session cookie via 303 + Set-Cookie + Location, and the probe (no cookie jar) previously followed the redirect onto the naked `/`, got 401, and killed a healthy server after a 90-second timeout — it now completes the token→cookie exchange before probing
- Retired the brand minimap: the upstream turn rail (full-history paging, click-to-jump) covers the same feature, so the 683-line component and its probe script are removed

## [v0.7.2] - 2026-08-28

### 中文
- 修复 Git 页与文件页的深色主题适配：提交/确认按钮文字不再隐形（近白底白字 → 成对前景令牌）；图谱弹窗、还原确认框、分支菜单及其遮罩、投影统一为中性黑色系（不再泛蓝灰）；diff 增删行、状态提示与文件树选中行颜色随主题令牌自动适配
- 修复链接跳转：`127.0.0.1:<其他端口>`（如本地开发服务器）等非 dsh 服务的链接不再在应用窗口内打开，一律改用系统默认浏览器打开

### English
- Dark-theme fixes for the Git and file views: commit/confirm buttons no longer render invisible text (near-white on near-white → paired foreground token); the graph modal, restore confirm, branch menu, their mask and shadows now use the neutral black palette (no more blue-grey cast); diff add/del lines, status notices and the file-tree selected row follow the theme tokens
- Link handling fix: off-origin links such as `127.0.0.1:<other port>` (e.g. a local dev server) no longer load inside the app window; they open in the system default browser

## [v0.7.1] - 2026-08-28

### 中文
- 修复内核崩溃重启循环：回滚/捆绑重装成功不再重置重启计数——配置类崩溃（如损坏的补丁层）能存活恢复时会反复弹退出提示，现在只有真正就绪的服务会重置计数，恢复动作不再触发循环；捆绑重装每次启动只尝试一次，放弃时对话框指向安装目录的日志文件夹
- 修复高级设置页主按钮在暗色主题下显示为空白块：文字颜色硬编码 `#fff` 与近白背景令牌冲突；改用成对前景令牌 `--dsw-alias-label-primary-foreground`（浅色 #fff / 深色墨色），与原生主按钮同一配方
- 模型高级设置页：声明推理强度自动填充兼容开关（`supportsDeveloperRole` false + `maxTokensField`）——私有网关被误识别为 OpenAI 会把系统提示切到 developer 角色，多数网关以 400 拒绝；填充仅做增量，已有键与用户显式设置均保留

### English
- Fixed the kernel crash restart loop: rollback and bundled reinstall no longer reset the restart counter — a config-driven crash that survives recovery (e.g. a broken patch layer) previously looped forever, re-showing the exit toast every few seconds; only a genuinely ready server resets the counter now, the bundled reinstall runs at most once per app run, and the give-up dialog points at the install-dir logs folder
- Fixed the Advanced Models page primary button rendering as a blank block in the dark theme: the text color was hardcoded `#fff` against a near-white background token; it now uses the paired foreground token `--dsw-alias-label-primary-foreground` (light #fff / dark ink), the same recipe as the native primary button
- Advanced Models page: declaring a reasoning level now auto-fills the compat switches (`supportsDeveloperRole` false + `maxTokensField`) — pi-ai treats an unidentified private gateway as OpenAI itself, switching the system prompt to the developer role, which most gateways reject with a 400; the fill is additive only and never overwrites existing keys or explicit user values

## [v0.7.0] - 2026-08-26

### 中文
- 新增跨会话记忆（plugin-memory）：`memory_save`/`memory_recall`/`memory_forget` 工具 + 系统提示注入全局/项目记忆文件（预算内最新优先）；设置页开关；后台蒸馏器在会话静默 5 分钟后经只读子代理回填要点（进度轨迹、定时器可安全关闭）
- 新增品牌鲸鱼背景：空闲静态帧、悬停时指针散开（指针离开即暂停渲染循环，滚动不卡顿）；主题感知对比度（亮色增强可读性、暗色低透明度水印）；悬停悬浮于输入框上方、活跃时放大并居中于会话列
- 用量余额缓存：5 分钟 TTL + single-flight 并发合并；挂载时静默刷新、点击余额卡强制重查；修复刷新循环卡在加载态的问题
- 归档删除修复：此前打开过的归档会话被误判为活跃而无法删除；删除围栏改为只拦有进行中轮次/start 的会话（与上游分叉边界一致），store 中缺席的会话视为可删除
- 归档管理增强：项目分组可折叠（键盘支持）；过期归档自动清理；通知区改为中性背景 + 错误边框，主题对比度更好
- 侧边栏 Git 面板健壮性：选中文件时列表与滚动位置保持稳定（底部条目不再被压缩）；同步操作解析默认远端、无远端时给出中文提示，pull 无上游时按 git 提示显式 fetch 远端/分支，输出限界、无变更时显示「已是最新」

### English
- New cross-session memory (plugin-memory): `memory_save`/`memory_recall`/`memory_forget` tools plus system-prompt injection of global/per-project memory files (newest first under budgets); settings-page toggles; a background distiller backfills quiet sessions after 5 minutes through a read-only subagent (progress traces, shutdown-safe timers)
- New brand whale background: static frame at idle, hover-only pointer scatter (the render loop parks when the pointer leaves — no scroll jank); theme-aware contrast (light boost for legibility, dark low-alpha watermark); hovers above the composer, active phase enlarges and centers on the conversation column
- Usage balance caching: 5-minute TTL with single-flight coalescing; silent refresh on mount, forced re-query on card click; fixes a refresh loop that stuck in the loading state
- Archive deletion fix: previously-opened archived sessions were judged live and undeletable; the deletion fence now skips only sessions with an open turn/start (the same test the upstream fork boundary uses), and sessions absent from the store are treated as deletable
- Archive manager enhancements: project groups are collapsible (keyboard support); stale archive ids are pruned; notices use a neutral background with an error border for better theme contrast
- Sidebar Git panel robustness: the file list keeps its identity and scroll position on selection (bottom entries no longer squeezed); sync operations resolve a default remote with zh-CN errors when none exists, pull without an upstream fetches remote/branch explicitly like git hints, and bounded output reports 「已是最新」 when idle

## [v0.6.0] - 2026-08-26

### 中文
- 新增 usage 插件：设置页新增余额卡、每日使用热度图与趋势图——统计官方 deepseek providers 的消耗，按闲时/高峰双档计价（CNY）；余额经 host 侧代理查询官方接口，API 密钥不离开主机（走 dsh 凭证服务）
- 新增 archives 插件：会话归档管理——按项目工作目录分组展示已归档的非活跃会话，可折叠面板、两次确认删除并展示跳过原因；兼容归档集后端 locate() 返回未定义的情况
- 内核启动提速与可重现运行包：运行包可重现化（时间戳归一），启动时内容校验一致即跳过重新解压；解压过程按文件计数报告进度；套件内容变化自动落入新版本目录，回滚仍可用
- 设置页头部恢复原生轴线：拖拽带收窄至 20px、标题行本身可拖拽，关闭/打开设置按钮回到原生位置并与导航标题同轴
- usage 导航图标与原生设置图标对齐：齿轮替换为 16 网格柱状图字形（CSS mask），跟随色彩与导航激活态，亮暗主题下均按原生尺寸渲染

### English
- New usage plugin: a balance card, daily heatmap and trend chart in the settings page — usage is metered for official deepseek providers in CNY with idle/peak dual-tier pricing; the balance is fetched through a host-side proxy of the official API and the key never leaves the host (dsh credential store)
- New archives plugin: session archive management — archived non-live sessions are grouped by project cwd with collapsible panels, two-step delete confirm and skip reasons; persistence backends whose locate() returns undefined are tolerated
- Faster kernel boot with reproducible runtime packs: tarballs are reproducible (normalized timestamps), so boot skips re-extraction when the content hash matches; extraction reports file-count progress; suite content changes land in a fresh versioned dir while rollback stays available
- Settings header restored to the native axis: the drag strip narrows to 20px and the header row itself drags, so the close/open-config buttons sit at their native position on the same axis as the nav title
- Usage nav icon aligned with native settings icons: the gear becomes a 16-grid bar-chart glyph via CSS mask, following the current color and nav active state at native size in both light and dark themes

## [v0.5.0] - 2026-08-25

### 中文
- 新增 plugin-swarm：自适应批量子代理编排——独立子任务并行派发给可继续的子代理，自适应并发门控（失败收缩、连续成功增长）、保留会话的逐项自动重试、按子代理标识恢复
- 模型高级设置页与 provider 配置对齐：新增 dsh provider 模型发现与目录感知的模型编辑（保护目录外模型、保留合法 provider 路由组合）；原生设置栏下方预留空间，不再与页面头部重叠
- 模型页新增 provider 重试策略卡片：模式、最大重试、初始/最大延迟、抖动比均可选（留空回落到 dsh 默认值）；跨字段中文校验（含初始延迟 ≤ 最大延迟的隐含规则）；恢复默认即取消该键；摘要行显示生效策略，保存独立于模型列表编辑器，互不覆盖
- 应用更新卡片进度动画修复：同进度阶段的状态更新改为原位补丁（消息 + 进度条宽度），不再重建卡片导致加载图标旋转重启；进度条在确定性/非确定性阶段切换时按需创建/移除；淡出窗口内的新状态会取消待移除；更新器进度回调增加节流
- 对话 minimap 流式期间悬停保持：流式增量替换聊天快照时，悬停状态按跟踪键序列对齐（中心随新序列重映射），不再因流式更新而拆掉悬停预览
- 导出文件完成后对话框自动关闭并提示保存路径；失败时保持打开并说明原因
- dev 模式手动检查应用更新：只读探测更新通道（官方/镜像链）并在对话框报告结论；dev 构建仍禁用安装

### English
- New plugin-swarm: adaptive batch subagent orchestration — independent subtasks fan out to parallel continuable children with an adaptive concurrency gate (shrinks on failure, grows on clean streaks), per-item auto-retry on preserved sessions, and resume by child id
- Advanced Models page now aligns with provider configuration: dsh provider model discovery and catalog-aware model editing (off-catalog models guarded, valid provider route combinations preserved); reserved space below the native settings chrome so the page header no longer overlaps
- Provider retry policy card in the Advanced Models page: mode, max retries, initial/max delay and jitter ratio are all optional (blank fields fall back to the harness defaults); cross-field Chinese validation including the implied initialDelayMs ≤ maxDelayMs rule; revert-to-default unsets the key; the summary line shows the effective policy and saving is independent from the model-list editor so the two never clobber each other
- App update-card progress animation fix: same-phase status updates now patch message and bar width in place instead of rebuilding the card, which restarted the loader icon's rotation; the bar is created/removed on phase changes between determinate and indeterminate; a status arriving inside the fade window cancels the pending removal; the updater progress callback is throttled
- Conversation minimap hover survives streaming: when stream increments replace the chat snapshot, hover is remapped against the tracked-key sequence instead of being torn down
- Export dialog auto-closes on save and toasts the saved path; on failure it stays open with a reason
- On dev builds the manual app-update check now runs a read-only probe through the official/mirror chain and reports the verdict in a dialog (install stays disabled)

## [v0.4.0] - 2026-08-23

### 中文
- Git 页全面增强：会话级仓库隔离（host 按会话反查工作目录，拒绝伪造 session/路径穿越）、index/worktree 混合状态显示（如 MM）、重命名/复制路径、未跟踪文件 diff、全部暂存/取消暂存、大 diff 与大文件列表体量保护、还原文件确认弹窗、请求代际保护（旧响应不覆盖当前会话）、分离头提示、键盘与触摸操作；变化行操作区固定宽度，悬停不再布局抖动
- 文件页 Markdown 预览支持本地图片：相对路径图片（README 徽章等）自动经内置文件接口渲染，不再 404；目录树展开/收缩命中更可靠（三角与整行点击一致）
- 对话 minimap 交互升级：默认全部短线，悬停启用中心放大与邻近渐变（160ms 顺滑缓动），移出恢复；滚动事件逐帧合并、滚动停止后再测量，长会话快速滚动不掉帧；鼠标经过刻度间隙预览不再闪断，悬停期间布局冻结

### English
- Git page overhauls: session-scoped repo isolation (host resolves cwd from the session, rejecting forged sessions/path traversal), split index/worktree states (MM etc.), rename/copy paths, untracked diffs, stage-all / unstage-all, size guards for large diffs and lists, restore confirmation, request-generation guards (stale responses never overwrite the current session), detached-head hint, keyboard and touch support; row action areas are fixed-width so hover no longer jitters layout
- The file page's Markdown preview now renders local images: relative paths (README badges etc.) are served through the built-in file endpoint instead of 404ing; directory expansion/collapse hit areas are reliable (chevron and row clicks agree)
- Conversation minimap interaction upgrade: all short bars by default, hover enables center growth with neighbor taper (160ms smooth easing), release restores; scroll events coalesce per frame and measurement waits for scrolling to settle, so long chats scroll without frame drops; hover preview no longer blinks across tick gaps and layout freezes while hovering

## [v0.3.2] - 2026-08-23

### 中文
- 应用更新改为可视安装向导：下载完成后关闭当前应用并打开安装向导（与首次安装相同），安装进度全程可见；完成后自动启动应用，安装包自动删除

### English
- App updates now run the visible NSIS install wizard: after download the app quits and the same installer flow as a first-time install opens, so progress is fully visible; the app relaunches on completion and the installer file is deleted afterwards

## [v0.3.1] - 2026-08-23

### 中文
- 修复升级安装后品牌插件全部失效的问题：新版本内置运行时内容变化（如新增插件套件）但内核目录同名时会被直接复用，新内容从未生效；现在启动时会检测内置运行时内容变化并自动重新激活（此前内置安装仅首次启动触发）
- 应用静默更新：安装包下载完成后自动删除，不再残留于系统临时目录

### English
- Fixed all brand plugins disappearing after an upgrade: a new bundled runtime whose content changed under the same kernel version was never applied because the same-named kernel dir was reused verbatim; the shell now detects bundled content drift on boot and re-activates it (previously the bundled install ran only on first launch)
- Silent app updates now delete the downloaded installer automatically, no longer leaving it in the system temp directory

## [v0.3.0] - 2026-08-23

### 中文
- 新增会话侧边栏（会话页「文件」「Git」两个原生视图）：文件页浏览工作区目录树并预览文本与图片；Git 页按目录分组展示变更、双行号统一 diff 预览、暂存/还原/提交、仓库文件列表，以及居中 Git 图谱——点击提交查看完整正文与文件统计
- 文件页 Markdown 预览：`.md` 文件按 GFM + HTML 渲染（标题、表格、任务列表、徽章对齐），HTML 经安全过滤（脚本与事件属性剥离）
- 新增模型高级设置页：为 llm-pi-ai 模型提供模型级编辑器与整表管理（推理强度、输入模态、兼容性开关），支持目录外模型的伴生路由迁移，models.dev 数据源表单预填
- models.dev 表单预填增加 gh-proxy 镜像回退：直连失败时自动尝试镜像，国内网络也可加载模型目录
- 对话 minimap 优化：刻度条加高、间距加大，悬停高亮跟随鼠标，仅「对话」页面显示，超长会话自动压缩间距

### English
- New conversation sidebar with two native views: the 文件 page browses the workspace tree and previews text and images; the Git page groups changes by directory, previews unified diffs with dual line numbers, stages/restores/commits, lists tracked files, and shows a centered graph modal — click a commit for its full message and file stat
- Markdown preview in the file page: `.md` files render as GFM + HTML (headings, tables, task lists, badge alignment) with a sanitize pass that strips scripts and event handlers
- New advanced models settings page: model-level editors and whole-list management for llm-pi-ai models (reasoning effort, input modalities, compatibility switches), companion-route migration for off-catalog models, and models.dev feed prefill
- The models.dev prefill now falls back to a gh-proxy mirror when the direct feed is unreachable, so the catalog loads on mainland networks too
- Conversation minimap polish: taller bars with wider spacing, hover highlight follows the cursor, rendered only on the 对话 view, and pitch compresses on long chats

## [v0.2.0] - 2026-08-22

### 中文
- 修复内核更新期间服务重启可能中断下载的问题：升级过程中的清理不再触碰正在写入的下载缓存（staging），更新不会再因「找不到文件」而失败

### English
- Fixed kernel updates being interrupted by a server restart: cleanup no longer touches the in-flight download staging directory, so updates no longer fail with a missing-file error

## [v0.1.9] - 2026-08-21

### 中文
- 内置内核更新至当前最新版 dsh 0.1.1-rc.2，全新安装即激活最新内核，无需再联网更新
- 修复内核在线更新必然失败的问题：运行时产物改挂专属 `runtime-<内核版本>` 发布标签，构建未指定内核版本时自动解析 npm dist-tag，产物与注册表对齐；产物尚未发布时提示「安装包尚未发布」而非报错
- 内核更新与应用更新新增窗口内进度卡片（下载百分比/阶段状态/成功与错误提示），后台自动检查更新不再弹出模态框，改为非打扰式提示
- Windows 应用更新改走镜像链路：检测 latest.yml 按系统架构选包，官方直链优先、gh-proxy.com 镜像回退，sha512 校验后静默安装并退出应用
- 托盘与应用通知中内核更新的后台检查不再打断使用

### English
- Bundled kernel updated to the latest dsh 0.1.1-rc.2: a fresh install activates the newest kernel directly, with no online update needed
- Fixed kernel online updates always failing: runtime artifacts now attach to dedicated `runtime-<kernel-version>` release tags, and an unspecified kernel version resolves the npm dist-tag at build time so artifacts match the registry; when artifacts are not yet published the app shows「安装包尚未发布」instead of an error
- Kernel and app updates now show an in-window progress card (download percentage / phase status / success and error notices); background update checks no longer pop modal dialogs, using a non-intrusive notice instead
- Windows app updates now use a mirror chain: detect latest.yml, pick the installer for the system arch, official URL first with gh-proxy.com mirror fallback, verify sha512, then silently install and quit the app
- Background kernel checks no longer interrupt the user with dialogs

## [v0.1.8] - 2026-08-21

### 中文
- 移除启动时的内核初始化过渡窗口，内核安装/修复改为后台静默执行；内核就绪时启动不再弹窗闪屏，直接进入主界面

### English
- Removed the launch transition window; kernel install/repair now runs silently in the background, so a healthy kernel starts straight into the app with no flashing window

## [v0.1.7] - 2026-08-20

### 中文
- 对话页新增 minimap：会话左侧固定节点导航栏，每条用户消息一个节点，悬停预览、点击跳转，当前阅读位置高亮
- 修复开发模式可能误删内置内核目录的问题，dev 模式不再触碰生产内核安装
- 开发模式不再弹出内核安装过渡窗口，新增 `npm run dev` 跨平台一键启动（自动定位本地 harness 内核源码）
- 内核在线下载源默认指向本仓库，全新安装无需额外配置即可获取内核
- 插件依赖与文档统一对齐 dsh 0.1.0-rc.8

### English
- New conversation minimap: a fixed node rail on the left of the chat view, one node per user/steering/context message, hover preview, click to jump, reading position highlighted
- Fixed dev mode wiping the bundled kernel directory — dev boots no longer touch the production kernel install
- Dev mode no longer shows the kernel-setup transition window; added `npm run dev` cross-platform launcher that auto-locates the local harness checkout
- Online kernel downloads now default to this repo's release artifacts, so fresh installs resolve a kernel without extra env config
- Plugin dependencies and docs aligned to dsh 0.1.0-rc.8

## [v0.1.6] - 2026-08-20

### 中文
- 品牌名称统一为 DSH APP（窗口标题、托盘、安装器与文档）；用户数据目录固定到 DSH APP 并自动迁移旧目录，已安装内核与设置无缝保留
- 启动提速：内核加载期间立即显示启动过渡窗口，感知启动明显更快；精简内核加载路径、健康检查轮询更灵敏
- 发布流程文档化（AGENTS.md §10），新增增量中英双语 release notes 生成器，此后版本说明只展示相对上一版的变更

### English
- Unified the brand to DSH APP everywhere (window, tray, installer, docs); user data directory is pinned to DSH APP with a one-time migration, so existing kernels and settings carry over seamlessly
- Faster perceived startup: a launch transition window now appears while the kernel boots; simplified the kernel load path and made health checks more responsive
- Documented the release workflow (AGENTS.md §10) and added a generator for incremental bilingual release notes — future notes show only what changed since the previous version
