# 桌面端优化开发计划

> 2026-09-15。范围：打包 / 更新链 + 桌面端功能。**动手前先读 §4 不可回归清单。**
> 行号截至 2026-09-15。
>
> 已定决策：**不购买代码签名证书**（个人身份、不付费）→ 保持无签名分发，
> 只做零成本缓解（任务 0）。CI 里「有 secrets 才签」的条件分支保持原样，
> 将来若要买证书可直接接上，无需改代码结构。
>
> 相关立项：[capability-roadmap/desktop-shell-experience.md](capability-roadmap/desktop-shell-experience.md)。

## 0 任务清单

| #  | 改什么                               | 主要落点                                            | 依赖 | 验收           |
|----|--------------------------------------|-----------------------------------------------------|------|----------------|
| 0  | 无签名分发的零成本缓解               | `README.md` / 下载页文案                            | —    | 用户能照着走通 |
| 1  | 首启可见性：本地启动页                | 新增启动窗口 + `static/`                            | —    | §1 A2 小节     |
| 2  | 更新 UX 三平台一致                   | `src/main/updater.ts`、`update-card.ts`              | —    | §1 A3 小节     |
| 3  | runtime 资产进 ModelScope 镜像       | `publish-mirror.yml`、`sources/artifact.ts`          | —    | §2.1           |
| 4  | Windows shell 差分化                 | `src/main/updater.ts`                               | 3    | §2.2           |
| 5  | 内核分层 tgz                         | `scripts/build-runtime.mjs`、`src/kernel/manager.ts` | 3    | §2.3           |
| 6  | pnpm + lockfile 组装内核             | `scripts/build-runtime.mjs`                         | —    | §2.4           |
| 7  | 插件出 npm 包                        | `plugins/*`、`brand-suite.ts`                        | —    | §2.5           |
| 8  | 桌面差异化能力 C1–C5                 | 见 §3.1                                             | 1    | §3.1           |
| 9  | i18n                                 | shell 全部用户文案                                  | —    | §3.1 C6        |
| 10 | 护栏：打包冒烟 / 插件图校验 / CI 套件 | CI + `scripts/`                                     | —    | §3.2           |
| 11 | **筑网**：回归测试                    | `test/`、`ci.yml`                                    | —    | §5.2           |

**执行顺序见 §6。任务 11 是其余全部的前置。**

**进度**（2026-09-15）：✅ 11 筑网 —— CI 接入 `npm test`；新增 27 例（内核状态机 12、内置包采纳 10、
内核镜像链 5）。✅ 0 无签名分发缓解 —— README 中英双语加「下载与安装」章节。
✅ 1 首启可见性 —— `static/startup.html` + `src/main/startup-window.ts`（与主窗口同安全姿态：sandbox、
无 preload、**无 IPC**，状态经 `executeJavaScript` 注入），`boot()` 首行创建、主窗口可见后交接关闭，
失败卡提供 重试 / 打开日志目录 / 退出；既有启动顺序与恢复流程未改。
✅ 2 更新 UX 三平台一致 —— mac/Linux 复用共享三按钮对话框 + 同一进度卡 + 跳过持久化；
抽出纯逻辑 `decideUpdatePrompt` / `shouldRetireSkippedVersion`；Windows 分支逐条核对**等价**
（仅「已是最新」路径多一次本地 JSON 读）。✅ D1 打包产物冒烟 —— 新增 `scripts/smoke-package.mjs`
（15 项：asar 关键条目、`dist/static` 只许有启动页、内置内核三件套与目标平台匹配），已接入
`release.yml` 的 app job；对新产物 15/15 通过、对旧产物正确报错。`prepare-bundled-kernel.mjs`
缺 `manifest.json` 由**静默跳过改为失败退出**（否则内置包采纳会悄悄失效）。
✅ 3 runtime 进镜像 —— **3a** 内核 tarball 增加 ModelScope 传输候选（**元数据链保持只信官方**，
5 例锁定该不变量）；**3b** 发布侧完成：`mirror_release.py` 增加 runtime 独立流程（独立路径
`releases/runtime/<tag>/`、独立白名单、独立保留窗口 `keep_runtime_versions=3`、整表校验后才删），
`publish-mirror.yml` 新增独立 job（既有 `v*` 过滤未放宽），Python 用例 **91 通过**。
**未验证**：真实 ModelScope 上传/删除与 CI 实际触发（本机无凭据、未跑工作流）。

**测试现状**：`npm test` **114 例全绿**（52 + 层装配 14 + 静态图 7 + 服务守卫 8 + 在线层 15 + 桌面桥 13 + 失败分层 5），
`python .github/scripts/test_mirror_release.py` **102 例全绿**，`npm run typecheck` 干净；
13 个插件套件本地全绿（原报「1016 例」是我加错了，实际 **916**）+ plugin-brand **30 例**；
现在 **14 套共 946 例、0 失败**；`npm run check:graph` 干净。
✅ **6 pnpm 组装内核** —— `scripts/build-runtime.mjs` 改用 pnpm（`nodeLinker: hoisted`、overrides 钉核心包与
`file:` 插件、`minimumReleaseAge: 0` 抵消 pnpm 11 的 24h 冷静期否则结果随构建日期漂移、
`--package-import-method=copy` 否则 tar 写出 hardlink 条目 GNU tar 解不开），并产出**逐文件清单**
（`runtime/app/runtime-files.json`：path/size/mode/sha256，实测 25 449 条、抽查摘要与实体逐字节一致）。
**双产出对比**：基线 26 464 文件/339.5 MiB → 新 25 450/342.2 MiB，7 类差异**逐条解释**（提升位不同但
(name,version) 集合零版本差异；去掉死代码产生的 package-lock；新增清单；npm 强加过 4 个 optional peer、
pnpm 补上 4 个插件 peer）. 体积 100 834 761 → 101 266 666 B（+0.4%，其中清单 +1.14 MiB；不计清单约小 0.7 MiB）。
两跑同 sha512、产物自带 node 跑 `bin.js --version` ✓、`npm run verify -- --tgz` 60 项全过、
层拆分对新产物 `verify ok — 25450 files reproduced exactly`。
**我补的缺口**：CI 里原本**没有任何 pnpm**，而 `build-runtime.mjs` 现在强依赖 pnpm ≥10（`ci.yml` 的 smoke job
与 `release.yml` 的 6 cell 都在跑它）——已在两处加 `pnpm/action-setup@v4` 钉 11.7.0，否则镜像一变就可能每次发布都失败。
**未验证**：pnpm 10 分支；「无 registry 离线」不成立（file: 覆盖不需 registry，但闭包仍需下载）；
mac/linux/arm64 产物与 exec 位；CI 实跑。
✅ **C1/C3 桌面桥打通（诊断中心 MVP）** —— shell 侧 `desktop-bridge.ts`（loopback + bearer token +
Host/Origin 围栏 + 体量上限，13 例，含用**原始 socket** 手写请求验证 Host 围栏——`fetch` 不允许设 `Host`）；
启动链接线（`ensureDesktopBridge` + env 注入 + 退出先关桥——注意 A1 后桥已改为**不启动**）；
`plugin-brand` 在 Connection exact-Fetch 通道上暴露 host 路由
（五动作 + 可用性探测 + **日志尾**，30 例，其中用注入的 fs seam **量出「只读了 64 KiB」**而非只看返回对不对）；
`plugin-client-ui` 新增「诊断」设置页（桥状态 / 打开日志目录 / 日志尾，order 22——
原本与 plugin-websearch 的 14 撞号，我挪开了）。
**未验证**：设置页真机渲染（React 挂载、导航顺位、自动滚动）与三平台真实弹窗未测；
`plugin-client-ui` 的 `npm run typecheck` 有一个**既有**报错（`models-advanced/store.ts:157`，已用最小 tsconfig 复现证明与本次无关）。
✅ **C3 诊断中心（MVP + V2 导出）** —— 设置页三张卡（桥状态 / 打开日志目录 / 日志尾）+「导出诊断包」：
`plugin-brand` 组装**纯文本**诊断包（三个版本字段、日志目录、最近 500 行日志尾、以及「不含密钥/会话内容」的声明），
经桥的 `save-text-as` 存到用户选的位置。**包内容用参数传入的白名单**，报告生成模块**根本读不到 `process.env`**，
所以 token 与环境变量在结构上不可能进包（测试另用真实 token 断言文件中不含它）。plugin-brand **40 例**，
客户端导出卡片含三态（成功/取消/不支持）。**未验证**：Electron 里点一次「导出」→ 原生另存对话框的真机链路。
✅ **C4 部分（校验和展示 + 失败文案分层）** —— 启动页末尾新增一行「运行时已校验 · …」：**按这次安装实际用过的路径说话**
（tarball 安装给 `sha512` 前 16 位，层装配给「N 个层已逐层校验」，dev 模式**不显示**——那里什么都没校验，
宁可不说也不给一个这次没验过的摘要）。失败文案分层：新增 `src/kernel/failures.ts` 纯分类器 + 可行动文案
（`integrity` 摘要不符→「已中止以防被篡改，请更换网络」**不给「稍后重试」这种错误建议**；
`missing` HTTP 404→「尚未发布，稍后重试或从托盘重新检查」；`network` 无应答→「已尝试 N 个来源，请检查网络与代理」；
5xx 归为 network，与探测时的既有政策一致），已用在 tgz 与分层两条「候选源全部失败」的抛错点，5 例锁定。
剩余 C4：下载暂停/恢复（已完成，见下一条）。
✅ **C4 下载暂停/恢复（内核侧）** —— `pauseDownload()` / `resumeDownload()` / `isDownloadPaused()`：暂停只 abort 网络读、
保留已写字节与进度、状态用**新增的可选字段** `paused` 表达（**不新增 `KernelPhase` 取值**，避免打乱按 phase 分支的既有渲染）；
恢复用 `Range: bytes=<已收>-` 追加，且**仅当 206 且 Content-Range 起点等于偏移**才追加，否则截断重下——
这条是专门防「两段拼接出一个摘要必然不符的坏文件」；暂停**不** reject 调用方，因此不会窜进候选源回退链。
测试用真实 `node:http` 慢速分块服务（Range 支持/不支持两模式）5 例，并做了**变异验证**证明测试会被证伪
（恒追加→红、去掉 abort→红、去掉尝试起始暂停检查→红）。**不支持**（已在代码注释与文档写明）：跨进程/重启续传、
换候选源续传、取消下载。**内核侧 119 例全绿；shell UI 当时未接线——现已接线，见下一条的「暂停/继续下载」**。
🔧 **顺手修掉一个真 flake**：层测试约 1/5 概率出 `EPERM rename` —— Windows 上只要有句柄（杀软/索引器）残留就会这样，
而**真实用户首次安装会遇到同一件事**。已在两处 rename（下载层入缓存、激活）加**有界重试**（仅 EPERM/EBUSY/EACCES，
5 次后仍抛错）。5 次连跑全绿——**这与「修复有效」一致，但不构成证明**（原概率 1/5，样本不足）。

**C6 i18n（任务 9）—— 已完成（含启动页骨架）**：`src/shared/locale.ts` **188 键** × zh-CN/en-US（zh 表 `as const` 定键集，
en 表标注 `Record<MessageKey,string>`，**漏键即编译错误**——比运行时断言更强）；`t()` 对缺键/缺参数/占位未填**一律抛错**，
不回退到 key（否则漏翻译会静默进发布）；解析顺序 `DSH_APP_LOCALE` > `app.getLocale()`（`zh*`→zh-CN，其余→en-US）> 默认 zh-CN，
且**不在导入期解析**（模块级常量会冻结语言），`boot()` 首行 `initLocale()`。**`src/` 下用户可见文案已全部本地化**——
`src/shared/locale.ts` 是那里唯一允许含汉字的文件（扫汉字码位应恰好命中它一个文件，我独立复验过）。
**zh 逐字未变**（机械比对：123 条 shell + 53 条 kernel 的中文与改动前逐字节一致，含被测试钉住的那些）。
**顺带修掉一个本地化必然引入的回归**：`failures.ts` 的分类器原本靠**中文字面量**匹配（`完整性…`/`未找到`），
内核文案一换语言，英文用户的「内容被篡改」会被误判成网络故障——正好会给出那条我最在意的错误建议（「稍后重试」）；
现已改为**结构化信号**（从同一份文案表取模板头）+ HTTP 状态码正则。启动页的步骤指示也不再靠中文关键词匹配：
`KernelStatusPayload.step`（1-5，**新增可选字段、未新增 phase 取值**）由产生消息处填好，关键词表仅作无 step 时的兜底。
顺带修好 i18n 连带弄坏的两个探针：`probe-close-dialog.cjs`（签名改名）与 `probe-update-card.cjs`——
后者改为**从真实 locale 表取文案**，因此现在连「文案回归」也会红，**比 i18n 之前更强**；三个纯桩探针全绿，
其余 12 个是 Electron GUI 探针（裸跑必失败，已核实与本改动无关）。
**未验证**：启动页那行校验信息的渲染未真机验证（改的是 HTML + 注入视图字段；typecheck、零外部引用/零反引号已查）；
真实打包应用 + 真内核的启动/更新端到端未跑（只有单测 + Electron 探针）。
`dsh web` 的工作区入口仍未查清（CLI 无工作区参数），**C5 工作区直达**因此暂不推进——宁可留着也不猜槽位
（AGENTS 明确要求槽位必须对着运行中的 UI 验）。另已核实 **C2 目录选择「不必做」**（详见 §3.1 C2）：
那是上游的 `ctx.directoryPicker` 服务接缝，6 个 picker 包已在我们的内核树里、web profile 也已挂载 `-auto`，
上游的 Windows 实现自带 Win32 对话框驱动——**这一项从「待实现」改为「无需实现」**。
（C5 后来找齐了接缝，见下一条；上面这句「暂不推进」已被它取代。）
✅ **C5 工作区直达（启动文件夹 → 工作区）—— 已落地**（接缝在 2026-09-15 找齐，实现分两半）：
- **shell 半**（`src/main/workspace-launch.ts`，**纯逻辑、不 import electron**，所以能在 node 测试里直接跑）：
  `pickWorkspaceArg` 取 argv 里第一个**存在的目录**（跳过开关；跳过应用自己的目录，否则开发启动 `electron .`
  会被当成「打开仓库」）；`queueWorkspaceArg` 排队；`deliverWorkspaceLaunch` 注入并按 80 × 250 ms（≈20 s）重试。
  `boot()` 解析首次启动的 argv，`second-instance` 解析第二次启动的 argv（**两种情况同一个 parser**）。
- **页面半**（`plugins/plugin-client-ui/src/client/workspace-launch.ts`）：插件 apply 时把 handler 挂到
  `window.__dshAppOpenWorkspace`，一次调用做两件事——`ctx.get('workspaces').create({ path })`（上游文档明写幂等）
  再 `ctx.get('uiWorkspace').openWorkspace(id)`（**复用该工作区已有的空白会话**，所以重复启动不会堆空会话）。
  两个服务名与调用形状都已对着**已安装内核产物**（`dsh-0.1.5-rc.2+suite-98b0d32e`）核对：
  `super(ctx, "uiWorkspace")` / `openWorkspace(` / `super(ctx, "workspaces")` / `create(input)` / `workspaceId` 全在。
- **契约是状态码，不是句子**：`ok` / `pending`（页面还没接上 → 重试）/ `error:<宿主码>`。文案由 shell 出
  （新增 3 个 `workspace.*` 键 × zh/en；`workspace/invalid-path` 单独说「文件夹不存在或无法访问」，其余给通用文案）。
  这条遵守既定原则——跨进程边界不传已本地化的文本（`failures.ts` 的按文案匹配回归就是教训）。
- **应用已在运行时的第二次启动**：走 `second-instance`，**聚焦 + 直接投递**，不重载页面、不新建窗口。
- **失败软着陆**：没有套件插件的内核（回滚目标 / 安全模式）永远不会挂上 handler，shell 重试到点就静默放弃，
  窗口照常打开——不会因为一个文件夹参数把启动卡住。
- 证据：根 `npm test` **145/145**（新增 14 例：argv 解析 4、注入脚本 3、投递循环 6、跨构建全局名一致性 1）；
  `npm run typecheck` 干净；`plugin-client-ui` 构建通过（只剩那个**改动前就存在**的 `store.ts:159` 类型错误）；
  **`node scripts/probe-launch-folder.mjs` 22/22** —— 用 esbuild 按真实构建方式打包插件模块并在真引擎里驱动
  （调用顺序、状态码、失败码两种形状、dispose），再把 **shell 的真实注入脚本**求值到该页面上，**证明两半能拼起来**，
  最后从已安装内核产物里读那五个接缝字符串，防上游改名。**未验证**：真机观感（拖文件夹启动、重开时聚焦而非新建会话）
  ——见 §7 第 12 项。
✅ **启动页重做（品牌 / 主题 / 令牌对齐，2026-09-16）** ——
- **品牌行**：官方鲸鱼标（从 harness `BrandWordmark` **原样提取**的路径，`currentColor` 矢量）+ `DSH APP` + 版本号（tabular 数字，
  便于两版对比）。浅色 = 蓝底方块 + 白鲸（= 应用图标的样子，底色实测 `resources/icon-128.png` 为 `rgb(76,104,252)`），
  深色 = **去掉底块**的鲸鱼字形 —— 与主界面自己在深色下的品牌呈现一致。顺带去掉对外部图片文件的依赖：CSP 收回成最严的
  `default-src 'none'`，也不再有「图片没打进包」这类失败模式。
- **主题跟随 UI 自己的设置**：读 `$DSH_HOME/settings.yaml` 的 `ui-theme.preference`（`light`/`dark`/`system`）；
  `system`（**也是读不到时的默认**）跟随系统，并在 `nativeTheme` 变化时**实时**重推 —— 首次安装期间启动页可能停在屏幕上几分钟。
  窗口 `backgroundColor` 同色，避免深色用户先看到一帧白闪。解析器**只认 `ui-theme` 块内**的 `preference`
  （`locale` 命名空间也有同名字段，全文搜索会读错），`test/theme.test.mjs` 6 例钉住边界。
- **令牌对齐**：内联 DeepSeek 自己的 `--dsw-alias-*` **已解析值**并**保留令牌名**（浅色取 `body` 块、深色取
  `body[data-ds-dark-theme]` 块），出处写在文件注释里（`packages/client/ui-theme/src/styles/design-platform.css`）。
  一处**有意偏离**：版本/校验行用 `label-secondary` 而非 `label-caption`（后者白底约 2.2:1，读不清）。
- **语义零改动**：五步状态、进度条确定/不确定态、暂停/继续按钮、失败卡三按钮与焦点、校验行、注入 promise 的结算路径全部保留。
  探针 26 条老检查 + 9 条新检查 = **35/35**（新增：品牌名/版本号格式/矢量标/页面零外部引用/主题按设置解析/两种模式可被推送驱动/
  品牌标按模式适配/正常状态不出现滚动条）。**按用户反馈修订（2026-09-16 晚）**：
  logo **两种主题都用同一个蓝底方块 + 白鲸**（我原先在深色只留字形，用户指出「两主题不一致」——品牌标换形态等于两个标，
  此判断让位给一致性）；已完成步骤改为**绿色实心圆 + 深色对勾**（`--dsw-alias-state-success-primary` = `rgb(34,197,94)`，
  两主题同值；对勾用深墨 `rgb(15,17,21)` 而非白 —— 白在绿上约 2.2:1，低于非文本 3:1），完成态有一次 160ms 过渡。
  （**同日晚些**：用户要求勾改**白色**——已改，取舍写进注释：绿圆本身承载「完成」语义，勾只是确认；探针断言同步为
  `rgb(255,255,255)`。）
  **启动页也用上和主窗口一样的自定义边框**（用户指出：原生边框跟我们自己的 UI 不搭）：`titleBarStyle: 'hidden'` +
  `titleBarOverlay`（颜色随主题、符号色按底色深浅切换），页面顶部预留 **36px 可拖拽条**；主题切换时 `applyWindowTheme()`
  一并重刷窗口底色与覆盖层。探针新增两条**可测量**断言：内容区尺寸 == 窗口尺寸（无系统标题栏）、
  `#startup-titlebar` 的 `-webkit-app-region: drag` 且高 36px —— **38/38 通过**。
  **这轮最值得记的教训（CSP × 断言强度）**：对勾最初是用 CSS 背景图（`data:image/svg+xml`）画的，而启动页 CSP 是
  `default-src 'none'` —— **图片资源（含 data: URI）会被挡掉**，于是渲染出「只有绿圆、没有勾」，而我的探针断言只查了
  「背景图 URL 字符串里有没有 data:image/svg」，**字符串在、图没渲染，测试照样绿**（用户截图一眼看穿）。现已改成纯 CSS
  边框勾（旋转 L 形，无图片、无需放宽 CSP），断言也改成读**渲染几何**（`::after` 的 `content`/3×6/描边色/`transform` 旋转）。
  **诊断页两处交互缺陷（用户实测发现，2026-09-16 晚）**：① **「重新检测」点了没反应** —— `loadBridge()` 没有先置
  `loading`，本地请求快到界面纹丝不动（`loadTail()` 本来就有这个状态，两处不一致）→ 已补 loading 态（徽标转「检测中…」、
  按钮置灰）；② **成功提示永不销毁** —— 「已请求打开日志目录」「已导出到 …」一直挂在屏上，会被误读成当前状态 →
  改为 **4 秒后自动清除**（沿用 websearch 页的既有策略：**错误提示不自动消失**，它描述的是要用户处理的事）。
  **这轮最值得记的教训（CSP × 断言强度）**：对勾最初是用 CSS 背景图（`data:image/svg+xml`）画的，而启动页 CSP 是
  `default-src 'none'` —— **图片资源（含 data: URI）会被挡掉**，于是渲染出「只有绿圆、没有勾」，而我的探针断言只查了
  「背景图 URL 字符串里有没有 data:image/svg」，**字符串在、图没渲染，测试照样绿**（用户截图一眼看穿）。现已改成纯 CSS
  边框勾（旋转 L 形，无图片、无需放宽 CSP），断言也改成读**渲染几何**（`::after` 的 `content`/3×6/描边色/`transform` 旋转）。
 ✅ **宿主半 i18n 铺开完成（2026-09-16）** —— mcp 47 / hooks 24 / brand 40 / memory 109 / archives 16 / swarm 29 /
  usage 20 / presets 73 / market 185 / websearch 76 例全绿；**14 个套件合计 1015 例、0 失败**（本轮开始前是 959），
  根 `npm test` 154、`typecheck`/`check:graph` 干净、17 个插件构建全通过、启动页探针 **36/36**。
✅ **诊断导出包重构：宿主发事实、客户端出文案（2026-09-16）** —— 这项是「宿主半 i18n」的最后一处，也是唯一需要**改结构**
  而不仅是搬运的：导出包原先由宿主**组装成中文**再交给桥保存，所以英文界面导出的是一份中文文档。
  现在宿主只发布事实（`plugin-brand/src/diagnostics-facts.ts`：`name` / `generatedAt` / 三个版本 / 日志目录 /
  **日志目录的变量名** / 日志尾部或缺失原因），由页面按当前界面语言组装（`plugin-client-ui/src/client/diagnostics/report.ts`，
  React-free 便于测试），再经既有的 `/desktop/save-text-as` 交给 shell 保存 —— 那条路由的转发、取消、不支持、
  失败码与输入校验原本就有覆盖（`desktop-routes.test.ts`），所以导出路由自己的测试**删掉重复、只留事实与围栏**。
  **zh 逐字保留**：25/25 条原句机械比对命中（唯一变化是插值写法 `${x}` → `{x}`）。
  **测试**：plugin-brand **38/38**（重写为事实断言 + 「令牌不可能出现在载荷里」），plugin-client-ui **新增套件 6/6**
  （zh 全文、en 全文且**断言英文包里没有我们的中文**、缺失值 → 页面自己的「未知」、四种日志缺失原因、
  空尾部、名字回退），并补了 `scripts/test.mjs` + `npm test`（该插件此前没有套件 —— 现在是 **15 个**）。
  **又一处占位符缺陷被测试逼出来**：`unsupported` 原因里的 `{env}` 一开始没被填（会打印字面量），
  修法是让宿主把变量名一起发布，保持原句不变。
  **未验证**：真机点一次「导出」走原生另存对话框（对话框无法自动化；三段链路各有测试，组合层是三次已测调用）。
✅ **深色主题两处真缺陷（用户截图报告，2026-09-16）** ——
  ① **主按钮白字白底**：`in-frame-dialog.ts`（关闭弹窗的「最小化到托盘」）与 `update-card.ts`（「立即更新」）都用
  `--dsw-alias-brand-primary`（**深色下是近白色** `rgb(249,250,251)`）+ 硬编码 `color:#fff`，深色下标签不可读。
  改用主界面自己按钮的**成对令牌** `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（一起翻转，
  标签不可能没入填充色）。`test/in-frame-dialog.test.mjs` 3 例钉住「不许再出现硬编码白字」。
  ② **启动页图标没适配**：见上一条（位图 → 矢量 + 按主题切换）。
✅ **宿主半 i18n 铺开（2026-09-16，除 office/fff 外全部完成）** —— 同一份 `HostText` 合同照搬到：
  **mcp**（47 例，从 35 升）/ **hooks**（24 例，从 12 升）/ **brand（诊断页）**（40 例）/ **sidebar（Git 页）** /
  **swarm**（29 例，从 27 升）/ **usage**（20 例，从 16 升）/ 以及既有的 **websearch**；
  **presets / market / memory / archives** 同批进行中。每个插件都做了 **zh 逐字保留**的机械比对（如 mcp 57 个片段 0 缺失）、
  构建产物扫描（宿主 bundle **0 个汉字**、客户端 bundle 同时含 zh/en 两份字典）。
  **两处由测试逼出来的真缺陷**：① `route.invalidBody` 的文案带 `{detail}` 而宿主只送了 `text` → 会显示字面量 `{detail}`，
  mcp/hooks 修掉并加了「渲染整张表、任何 `{param}` 残留即失败」的用例；② **同一缺陷也在 websearch 里**（我上一轮的代码），
  已修并把它也搬进可测模块（`client/host-message.ts`，React-free）+ `tests/host-message.test.ts` 6 例，
  且做了**变异验证**（去掉 `{detail}` → 3 条红）。
  **明确不改**：office 四件套（doc/pdf/ppt/sheet）那几百条中文是**生成文档内容与模型面工具输出**，不是设置页 UI；
  plugin-fff 没有客户端半（那些字符串只进工具结果给模型看）。
  **待你拍板**：诊断导出包（`diagnostics-report.ts`，21 条中文）由宿主组装并保存、没有客户端渲染点，
  要英文化得改成「客户端组装 → 宿主保存」。
✅ **D3 CI 套件覆盖** —— `ci.yml` 的 gate job 由「固定跑 2 个套件」改为「跑所有带 `tests/` 的套件」。
✅ **D4 §5.2-4 服务守卫** —— 导出 `redact` 与 `probeServerHealth(url)`，8 例（含**真实 loopback 服务**跑
303 + `Set-Cookie` + 带 cookie 复访；跨源跳转必须 false）。过程中**修出一处真缺陷**：`redact` 的
query 规则注释声称能保住 `&next=/x`，实际被其后的裸规则吃掉（安全但仍属注释与行为不符）——已修。
✅ **D2 插件图静态校验** —— `scripts/check-plugin-graph.mjs` + `npm run check:graph`，四条规则 +
7 个否定用例 + 防误报用例，已接入 CI 快速 gate；四条规则在当前树上均已满足（是守卫，不是修 bug）。
✅ **5 内核分层 tgz —— 三层全部完成**：
- **生产者**：`scripts/split-runtime-layers.mjs` 产五层 + `layers.json`，自校验
  `26464 files reproduced exactly`；层名即缓存键（node/vendor/meta 内容寻址、dsh/suite 版本寻址）。
- **本地装配**：`src/kernel/layers.ts` + `installFromLocalLayers` + `activateExtracted`
  （tgz 与层路径**共用同一段激活代码**，语义不分叉）+ 层缓存 `kernel/layers/`（`cleanup()` 保留并按
  `current.json.layers` 回收）+ 可选 `layers` 字段（旧记录照常工作）。
- **在线路径**：`artifact.ts` 的 `fetchLayerIndex`（沿用 `.sha512` 的元数据纪律：官方优先 / fail-closed /
  代理仅兜底 / ModelScope 永不供索引）+ `installVersionFromLayers`（**缓存命中即不下载**）+
  **任何失败回退到逐字未改的单 tgz 路径**（不可能因快路不通而装不上）。
- **CI 与镜像**：`release.yml` 在 tgz 上传之后拆分并上传层资产；`mirror_release.py` 同步认识层资产
  （否则镜像任务会直接失败），且层资产**永远不能满足「必须有 tgz」**，完整性检查未被削弱。
证据：真实层集在线安装 40.1s、**零 tgz 请求**；层 URL 全 404 → 回退单 tgz 装成功；96/102 全绿。
**收益已端到端具备**（首次装 ≈ 单 tgz 体积；dsh 升级只下 ~10 MiB），但**未在真实 release 上验证**。
**待人工验证**：冷启动样貌与真实进度节奏；首启失败卡；macOS/Linux 真实 electron-updater 通道
（本机为 Windows，未实测）；详见 **§7 交付测试清单**。

## 1 发布与首启

### 任务 0：无签名分发的缓解（零成本）

不买证书，但要让用户能顺利装上：

- macOS：Sequoia 起**右键「打开」的绕过已被移除**，用户必须走
  「系统设置 → 隐私与安全性 → 仍要打开」。README / 下载页要给这一步的图文指引，
  否则用户会卡在「无法验证开发者」。
- Windows：SmartScreen 黄条 →「更多信息」→「仍要运行」。给一句指引即可。
- 首次启动前的提示文案要说明「首次启动需要几十秒准备」（配合任务 1）。

**验收**：把 dmg / exe 给一个没用过的人，只读 README 能装起来。

### A2 首启可见性 → 任务 1

- **现状（L1）**：`static/` 为空；主窗口只在 server 健康后才创建（`index.ts:340-351`），
  注释明确写着「runs silently in the background … with no intermediate setup window」
  （`index.ts:725-729`）。首启要解压内置 103 MB 内核，这段时间屏幕上只有托盘。
- **做法**：恢复一个本地启动窗口，显示阶段化状态（校验内置包 → 解压 → 激活 → 启动内核 → 打开界面）；
  失败时给可行动作（重试 / 重装内置包 / 安全模式 / 打开日志目录）。就绪后切换到真实窗口。
- **约束**：不得为它引入 preload / IPC（见 §4.5-6）。优先「主进程写静态文件 + `file://`」。
- **验收**：删除 `<userData>/kernel` 后冷启动全程有可见进度并走到成功；人为破坏内置包 sha512 时
  给出可行动提示而非静默退出；主窗口仍无 preload。

### A3 更新 UX 三平台一致 → 任务 2

- **现状（L1）**：Windows 有完整链路（三按钮对话框 `updater.ts:521-552`、进度卡 `676-690`、
  跳过持久化 `454-474`、托盘回滚 `tray.ts:52-59`、失败弹镜像页 `359-386`）；
  macOS / Linux 只有下载 / 重启对话框（`updater.ts:95-164`），**无进度、无跳过、无回滚**。
- **做法**：把 Windows 侧能力抽成平台无关层（`update-card.ts` / `in-frame-dialog.ts` 本就平台无关），
  mac / Linux 复用；把 `electron-updater` 的 `download-progress` 事件喂同一个进度卡。
- **验收**：三平台看到同一套进度卡；「跳过此版本」在 mac / Linux 同样生效并持久化。
- **不回归**：按钮文案与语义按 §4.4 冻结，Windows 用户不应遇到行为变化。

## 2 打包与更新

### 2.1 runtime 资产进 ModelScope 镜像 → 任务 3

- **现状**：内核 tgz 只挂 GitHub（`artifact.ts:68-74`），`publish-mirror.yml:44-45` 的 tag filter
  把 `runtime-*` 排除了 → 大陆用户靠 `ghfast.top` 代理下 103 MB。
- **做法**：tag filter 放开 `runtime-*`，落盘 `releases/runtime/<tag>/`；`artifact.ts` 的镜像链
  追加 ModelScope 候选。**纪律不变**：sha512 sidecar 只信官方 host，镜像只承担传输（§4.5-4）。
- **风险**：存储增长——每个 dsh 版本 6 cell × ~110 MB ≈ **660 MB**。现有 `keep_versions=10`
  是给 shell 版本设计的，内核要有独立保留策略（保留最新 N ≤ 5，且必留当前最新版），
  并与 `versions.json` 的「拒缩减」约束对齐。
- **验收**：屏蔽 GitHub 后能从镜像单源完成一次内核更新；mirror 摘要能看到 runtime 路径的
  保留 / 删除清单。
- **不回归**：既有 GitHub 路径仍工作，元数据仍只信官方 host。

### 2.2 Windows shell 差分化 → 任务 4

- **现状**：blockmap 资产已发布（`DSH-APP-0.11.9-win-x64.exe.blockmap` = 193,685 B）却未使用；
  `updater.ts:331` 是裸 `fetch` 整包下载 185 MB。
- **做法**：改走 `electron-updater`，用自定义 `Provider`（覆盖 `newUrlFromBase`）把资产名映射到
  ModelScope 的 raw 端点，或复用其 `DifferentialDownloader`；保留现有镜像回退链。
- **机理与前置（L1，读 `node_modules/electron-updater/out/`）**：`NsisUpdater.js:49` →
  `AppUpdater.js:643 differentialDownloadInstaller(...)` 用 `CURRENT_APP_INSTALLER_FILE_NAME`
  ——**本机缓存的上一版安装包** + 新安装包内嵌的 blockmap 做区间比对；任一步出错**回退全量**。
  因此需要保留上一版安装包（约 185 MB 磁盘），当前「下次启动删除残留安装包」的逻辑要相应调整。
- **前置验证（已完成，L1 实测）**：镜像源**支持 HTTP Range** —— ModelScope（302 →
  `cdn-lfs-cn-1.modelscope.cn`）与 GitHub（经代理）对 `-r 0-99` 均返回 **HTTP 206 且恰好 100 字节** ✓。
- **收益（L1 实测，2026-09-15 订正）**：用真实发布的 blockmap 算出 v0.11.7→v0.11.9 与
  v0.11.8→v0.11.9 两对**都只省约 44%**：仍需下载 **99.0 / 99.1 MiB**（安装包 177.0 MiB，
  复用 78.0 MiB）。实测量法：取两版 `*.exe.blockmap`（gzip JSON），按 electron-updater
  `computeOperations` 的语义统计「新块哈希在旧文件中存在即可复用」。
  旁证：这一对的旧包彼此几乎相同（172.5 MiB / 8559 与 8558 块），说明连续 shell 版本的真实载荷
  差异本就很小，44% 不是异常值。
- **结论：本任务降级**（不删，只排在任务 5 之后）。代价是每台机器常驻 172 MiB 安装包、重写主平台
  下载链、且**无法在本地端到端验证**（需要两次真实发布）；而任务 5 作用在「每次 dsh 发版」这个
  更高频的事件上，收益更大、不依赖第三方更新机制。执行顺序见 §6。
- **验收**：更新日志出现 `To download:` 且**实测值接近 44% 而非接近全量**（该行由
  `DifferentialDownloader.js doDownload` 打印）。
- **不回归**：**删掉旧安装包缓存后能自动回退全量并安装成功**；差分与全量共用同一 sha512 校验函数；
  skip-version、可见 NSIS 向导、pending-install 记录、托盘回滚四项能力迁移后不能丢。

### 2.3 内核分层 tgz → 任务 5

- **做法**：不做字节级 blockmap（tar 是流式的，改一个文件会移动其后所有字节，朴素区间 diff 无效），
  改为**按层替换**。层切法用真实产物**实测**过（`scripts/split-runtime-layers.mjs`，
  输入 `runtime-dist/dsh-runtime-win32-x64-0.1.5-rc.2.tgz`）：

  | 层                      | 压缩后实测   | 变化频率          | 命名（即缓存键）                     |
  |-------------------------|--------------|-------------------|------------------------------------|
  | `node`                  | **33.9 MiB** | 仅 Node 版本变化  | `node-<内容hash12>-<p>-<a>.tgz`    |
  | `vendor`（第三方闭包）    | **45.5 MiB** | 依赖集变化时才变  | `vendor-<内容hash12>-<p>-<a>.tgz`  |
  | `dsh`（`@deepseek-ai/*`） | **9.9 MiB**  | **每次 dsh 发版** | `dsh-<dshVersion>-<p>-<a>.tgz`     |
  | `suite`（`@dsh-app/*`）   | **6.9 MiB**  | 我们改插件时才变  | `suite-<suiteVersion>-<p>-<a>.tgz` |
  | **合计**                | **96.2 MiB** | —                 | 与单个 tgz 的 96.2 MiB **持平**    |

  - **这推翻了原设计的切法**：原计划把「`@deepseek-ai/*` + 第三方依赖」合成一个 `core` 层（估算 70 MB），
    实测表明第三方闭包（45.5 MiB）与 dsh 包本体（9.9 MiB）必须分开——否则每次 dsh 发版仍要下 55 MB。
    分开后 **dsh 发版只下 ~10 MiB（省约 90%）**。
  - node/vendor 用**内容哈希**做键：内容相同时名字相同 → 客户端直接命中缓存；dsh/suite 用版本做键，
    名字恰好在内容该变的时候变。
  - 分层不增加体积（96.2 = 96.2），新装用户无额外代价。
- **收益**：dsh bump 下 ~10 MiB（对比现状 96 MiB、对比 shell 差分的 78 MiB）；插件改动只下 6.9 MiB，
  且**不再需要重发 6 cell runtime**。
- **改动**：生产者侧已有 `scripts/split-runtime-layers.mjs`（产出四个层 + `layers.json`，
  内含每层 sha512/bytes/entries，并**自校验**：拆层后重新装配与原始树逐文件一致——
  实测 `26464 files reproduced exactly`）。尚待做：CI 上传层资产；`KernelManager` 的
  install/activate 改为「按层装配 + 层缓存复用」；`current.json` 记录每层的 name/sha512。
- **风险（本计划最高）**：**改磁盘契约**。旧安装升级后若 `current.json` 语义不兼容，会直接导致
  回滚找不到 `previous`（§4.5-1/2、附录雷 2）。
- **守卫**：先做**向后兼容**（新客户端能读旧 `current.json` 并原位升级；旧客户端读到新目录不崩；
  过渡期**继续发布单个 tgz**，否则旧客户端再也更新不了）；配 §5.2-2 的状态机单测 +
  一次「0.11.x → 新结构」实机升级演练。
- **验收**：单次 dsh 升级下载量 ≈ 10 MiB 量级（而非 96 MiB）。
- **不回归**：旧版本客户端 安装 → 升级 → 回滚 三级路径可用；`smoke-suite.mjs --tgz` 与
  `check:plugins` 全绿。
- **发布纪律**：**单独一批发布**，不与任务 6 同批（§6）。

### 2.4 pnpm + lockfile 组装内核 → 任务 6

- **现状**：`build-runtime.mjs:365,422` 用 `npm install --omit=dev --legacy-peer-deps`（两次）。
- **做法**：工作区打 tgz → 生成 `pnpm-workspace.yaml` + `overrides` 全指 `file:` →
  先 `--lockfile-only` 并断言核心包不由 registry 解析 → 再
  `pnpm install --prod --frozen-lockfile --trust-lockfile`（`nodeLinker: hoisted`）→
  产出逐文件 sha256 + 可执行位清单，electron-builder 侧加 `afterPack` 复核。
- **收益**：可复现；并消掉整类历史坑——`--legacy-peer-deps` 剪坏 lockfile（曾在根目录执行后让
  所有 CI 的 `npm ci` 失败）、切换 kernel line 必须先删 `node_modules`、插件 lockfile 陈旧导致
  dsh-llm 双实例。
- **前置验证（未实测）**：`file:` 覆盖能否在**无 registry 访问的构建环境**完全离线完成。
- **守卫**：先做**双产出对比**（npm 树 vs pnpm 树的文件清单差异必须可解释），
  再由 `smoke-suite --tgz` + `check:plugins` 守行为。
- **验收**：同版本重复构建逐文件 sha256 清单一致。
- **不回归**：内核目录布局（`node/node[.exe]` + `app/node_modules/@deepseek-ai/dsh/lib/bin.js`）
  与 spawn 路径不变（附录雷 1）。
- **发布纪律**：与任务 5 **不同批发布**。

### 2.5 插件出 npm 包 → 任务 7（可选）

- **现状**：17 个 `@dsh-app/*` 无 `private`、无 `publishConfig`（即未发布），随 kernel tgz 一起发。
- **做法**：发到 npm；kernel 不再携带插件；由 shell 在 `$DSH_HOME/profiles/node_modules/@dsh-app`
  按需安装。加载层已就绪（`brand-suite.ts:76-87,134-198` 本就是符号链接机制）。
- **风险**：首次启动需要网络。
- **验收**：断网首次启动仍可用（保留内置兜底）。
- **不回归**：在线装 / 卸插件不触碰 kernel 目录。

## 3 桌面能力与护栏

### 3.1 C 层：桌面差异化能力

依赖任务 1（plugin-brand 是多数项的地基）。

- **C1 `plugin-brand` 落地（地基）**：`openInFolder` / `saveTextAs` / `notify` / `focusSession`
  仍是空壳（`plugins/plugin-brand/src/index.ts:27-40`）。落地后「打开日志目录」「导出诊断包」
  「系统通知」才有实现基础。

#### C 层的前置设计：桌面桥（2026-09-15 定稿）

C 层每一项最终都要落到**原生动作**（开文件夹 / 系统通知 / 另存为 / 选目录），而原生能力只在
Electron 主进程里；内核是**子进程**，渲染层是**远程源页面、无 preload、零 IPC**（§4.5-6）。
所以必须先把这条通路定下来，否则 C1–C5 都无从下手。

**结论：由 shell 自持一个只监听 loopback 的 HTTP 桥，插件经它调用原生动作。**

- shell 在启动内核**之前**起一个 `http.Server`，绑 `127.0.0.1:0`（随机端口），生成一次性随机
  **bearer token**；把 `DSH_APP_BRIDGE_URL` / `DSH_APP_BRIDGE_TOKEN` 经 **子进程 env** 传下去
  （只给内核子进程，不落盘、不进任何用户可见输出）。
- 路由 `POST /bridge/<action>`，首批动作：`open-in-folder(path)`、`notify(title, body)`、
  `save-text-as(name, content) → path`、`pick-directory() → path`、`open-logs`。
- **围栏（缺一不可）**：① 只绑 loopback；② 校验 `Authorization: Bearer <token>`；
  ③ 校验 `Host` 是 loopback 形态（原参照的 `plugins/plugin-sidebar/src/trust-fence.ts`
  已随迁移删除，此处沿用同一套判据自行实现）；
  ④ 不设 CORS，浏览器的页面**无法**直接调用它；⑤ 每个动作有超时，失败给稳定可行动的 zh-CN 文案。
- 插件侧：`plugin-brand` 注册一个 host 服务，客户端经**正常 dsh API seam** 调用（不新增专用 IPC、
  不碰 preload）。服务不可用时（未注入 env，例如 dev 或旧 shell）**优雅降级**：动作返回「当前环境不支持」
  而不是抛错——沿用套件的 fail-soft 纪律。
- **为什么不用别的**：子进程 stdout 带外通道（`\x00BRIDGE:` 之类）只适合单向动作，
  `save-text-as` / `pick-directory` 需要返回值，会逼出第二套机制；预加载+IPC 直接违反 §4.5-6。
- **被这条设计顺带解掉的**（原先硬编码禁用）：C2 的目录选择、C3 的「打开日志目录」、C4 的
  「另存为诊断包」都走同一个桥，不再各自造轮子。
- **风险**：多一个监听端口。缓解：仅 loopback + token + Host 围栏；端口与 token 每次启动重新生成；
  桥只在 shell 存活期间存在（随 quit 关闭）。
- **C2 原生目录选择器 —— 已核实：不必做（前提被推翻）**。2026-09-15 查上游：
  ① 目录选择不是 HTTP 路由，而是一条 cordis 服务接缝 `ctx.directoryPicker`
  （`packages/host/directory-picker/src/index.ts` 的 `DirectoryPicker extends Service`，
  带 `native` / `browse` 两种能力声明）；
  ② **那 6 个 picker 包已经在我们的内核树里**（`dsh-host-directory-picker{,-auto,-browse,-native}` +
  `dsh-client-ui-directory-picker{,-browse,-native}`——它们是传递依赖，不是 CLI 的直接依赖，
  所以只查 `apps/cli/package.json` 会得出「没有」的错误结论）；
  ③ web profile 用的 `packages/bundle/web-app/cordis.patch.yml:94-95` **已经挂载**
  `@deepseek-ai/dsh-host-directory-picker-auto`，由它按平台在 native / browse 之间选，并联动对应的客户端面；
  ④ 上游的 Windows native 实现是**自己 spawn 一个 worker 驱动真实 Win32 对话框**
  （`win32-dialog-host.ts` 用 `process.execPath` + `worker.cjs`），**不需要 Electron、也不需要我们的桥**。
  **原表述的来源是官方 desktop README 的「Known limitations」**——那条说的是
  **"Open In..." 动作**因为官方 desktop **不提供 webServer** 而被禁用；
  **我们是 `dsh web`，本来就有 web server**，所以那条限制不适用于我们。
  若将来要「钉住」某种交互，在 overlay 里直接挂 `-native` 或 `-browse` 即可（上游注释就是这么说的）。
- **C3 诊断中心**：设置页加重启计数 / 内核版本 / 日志 tail / 打开日志目录。方案见
  desktop-shell-experience.md §2。
- **C4 首启补全**：校验和展示
  （`manager.ts:310` 只在失败时给前 16 位）、失败文案分层。
- **C4 暂停/恢复的 shell UI（已完成）** —— 启动页下载阶段显示「暂停下载 / 继续下载」，走既有注入 promise 惯用法。

  **实现要点（两条都是探针逼出来的，值得留档）**：
  1. **按钮的可见性与标签由「状态」决定，不由「挂起」决定**：初版把显示逻辑放在 awaiter 里，结果「状态变了但那一刻没有挂起的 awaiter」时界面会说谎；
     现在 `render(view)` 按 `view.pausable/paused` 决定显隐与标签（文案来自随每次 push 下发的骨架），awaiter 只负责 park 一个 resolver。
  2. **挂起的 promise 必须在下载结束/失败时以「不再适用」结算**（页面里 `!pausable` 就结算为 `false`），否则主进程会永远等一个再也不会发生的点击。
     骨架键 `splash.pauseDownload` / `splash.resumeDownload`（+ en）随之加入 locale 表。

  **验证（真机电子探针 `scratch/probe-startup-pause.cjs`，6/6）**：下载中按钮可见且标签为「暂停下载」→ 暂停态标签翻成「继续下载」→
  点击使挂起的 promise 结算为 true → **下载结束时挂起的 promise 结算为 false（那条坑）** → 按钮隐藏 → 一次点击只结算一个挂起的 promise（不会双重切换）。
  另两个启动页探针无回归：`probe-startup-window` 26/26、`probe-startup-step` 6/6。
- **C5 工作区直达（2026-09-15 核实结论 + 2026-09-16 落地）**：
  查证如下 —— ①「工作区」就是**会话级 `cwd`**（`packages/client/ui-workspace/src/client/tree.ts`
  按 cwd 分组会话；`ui-deliverables/src/present-open.ts` 用 `session.cwd ?? ctx.sandboxPolicy.workspaceRoot`）；
  ② **`apps/cli/src/args.ts` 没有任何工作区/cwd 参数**；③ web 端**不读工作区相关的 URL 查询参数**
  （全仓唯一的 `URLSearchParams` 用处是 present-open 的内部链接）。因此：
  - **路径 A（已实现）**：dsh-app 自己的**客户端插件**拿这个路径，然后：
    ```ts
    const workspaces = ctx.get('workspaces')             // dsh-api-workspace-controller/client 的 IWorkspaces
    const workspace = await workspaces.create({ path })   // 幂等：已注册则原样返回（其 JSDoc 明写）
    await uiWorkspaces.openWorkspace(workspace.workspaceId)  // ui-workspace 的服务：连会话 + 打开，且会复用空白会话
    ```
    `openWorkspace`（`ui-workspace/src/client/navigation.ts:129`）比直接 `sessions.create` 更好：它先在该工作区里找
    **已有的空白会话**复用，找不到才新建——「重复启动同一文件夹」因此不会堆空会话。两个 seam 都是插件能拿到的
    （`ui-workspace/src/client/index.ts:64` 正是这么 inject 的），服务名与调用形状另已对着**已安装内核产物**核对。
  - **投递机制：全局函数，不是 URL 查询参数**（与上面「路径 A」最早的想法不同，理由如下）。
    查询参数只在**页面加载**时有意义，而应用**已在运行时**的第二次启动不该为了一个参数重载页面；
    改成 `window.__dshAppOpenWorkspace(path)` 后两种情况走**同一条**注入路径（`executeJavaScript`，
    §9 允许的唯一 shell→页面接缝），第二次启动因此是「聚焦 + 投递」而不是「重载 + 投递」。
    代价是需要在页面里**重试**（插件 apply 晚于页面加载）：`deliverWorkspaceLaunch` 有界重试 80 × 250 ms，
    页面用 `pending` 表示「还没接上」，宿主码用 `error:<code>` 表示「拒绝了」——**状态码过界、文案不过界**。
  - **路径 B**：向上游提议一个启动参数（`dsh web --cwd <path>` 或客户端承认的 URL 参数）——未做，非必需。
  - **明确不做**：猜一个槽位/内部字段去驱动 UI——那是本项目踩过的坑（编译全绿、运行时抛错）。
- **C6 i18n（任务 9）—— 已完成**（详见 §0 进度块）：`src/shared/locale.ts` 181 键 × zh-CN/en-US，`t()` 缺键即抛错，
`src/` 下用户可见文案已全部本地化（扫汉字只允许命中 locale 表一个文件）。**启动页骨架也已本地化**（七处：页头提示、失败提示、五个步骤标签）：
静态 HTML 保留中文兜底（注入前的瞬间可用），主进程在**首次 push 时懒构造**骨架并随每次 push 下发——
懒构造是必需的，因为 `t()` 必须跑在 `initLocale()` 之后，模块级常量会把语言冻结
（`boot()` 里 `initLocale()` 在 `createStartupWindow()` 之前，已核对）。

#### 插件的文案怎么办（2026-09-15 定稿：**不要走 shell 那套**）

壳的 `src/shared/locale.ts` 是 **Electron 主进程**的表；插件的**客户端半**跑在内核服务的**网页渲染进程**里——
两个进程、两个世界，插件 require 不到那份表。硬接的结果是「插件文案跟着 shell 而不是跟着 UI」：
用户切了界面语言，插件页还是老语言。

**上游已为插件备好接缝**（照它做，别自造）：`packages/client/locale/src/client/index.ts:370` 的
`register<N>(ns, dicts)` —— 插件先 declaration merging 把命名空间并进 `LocaleNamespaceMap`，再注册；
`dicts` 的**值类型由该命名空间的键联合约束，漏键/多键即编译错误**（与我们 shell 侧 zh `as const` +
en `Record<MessageKey,string>` 同源）。

**语言归属**：`LocaleSettings { preference?: LocaleId }` 是一个 dsh 设置，注释原话「absence delegates to the
browser」——**UI 的语言由 UI 自己的设置/浏览器语言决定，与 shell 无关**；两边默认天然一致
（Electron 渲染器的 `navigator.language` 跟随应用语言）。我们的 `DSH_APP_LOCALE` **只管 shell 自己的面**
（启动页 / 托盘 / 对话框 / 更新卡）；若要让一个开关也管到 UI，需要一个桥：插件读 shell 下发的值
再写 `LocaleSettings.preference`——那是**额外**一步，不是默认行为。

**比接缝更重要的一条原则**：**宿主半不渲染面向用户的散文**，返回**稳定错误码 + 参数**，由客户端映射成文案。
两条理由都被我们撞过：① 宿主是长生命周期的内核子进程，语言若靠它，切语言就得重启内核；
② 跨边界传「已本地化的文本」会诱发**按文案匹配**——这正是 `failures.ts` 那个回归（内核文案一换语言，
「内容被篡改」被误判成「网络故障」并给出「稍后重试」的错误建议）。宿主的**日志**面向开发者，保持英文即可。

**落地状态**：**15 个插件的客户端半已全部接入**（参考实现 = `plugin-client-ui` 的「诊断」页，其余照做），
共用 **约 1041 个键**（命名空间每插件一个：`dsh-app.usage/archives/sidebar/hooks/swarm/memory/mcp/websearch/presets/market/doc/pdf/sheet/ppt/client-ui`）。
各批都做了 **zh 逐字比对**（拿改动前源码做机械比对，多数还做了反向覆盖与「改一字即报错」的反证），
并核到构建产物里中英两份字典齐全。**我的验收**：根 `typecheck` 干净、根 `npm test` 131/131、`check:graph` 干净、
**17 个插件全部构建通过且套件全绿（959 例）**。
**已知遗留**：① **宿主半文案仍是中文**（路由错误、引擎标签等按 wire 原文直显）——按「宿主返回码、客户端渲染」的既定原则属下一轮；
② 英文译文是各批自写的，**未经母语者/产品复核**；③ 已在屏的消息以字符串存于 state，切语言不一定即时重译（各插件通行做法）；
④ 个别插件有**改动前就存在**的类型错误（`plugin-sidebar` 的 SlotMap、`plugin-client-ui` 的 `settings/conflict`），各批都用 HEAD 复现证明与本次无关。

**宿主半 i18n 的第一批（2026-09-16，plugin-websearch）—— 遗留① 已在该插件落地，合同定死如下**：
- **`HostText { code, params?, text? }`**（`plugins/plugin-websearch/src/wire.ts`）：宿主**永远不送面向用户的散文**，
  只送稳定码 + 插值参数；文案在插件的 `ws.engine.*` / `ws.status.*` / `ws.provider.reason.*` / `ws.host.*` 键里。
  `text` 是**英文诊断**，只在客户端不认识该码时兜底（新旧版本错配也不至于出现空白徽标）。
- 覆盖面：**引擎提示**（5 条从宿主代码搬进字典）、**引擎不可用原因**（缺 key / 缺实例 / 未知引擎）、
  **provider 可用性原因**（6 条）、**保存被拒的校验码**（8 条）、**路由失败**（请求体过大 / 写盘失败 / 无法解析）。
- **引擎与链路的报错正文改成英文诊断**（HTTP 状态、JSON 解析失败等）——它们本来就是技术细节，
  由客户端拼进本地化句式（「探测失败：HTTP 403」）。中文用户看到的中文句式不变，只把技术详情换成英文。
- **zh 逐字保留**：搬运做了机械比对——HEAD 里 18 条中文字面量全部在新的 zh 字典里逐字命中（只有插值写法从 `${...}` 变成 `{id}`）。
- **测试**：plugin-websearch **70/70 绿**（18 条断言从「匹配中文」改为「断言语义码」，比原来更稳）；`typecheck` 干净。
- **真机验证**：`scripts/probe-settings-nav.cjs --lang en-US` 新增「英文模式下该页是否还残留汉字」自动判定——
  修复前该页有 6 条中文（5 条引擎提示 + 1 条实例原因），修复后 **0 条**。
- **仍未做**：其余插件宿主半的同类改造（同一合同可直接照搬）；`route.crossOrigin` / `route.methodOnly`
  这类只可能被恶意页面触发的失败仍未配文案（会显示英文诊断，属有意）。

#### 设置导航：顺序 / 滚动 / 图标（2026-09-16，真机量测后修）

设置面板左侧是**上游的**导航轨道，按它自己 5 个分区的高度设计；套件往里加了 10 个分区，于是三件事需要处理：

1. **轨道必须能滚**。上游只让内容区滚动，`.navList` 自己没有 overflow。**实测**（探针 1280×620 窗口）：
   最后 4 行（并行子代理 / 预设包 / 诊断 / 已归档会话）落在面板下沿之外，被面板的 `overflow: hidden` 裁掉，
   而列表 `overflow-y: visible`、`scrollHeight === clientHeight` —— **够不着**，不是「滚一下就能看到」。
   修法是一行注入样式（`plugin-client-ui/src/client/settings-nav.ts`）：
   `nav [class*="navList"] { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 22px; }`
   —— `min-height: 0` 才是让 flex 子项能收缩到内容高度以下、从而让 `overflow-y` 有事可做的关键。
2. **诊断行要自己的图标**。上游按 section id 映射图标，其余一律回退到通用齿轮；「模型高级设置」已有立方体字形，
   「诊断」此前戴着同一个齿轮。新增一条**心跳线**字形（同一 16 格、1.4 描边，与既有图标同一套画法）。
3. **顺序按语义分带**（`order` 值一次改到位，改动点在各插件 `client.ts` 的注册处）：

| order | 分区         | 归属                   |
|-------|--------------|------------------------|
| 0     | 通用设置     | 上游                   |
| 10    | 模型         | 上游                   |
| 11    | 模型高级设置 | 本套件                 |
| 12    | MCP 服务器   | 本套件                 |
| 13    | Hooks        | 本套件                 |
| 14    | 网络搜索     | 本套件                 |
| 15    | 插件         | 上游                   |
| 16    | 用量统计     | 本套件                 |
| 19    | 并行子代理   | 本套件                 |
| 20    | Agent 预设   | 上游                   |
| 21    | 预设包       | 本套件                 |
| 22    | 诊断         | 本套件                 |
| 23    | 会话记忆     | 本套件（本轮从 18 移来） |
| 24    | 会话归档     | 本套件（本轮从 17 移来） |
| 25    | 已归档会话   | 上游（钉死，动不了）      |

**分带理由**：11–14 = 模型与集成配置；15–19 = 生态与运行（插件 → 用量 → 子代理）；20–21 = 子代理与预设（预设紧贴 Agent 预设）；
22 = 系统级；23–25 = 会话数据三连（记忆 → 归档 → 已归档，把原本隔开的两个归档页凑到一起）。
**一次踩过的坑**：截图里最下面那行「插件市场」**不是导航项**，而是侧边栏底部的按钮（探针量到导航只有 15 行，已核实）。

**验证**：`scripts/probe-settings-nav.cjs` 同时量顺序、图标、滚动与「英文模式下该页残留多少汉字」；
修复前 3 项红（小窗口 4 行不可达 / 诊断无自绘图标 / 该页 6 条中文），修复后**全绿**。

**注意**：探针在 Electron（无控制台）里 `spawn` 控制台子进程，**必须带 `windowsHide: true`**，
否则 Windows 会给它新开一个可见的控制台窗口（用户桌面会闪出终端）——已修，并在 AGENTS.md 记下这条。

### 3.2 D 层：工程护栏（任务 10）

- **D1 打包产物冒烟**：`ci.yml:51-83` 只冒烟 Linux x64 的 runtime tgz；`release.yml` 里
  **没有任何打包产物验证** → asar / extraResources 漏文件这类事故在安装包层面无人把关。
  照 `smoke-suite.mjs` 的模式加一个对 unpacked 目录的检查。
- **D2 插件图静态校验**：把现在只有运行期 dry-run、且**未接 CI** 的
  `scripts/check-plugin-compat.mjs` 接进 CI；补静态规则（核心包只能声明为 peer、禁嵌套副本、
  peer 版本须 satisfies）。
- **D3 CI 套件覆盖**：13 个插件有测试套件，CI 只跑 `plugin-memory` 与 `plugin-swarm`；
  其余 11 套接进 CI（这是「上游 API drift 静默失败数天」那类事故的温床）。
- **D4 更新链自测**：见 §5.2。

## 4 不可回归清单（动手前必读）

### 4.1 磁盘契约

`<userData>`（Windows 为 `%APPDATA%\DSH APP`；旧目录 `DSH App` 启动时一次性 rename 迁移，
`index.ts:772-785`）

| 路径 / 文件                                                            | 语义                                                                                                                    | 位置                                   |
|------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|----------------------------------------|
| `kernel/current.json`                                                  | `{active, previous, installedAt, manifest, sha512?, bundledStamp?}`；`active`/`previous` 是版本目录名，**回滚的唯一依据** | `manifest.ts:48`                       |
| `kernel/dsh-<dshVersion>+suite-<suiteVersion>/`                        | 不可变版本目录，内含 `node/node[.exe]` 与 `app/node_modules/@deepseek-ai/dsh/lib/bin.js`                                 | `manager.ts:455-457,554-561`           |
| `kernel/staging/`                                                      | `runtime.tgz` + `extract/`，装完即删；内置包会被**复制**进 staging，避免清理删掉只读资源                                   | `manager.ts:296,398,428`               |
| `kernel/current.json.corrupt-<pid>-<ts>.bak`                           | 坏 JSON 的改名留档                                                                                                      | `manifest.ts:24`                       |
| `dsh-app-skipped-version.json`                                         | `{version}`                                                                                                             | `updater.ts:454-511`                   |
| `dsh-app-version-history.json`                                         | `[{version,at}]` ≤ 5 条，**倒二条 = 托盘回滚目标**                                                                       | `updater.ts:859`                       |
| `updater-pending-install.json`                                         | `{version,installerPath}`，下次启动清安装包并核对是否真升级                                                              | `updater.ts:973-1023`                  |
| `dsh-app-safe-mode.json`                                               | `{enabled,since}`，删文件即关闭                                                                                          | `safe-mode.ts:16-48`                   |
| `logs/dsh-server-*.log`（留 10 个）、`logs/dsh-kernel.log`（>1 MB 转 `.1`） | 脱敏后的子进程日志                                                                                                      | `server.ts:201-224`、`index.ts:601-620` |

### 4.2 进程契约

- **生产**：`<内核>/node/node[.exe] <desktop host entry>`，`runtimeDir` = `<内核>/app`；
  **dev**：同一个子进程，entry 取本地 checkout 的 `apps/desktop-host/lib/index.js`。
  宿主**不接受** `--patch`，套件行写在 booted profile 自己的 patch 层里。
  `desktop-host.ts`、`index.ts:209-230`
- **无端口**：不绑任何端口，web 面走 fd3/fd4 字节管道（IPC 通道只传 `ready` 与
  `shutdown`）；窗口加载 `dsh-app://app`。`desktop-host.ts`
- **环境注入**：`DSH_APP_DESKTOP=1` + scrub 后的 env + 探测到的本地代理。`server.ts:112-121`
- **健康判定**：303 → 取 `Set-Cookie` → `/` 返回 200；90 s 超时、200 ms 轮询。
  `server.ts:261-298`、`constants.ts:47`
- **重启退避**：第 1 次失败等 1 s 重试；第 2 次回滚（或无 `previous` 时一次性重装内置包）；
  第 3 次弹窗退出；计数器**只在 ready 时清零**。`index.ts:393-437`
- **关闭**：SIGTERM → 8 s → SIGKILL；Windows 上是 `taskkill /T /F`。
  `server.ts:300-323`、`constants.ts:51`

### 4.3 网络契约

- **npm**：`npmjs.org` → `npmmirror.com`（env 可覆盖）。`registry.ts:10-20`
- **内核元数据**：GitHub 官方 **fail-closed**——只有官方**网络层不可达**时才用镜像
  （`ghfast.top`、`gh-proxy.com`）；tarball 则官方 → 镜像逐个验 sha512。
  `artifact.ts:46-58,91-119`、`manager.ts:299-322`
- **Windows shell 更新**：`latest.yml` 走 ModelScope → GitHub → 镜像前缀；资产下载**同源先行**，
  镜像只兜底；sha512 取自 `latest.yml`。`updater.ts:233-281`
- **macOS/Linux**：`electron-updater`，失败只有对话框 + 镜像页。`updater.ts:95-164,950-966`

### 4.4 用户可见流程契约（文案与按钮语义已冻结）

- **首启**：内置 tgz 静默安装，失败在线兜底；「抛错但已激活」按成功启动。`index.ts:724-754`
- **失败恢复**：回滚弹「内核更新启动失败，已回滚到 dsh X」；无 `previous` 时一次性重装内置包；
  再失败按 plugin-tree / port / module / other 分类，plugin-tree 给「以安全模式重启 / 退出」。
  `index.ts:399-437,163-168`
- **更新检查**：6 h 自动检查 = 右下**常驻卡片**（「立即更新到 X」「稍后」，多版本时
  「更新到 X（正式版/候选版/测试版）」）；手动检查 = 模态对话框。
  `update-card.ts:213-246`、`index.ts:476-571,760`
- **已见文案 / 按钮**：「就绪」「内核已更新到 dsh X」「已跳过 DSH APP X…」
  「立即更新 / 跳过此版本 / 取消」、托盘「检查内核更新 / 检查应用更新 / 回滚应用」、
  关窗「最小化到托盘 / 退出程序 / 取消」。`server.ts:51`、`index.ts:385,582,280-298`、
  `updater.ts:521-552`

### 4.5 不变量（不得违反）

1. **built-in 只用语义戳比较**：`bundledStamp = <dshVersion>+<suiteVersion>`；sha512
   **明确不作**比较键（打包产物非逐字节可复现，用 hash 会导致每次启动重解压）。
   `index.ts:707-710`、`manager.ts:440-449`
2. **staging 必清**；激活前 `rm -rf` 目标目录；同名重激活时 `previous` 不自指。
   `manager.ts:340-387,398`
3. **安装中禁止 cleanup**；dev 模式不碰生产内核目录。`manager.ts:517-530`
4. **镜像不可替换内容**：digest 只来自官方元数据。`artifact.ts:18-31`
5. **两条更新链解耦**：内核更新永不要求新的 shell 发布。
6. **主窗口无 preload、sandbox、零 IPC**（`window.ts:77-83`）。新页面不得为此开路；
   需要本地页时用「主进程写静态文件 + `file://`」。
7. **桌面适配只在 shell 侧**：注入 `executeJavaScript` / 样式表 / `--patch` overlay，
   绝不改上游源码。

### 4.6 改动禁区（明确不做的）

- 不把 shell 与 dsh 版本锁死（会变成「每次 dsh 发版必发 shell」）。
- 不引入 `$DSH_HOME` 独占锁（我们与 CLI 共享 `$DSH_HOME` 是既有契约）。
- 不改失败恢复的回滚语义（原子激活 + `previous` 回滚比官方强，保持）。
- **不把内核树放进 asar，也不让内核跑在 Electron 的 Node 上。**
  官方在 2026-09-15 的 `feat(desktop): run runtime host from asar` 里两件都做了：
  dsh 生产树从 `extraResources` 移进 `files`（asar）+ `asarUnpack` 原生模块，
  host 改用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`（开发态才用 `runtime/node`）；
  `profile-packages.ts` 相应加了 `resolutionMode: 'runtime'` 分支。
  但这两条都建立在「后端与 app 同生共死」的前提上，我们照抄会丢掉核心优势：
  - 后端进 asar → 内核无法独立更新，等于放弃双通道；
  - 跑在 Electron 的 Node 上 → 内核与 **Electron 的 ABI** 绑定
    （实测：我们 Electron 33.4.11 自带 Node **20.18.3**、module ABI **130**，
    而内核 tgz 里有 **24** 个 `.node`），于是每次升 Electron 都会让已装内核失效，
    等于把两条更新链重新绑死。
  - 旁证：官方同一提交也**删掉了 `afterPack` / `afterSign` 的 `verifyDesktopRuntime` 产物级校验**
    （现在只在 `prepare-dsh.ts` 构建期校验）。我们不做这个倒退。

  附注：官方 README 尚未同步这次改动（仍写着「dsh runs under the bundled upstream Node.js」、
  「`resources/dsh`」、「Shared package links resolve to those actual directories」），
  三处都与代码不符——**评估上游行为时以代码为准，不要读 README**。

## 5 回归保护

### 5.1 覆盖现状

| 环节                                                            | 自动化覆盖                                           |
|-----------------------------------------------------------------|------------------------------------------------------|
| 内核安装 / 激活 / 回滚 / 清理（`manager.ts:269,277,340,498,517`） | **无**                                               |
| 内置包采纳与 `bundledStamp` 判定（`index.ts:707-717`）            | **无**                                               |
| 在线内核更新全链（探测 → 下载 → sha512 → 解压 → 激活）            | **无**                                               |
| 镜像链回退（内核 `registry.ts:10`）                               | 半（shell 侧有单测，内核侧无）                          |
| Windows 更新 metadata / 资产选择                                | 有（`test/update-sources.test.mjs`，19 例，**未接 CI**） |
| Windows 跳过版本 / 托盘回滚（`updater.ts:459,559,841`）           | **无**                                               |
| macOS/Linux `electron-updater` 分支（`updater.ts:95,950`）        | **无**                                               |
| 首次启动（无内核 → 内置包）（`index.ts:725-747`）                   | **无**                                               |
| `server.ts` 脱敏 / 健康 / 退出（`server.ts:20,144,247`）          | **无**                                               |
| 打包产物（asar / extraResources 内容）                            | **无**                                               |

### 5.2 要补的测试（任务 11 —— **已全部完成**，见 §0 进度）

可复用基础设施：fetch 注入（`test/update-sources.test.mjs:117-134`）、
临时 DSH_HOME + seam 符号链接（`smoke-suite.mjs:469-484`）、
`freePort` / `waitHealthy` / `stopChild`（`smoke-suite.mjs:142,175,211`）、
`killTree`（`check-plugin-compat.mjs:133`）、tgz 解包（`smoke-suite.mjs:81`）、
DOM stub（`probe-update-card.cjs:20-70`）。缺：fake registry、kernel / electron-updater 注入点。

1. **把 `npm test` 接进 CI**（零新代码）：`ci.yml` 的 gate job 加一行。现有 19 个 updater 用例
   **从来没在 CI 里跑过**。
2. **`KernelManager` 状态机单测**：假 tgz + sha512 + 临时 DSH_HOME，覆盖
   install → activate → rollback → cleanup，断言 `current.json` 三个字段与 staging 清理。
   防住「激活半途留下坏指针」「回滚丢 previous」——**任务 5 的前置**。
3. **`bundledStamp` 采纳判定矩阵**：把 `index.ts:689-747` 的判定提为纯函数后测（已装同版不重装 /
   已装更新版不降级 / 损坏要重装 / 无 manifest 要重装）。防住「每次启动重装」与
   「在线内核被内置包降级」。
4. **`server.ts` redact + 健康超时单测**：防住 token 进日志、启动失败误判（需小幅重构导出）。
5. **Windows 跳过 / 回滚单测**：复用 fetch 注入模式。**任务 4 的前置**。

顺序：1（立刻）→ 2 + 3 → 5 → 4。

### 5.3 改动 × 风险

| 任务       | 碰到的契约                | 危险现象                                                  | 守卫                                                     |
|------------|---------------------------|-----------------------------------------------------------|----------------------------------------------------------|
| 3 镜像     | §4.3、§4.5-4               | 镜像被当成元数据源 → 可掉包；镜像 404 被误判成「版本不存在」 | 不变量不变；给 `artifact.ts` 候选链补单测                 |
| 4 差分     | §4.3、§4.4、pending-install | 差分成品未过 sha512 就装；旧安装包被清理后差分失效却不回退 | 「差分失败必须回退全量」写死；两路径共用同一校验函数；§5.2-5 |
| 5 分层 tgz | §4.1、§4.5-1/2             | 语义不兼容 → **回滚找不到 previous**                      | 向后兼容 + §5.2-2 + 实机升级演练                         |
| 6 pnpm     | §4.1、§4.2                 | 布局微变 → 内核起不来                                     | 双产出对比；`smoke-suite --tgz` + `check:plugins`         |
| 7 插件出包 | §4.2、离线首启             | 无网用户装不起来                                          | 保留内置兜底；补「无内核首启」用例                          |
| 1 启动页   | §4.2、§4.5-6               | 引入 preload 破坏安全姿态；双窗口抢焦点                    | 「静态文件 + `file://`」；不改主窗口创建时机                |
| 2 更新 UX  | §4.4                      | 用户按记忆点击落空                                        | 先在 mac/Linux 落地，Windows 后跟；文案按 §4.4 冻结        |

## 6 执行顺序

**先筑网，再改造；一次只改一层契约。**

| 阶段  | 任务                                                                          |
|-------|-------------------------------------------------------------------------------|
| **0** | **11（筑网）** —— 纯新增，零风险，是后面全部的前置                                |
| 1     | 0（无签名缓解）、1（首启可见性）、2（更新 UX）、3（镜像）—— 不动磁盘契约，可并行          |
| 2     | 5（分层 tgz，**单独一批**）—— 作用在「每次 dsh 发版」这个高频事件上，收益大于差分化 |
| 3     | 4（差分，强制回退全量）—— **实测只省 44%（详见 §2.2），已降级**；仍按单独一批处理    |
| 4     | 6（pnpm 化，**与阶段 2 不同批**）                                                |
| 5     | 7（插件出包）、8（C1–C5）、9（i18n）                                                  |
| 全程  | 10（护栏）先于 8 铺                                                             |

**验收原则（双向）**：每项必须同时给出「更好」与「不回归」的证据，缺一不算完成——
判据写在各任务的「验收」「不回归」里。

## 7 交付测试清单（人工验收）

自动化能给的证据已经跑完（见 §0 的进度块）。下面是**只有你能测**的部分，按性价比排序：

| #  | 怎么测                                                                                                                                                                       | 期望                                                                                                                                                                                                                                                                                                                                                                                |
|----|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | 删掉 `<userData>/kernel` 后 `npm run dev`（或装好的应用）冷启动                                                                                                                | 启动页全程可见、步骤推进、主窗口出现时**不留白**；结束后启动页消失；**末尾应出现一行「运行时已校验 · sha512 …」**（层装配安装则显示「N 个层已逐层校验」；dev 模式**不应**出现该行——那里什么都没校验）                                                                                                                                                                                          |
| 2  | 把安装包里 `kernel.tgz.sha512` 故意改坏再启动                                                                                                                                | 出现失败卡（重试 / 打开日志目录 / 退出），而不是静默退出；**文案应是分层过的**——摘要不符时要说「已中止以防被篡改，请更换网络」，**不应出现「稍后重试」**（那是给网络类的建议）；网络类才说「已尝试 N 个来源，请检查网络与代理」；dev 模式卡上还应有一行「先在该目录执行 `pnpm install && pnpm run build`」                                                                                             |
| 3  | Windows 走一次应用更新                                                                                                                                                       | 文案、按钮、跳过语义、托盘回滚**与改动前完全一致**（我逐条比对过，但要真机确认）                                                                                                                                                                                                                                                                                                          |
| 4  | 按 README 的「下载与安装」章节装一次（Windows / macOS）                                                                                                                          | SmartScreen 点「更多信息 → 仍要运行」可装；macOS 从「系统设置 → 隐私与安全性 → 仍要打开」可开                                                                                                                                                                                                                                                                                            |
| 5  | 内核更新（等一个 dsh 新版本，或本地 `npm run verify -- --tgz <新产物>`）                                                                                                        | 日志显示按层装配；**只有变化的层被下载**；把层 URL 打不通时能自动回退单 tgz 并装成功                                                                                                                                                                                                                                                                                                  |
| 6  | `npm run dist:win` 后 `npm run smoke:package`                                                                                                                                | 15/15 通过（asar 关键条目、`dist/static` 只许有启动页、内置内核三件套与目标平台匹配）                                                                                                                                                                                                                                                                                                   |
| 7  | 打开设置页的「**诊断**」（排序见下方第 13 项）：桥状态、日志尾、点「打开日志目录」                                                                                                    | 状态显示「可用」；日志尾有内容且自动滚到底；点按钮真的打开资源管理器到日志目录；把桥弄不可用（例如 dev 下不注入 env）时应显示「不可用」并置灰按钮，而不是报错                                                                                                                                                                                                                                 |
| 8  | `npm run check:graph`                                                                                                                                                        | `ok — no violations`                                                                                                                                                                                                                                                                                                                                                                |
| 9  | `npm test` · `python .github/scripts/test_mirror_release.py` · `npm run typecheck`                                                                                           | 145 / 102 / 干净                                                                                                                                                                                                                                                                                                                                                                    |
| 10 | `node scripts/split-runtime-layers.mjs runtime-dist/<tgz>`                                                                                                                   | 5 层 + `verify ok — 25450 files reproduced exactly`                                                                                                                                                                                                                                                                                                                                 |
| 11 | 验证语言：`DSH_APP_LOCALE=en-US` 启动看**壳**（启动页骨架/状态行、托盘、对话框、更新卡）；再在 UI 里把语言切成英文看**插件页**                                                      | 壳与 UI 都应为英文；切回中文时**逐字与从前一致**（zh 是权威文案）；**已知缺口**：除 websearch 外其余插件的宿主半文案仍是中文（wire 原文直显，同一合同可照搬）；插件页里已在屏的旧消息不一定即时重译（需刷新/重进页面）。**网络搜索页已修**：英文模式下应只剩英文（含引擎提示、来源不可用原因、保存被拒的提示）                                                                                       |
| 12 | **启动文件夹（C5）**：用 `dsh-app.exe D:\某个项目` 启动（或把文件夹拖到 exe / 安装好的图标上）；再用一个**不存在的路径**启动一次；最后**保持应用运行**，再启动一次带别的文件夹的实例 | 每次都应把该文件夹开成工作区（会话里 cwd 就是它）；**不存在的路径**应弹出「无法打开文件夹 / 这个文件夹不存在或无法访问」的卡片（不是静默无反应）；**应用已在运行时**第二次启动应**聚焦现有窗口**（不重载、不开第二个窗口），并且同一文件夹重复启动**不堆空会话**（复用原来的空白会话）；两个反向检查：`npm run dev`（即 `electron .`）**不应**把仓库当工作区打开，安全模式下也只静默跳过               |
| 13 | **设置导航（顺序 / 滚动 / 图标）**：把窗口高度缩到约 620px 再打开设置；滚动左侧列表到底；看「诊断」「模型高级设置」两行的图标                                                         | 列表**能滚动**且最后一行（已归档会话）可达（修复前 4 行被裁且滚不动）；顺序应为：通用设置 → 模型 → 模型高级设置 → MCP 服务器 → Hooks → 网络搜索 → 插件 → 用量统计 → 并行子代理 → Agent 预设 → 预设包 → **诊断** → 会话记忆 → 会话归档 → 已归档会话；「诊断」应是**心跳线**图标（不再是通用齿轮）、「模型高级设置」仍是立方体；**注意**：侧边栏底部那个「插件市场」按钮不在这个列表里，别把它当成导航项 |
| 14 | **启动页（品牌 / 主题）**：把 UI 的「外观」切成深色（或改成「跟随系统」后切换系统深色模式），再冷启动一次看启动页                                                                      | 品牌行应出现：鲸鱼标 + `DSH APP` + 版本号；**浅色 = 蓝底方块 + 白鲸，深色 = 去掉底块的白色鲸鱼字形**（跟着 `ui-theme.preference` 走，不是只看系统）；启动页底色应与主界面同色，**不应有白闪**；深色下「关闭窗口」弹窗的「最小化到托盘」与更新卡的「立即更新」按钮文字必须看得见（此前是白字白底）；正常状态**不应出现滚动条**（失败卡可以滚）                                                           |

**需要发版才能验的（本机无法验）**：真实 ModelScope 上传/删除与镜像保留、CI 的层资产上传与 6 cell 矩阵、
签名与公证、Windows 差分的真机 `To download:` 数值。

**发版前必做 —— 本轮踩到的一个真陷阱（已修）**：`suiteVersion` 是**插件 `package.json` 版本号**的哈希
（`scripts/kernel-line.mjs:167`），**不是代码内容的哈希**。因此只改插件代码、不动版本号时，两个机制都会
让新代码悄悄发不出去：① CI 的 `resolve` job 看到 `suiteVersion` 相同时会**整块跳过 runtime 矩阵**，
直接复用已发布的 `runtime-<dshVersion>`；② 已安装的应用按 `bundledStamp`（`<dshVersion>+<suiteVersion>`）
判定「内核没变」，**不重装**。本轮已把 16 个有改动的套件插件各 bump 一个 patch 级版本
（`scripts/kernel-line.mjs --json` 的 `suiteVersion` 随之变为 `b23068bc`），所以下次发版会真的重建产物。
**今后任何 `plugins/` 下的改动都要跟着 bump 那个插件的版本**——注意 `plugin-fff` 本轮无改动、未 bump。

## 附录：最容易踩的 8 个雷

1. 改 tgz 内 `runtime/node` / `runtime/app` 布局或 `bin.js` 路径 → 内核起不来。
2. 改版本目录命名 → `current.json` / 回滚找不到 `previous`。
3. 改 `bundledStamp` 或 `resources/kernel/manifest.json` 结构 → 每次启动重装，或漏采纳内置包。
4. 安装中触发清理，或放松 sha512 校验 → 下载被删 / 镜像可掉包。
5. 改 `dsh-app://` 协议注册或到子进程的转发 → 窗口白屏（该 scheme 必须在 `app.ready`
   之前注册为 privileged，且只服务那一个子进程）。
6. 改 spawn 的 stdio 布局或 fd3/fd4 帧格式 → 子进程起不来，或响应管道停止排空而卡死。
7. 改更新文案 / 按钮 / 跳过语义 → 用户按记忆点击落空。
8. 改 `latest.yml` 解析、`-win-<arch>.exe` 命名或 base64 sha512 约定 → Windows 更新与
   托盘回滚失败。
