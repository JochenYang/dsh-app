# Changelog

DSH APP 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更（不含历史全量），
与 GitHub Release 的 release notes 保持一致。发布流程见 `AGENTS.md` §10。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.7]`），然后运行
`node scripts/gen-release-notes.mjs v0.1.7` 生成双语 notes。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，新条目加在列表顶部。

## [Unreleased]

### 中文
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
