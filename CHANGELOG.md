# Changelog

DSH APP 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更（不含历史全量），
与 GitHub Release 的 release notes 保持一致。发布流程见 `AGENTS.md` §10。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.7]`），然后运行
`node scripts/gen-release-notes.mjs v0.1.7` 生成双语 notes。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，新条目加在列表顶部。

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
