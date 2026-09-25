<p align="center">
  <img src="resources/icon.png" alt="DSH APP" width="128">
</p>

<h1 align="center">DSH APP</h1>

<p align="center">
  DeepSeek Harness（dsh）的品牌桌面客户端，由社区开发者维护。<br>
  Windows / macOS / Linux，面向公开发布。
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

外壳自带一份版本化的 dsh 运行时（更新/回滚自管理），在沙箱窗口渲染官方 dsh Web UI；
品牌功能以 dsh 插件套件实现，不 fork 上游。分层、内核运行时布局、更新与回滚机制、打包等
架构设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 封装客户端功能

DSH APP 是 **self-contained、no-fork** 的封装客户端：内核自托管（`userData/kernel/`，原子激活 + 回滚），
功能全部以 dsh 插件套件（`plugins/`）叠加在上游 kernel 上，上游发布只是一个普通内核更新。
当前插件能力：

| 功能 | 插件 | 实现位置 |
|---|---|---|
| 会话侧边栏（原生视图）：**Git 页**——按目录分组的变更列表、统一 diff 双行号、暂存/还原/提交、仓库文件列表、Git 图谱（点提交查看标题/正文/文件统计）。文件树页已退役：上游侧边栏原生提供工作区文件管理 | `@dsh-app/plugin-sidebar`（host + client 双面） | `plugins/plugin-sidebar/src/client/git-tab.tsx` |
| 模型高级设置页：llm-pi-ai 模型级编辑器与整表管理（推理强度、输入模态、兼容开关）；声明推理强度自动填充兼容开关（`supportsDeveloperRole` false + `maxTokensField`，仅增量、不覆盖用户显式设置）；目录外模型的伴生路由迁移；models.dev 表单预填（直连失败自动回退 gh-proxy 镜像） | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/models-advanced/` |
| 品牌主题与中英双语 UI：`--dsw-alias-*` 令牌覆盖 | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client.ts:58` |
| 品牌鲸鱼背景：空闲静态帧、悬停时指针散开（指针离开即暂停渲染循环，滚动不卡顿）；主题感知对比度（亮色增强可读性、暗色低透明度水印）；悬停悬浮于输入框上方、活跃时放大并居中于会话列 | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/whale-background.ts` |
| 跨会话记忆：`memory_save`/`memory_recall`/`memory_forget` 工具 + 系统提示注入（预算内最新优先），全局与项目记忆按会话 cwd 路由；设置页开关；后台提炼在会话静默 60 秒后直调模型回填要点（每次调用的 token 与耗时记录在案），策展清扫按冷却窗口与文件变更检测触发（同样直调模型） | `@dsh-app/plugin-memory` | `plugins/plugin-memory/src/{tools,routes,distiller,curator}.ts` |
| 批量子代理编排：独立子任务并行派发给可继续的子代理，自适应并发门控（失败收缩、连续成功增长）、保留会话的逐项自动重试、按子代理标识恢复；`swarm` 工具 + `/swarm` 命令 | `@dsh-app/plugin-swarm` | `plugins/plugin-swarm/src/orchestrator.ts` |
| 用量统计：余额卡（官方 deepseek providers、CNY 闲时/高峰双档计价、密钥不出主机）、每日使用热度图与趋势图；余额 5 分钟 TTL 缓存（single-flight，挂载静默刷新、点击卡片强制重查） | `@dsh-app/plugin-usage` | `plugins/plugin-usage/src/client/usage-section.tsx` |
| 会话归档管理：按项目工作目录分组（可折叠、键盘支持）、两步删除确认；删除经 `resolveCurrentLog` 物理移除会话日志目录（迁移前格式的会话回退到按后端布局定位），归档记录保留为可见性栅栏、由面板「清理」回收 | `@dsh-app/plugin-archives` | `plugins/plugin-archives/src/client/archives-section.tsx` |
| 交付审阅：文件改动卡片、单栏差异悬停预览 | `@dsh-app/plugin-sidebar`（host+client） | `plugins/plugin-sidebar/src/index.ts` |
| MCP 服务器管理：设置页增删改查、动态挂载/卸载，服务器工具以原生 `mcp__<server>__<tool>` 注册；读取时掩码密钥值 | `@dsh-app/plugin-mcp`（双面） | `plugins/plugin-mcp/src/client/mcp-section.tsx` |
| 外部 hooks 桥：对 Claude Code / Codex 的 `hooks.json` 做设置页增删改查，挂载为生效的 hook 实例（拦截提示词、工具与轮次） | `@dsh-app/plugin-hooks`（双面） | `plugins/plugin-hooks/src/client/hooks-section.tsx` |
| Office 文档转换：`office_to_pdf` 工具把 docx / xlsx / pptx / pdf 源文件转成 PDF；转换引擎（LibreOffice）按需从诊断页安装，不在运行时里；字体缺失逐族上报 | `@dsh-app/plugin-doc` / `plugin-sheet` / `plugin-ppt` / `plugin-pdf`（host 工具 + 双面技能预填） | `plugins/plugin-{doc,sheet,ppt,pdf}/src/` |
| 网络搜索：`web_search` / `web_fetch` 以 provider 形式接入（品牌引擎链 anysearch / Bing / Parallel / Exa / SearXNG，一键自检），host 侧只发稳定错误码 | `@dsh-app/plugin-websearch`（双面） | `plugins/plugin-websearch/src/` |
| 插件市场：设置页浏览 / 安装 / 卸载第三方 dsh 插件（走内核 CLI 安装进当前 profile，pnpm 策略由市场处理） | `@dsh-app/plugin-market`（双面） | `plugins/plugin-market/src/` |
| 预设包：设置页面板导入 / 导出品牌与上游配置组合 | `@dsh-app/plugin-presets`（双面） | `plugins/plugin-presets/src/` |
| 品牌桥：应用信息、诊断事实源与桌面动作路由（host 半边仍在脚手架阶段） | `@dsh-app/plugin-brand`（host） | `plugins/plugin-brand/src/routes.ts` |

套件接线（每次 server 启动自动完成，`src/main/brand-suite.ts`）：

1. **模块解析**：套件插件链接进共享回落目录 `$DSH_HOME/profiles/node_modules/@dsh-app/`（Windows 为 junction）——
   该目录从任何 profile 都能解析到，且不会被任何 profile 的 pnpm 清理；
   开发源是仓库 `plugins/*`，生产源是激活内核里的 `app/node_modules/@dsh-app/*`。
2. **套件自有 profile**：内核以 `--profile dsh-app` 启动，你在终端里的 `dsh` / `dsh web` 仍用 `web`。
   首次运行会在后台建好新 profile 并把你手写的 patch 层（禁用行、MCP 行）带过去；
   **第三方包不搬**——它们在应用内的插件市场里重装到新 profile，因为市场才懂 pnpm 的发布冷静期策略、
   构建脚本放行和失效规格这些事（搬整棵树的两种做法都实测过并被否决：复制会被 Windows 的
   `.pnpm` 符号链接权限卡住，按 lockfile 重装会撞 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。
   建好并落 marker 后下次启动才切换；失败则继续用 `web` 启动并在下次重试。生效的 profile 通过
   `DSH_APP_PROFILE` 传给内核，所以插件市场与预设总是装到应用真正读取的那个 profile。
3. **加载器覆盖**：`plugins/dsh-app.patch.yml` 拷入 userData，经命令行 `--patch` 注入
   （应用在官方 bundle 层之后，last write wins，无需改上游 profile 模板）。

每一环都**优雅降级**：内核缺少套件插件（例如回滚目标）时原样启动、无阻塞。

## 下载与安装（用户）

从 [Releases](https://github.com/JochenYang/dsh-app/releases) 下载对应平台的安装包；
中国大陆网络也可改用 ModelScope 镜像，见下方「中国大陆网络适配」。

> **当前版本未做代码签名。** 本项目是社区维护的免费项目，没有购买签名证书，因此两个平台各自
> 会弹一次系统安全提示。这是预期行为，按下面步骤操作即可完成安装——不影响功能与后续更新。

- **Windows**：双击安装包后若出现「Windows 已保护你的电脑」（SmartScreen）→ 点「更多信息」→
  「仍要运行」，然后按向导走完。
- **macOS**：双击 dmg 若提示「无法验证开发者」或「已损坏，无法打开」→ 打开
  **系统设置 → 隐私与安全性**，在「安全性」一栏点「仍要打开」，再确认一次。
  macOS Sequoia（15）起已移除「右键 → 打开」的绕过方式，必须走系统设置这一步。

装好之后，除了双击启动，还可以**把一个文件夹交给它**：

- Windows：`dsh-app.exe "D:\某个项目"`，或把文件夹直接拖到 exe / 桌面快捷方式上。
- macOS：`open -a "DSH APP" /path/to/project`。

它会把这个文件夹登记成工作区并直接开一个会话（会话的 `cwd` 就是它）。若应用**已经在运行**，
再次这么启动只会**聚焦现有窗口**并把新文件夹开成工作区——不会起第二个窗口。路径不存在时会弹一张
说明卡，而不是静默无反应。

## 快速开始（开发）

需要 Node.js 22+ 与 pnpm。开发内核 = 本地的 deepseek-harness checkout。

前置（一次性）：

```powershell
# 1. 本仓库旁有 deepseek-harness checkout（../deepseek-harness），
#    并且已装好依赖、构建过 web 前端：
cd ../deepseek-harness
pnpm install
pnpm run build:web

# 2. 安装外壳依赖
cd ../dsh-app
npm install
```

启动（**注意：Windows PowerShell 不支持 `VAR=1 cmd` 语法**）：

```powershell
# PowerShell
$env:DSH_APP_DEV="1"; npm start
```

```bat
:: cmd
set DSH_APP_DEV=1 && npm start
```

开发模式下外壳用本地 checkout 顶替内核：走同一个 desktop host 子进程
（entry 取 `apps/desktop-host/lib/index.js`，`allowLinkedProfile` 让链接式
profile 得以启动），不下载、不产生内核产物。dev 与生产都不绑端口，窗口都加载
`dsh-app://app`。

### 指定其他 checkout

```powershell
$env:DSH_APP_DEV="1"; $env:DSH_APP_DEV_RUNTIME="D:/codes/DSH-APP/deepseek-harness"; npm start
```

### 开发环境的已知差异

| 项目 | 开发模式 | 生产模式 |
|---|---|---|
| 内核来源 | 本地 checkout（desktop host 子进程） | `userData/kernel/` 预装运行时（直连 node 二进制） |
| 启动速度 | 秒级，不需要镜像 | 通常秒级；rc 线要把运行时镜像进 profile，首启与被插件市场改动过之后会多花十几秒重建（实测 14–17 秒），之后按标记跳过；Windows 安装器在安装阶段已预解包内核，首启不付解包代价 |
| 更新检查 | 跳过（钉在 checkout） | 每 6h 自动 + 托盘手动 |

## 内核更新系统

应用自带版本化内核（`userData/kernel/`），不依赖系统是否安装过 dsh。更新链路：
解析 npm registry 的 dist-tag 版本 → 按「ModelScope 镜像 → 官方 → 公共代理」的候选链下载
运行时产物（每个候选用官方 sidecar 的 sha512 校验）→ 原子激活（旧版保留为 `previous`）→
连续启动失败 2 次自动回退上一版。
内核运行时布局与更新流程详见 [ARCHITECTURE.md §4–5](docs/ARCHITECTURE.md)。

**内置运行时漂移检测**：升级安装时，如果新安装包内置的运行时与磁盘上已 adopt 的版本戳
（`<dsh 版本>+<套件版本>`，记录在 `current.json` 的 `bundledStamp`）不一致（例如套件新增了插件），
启动时会自动重新解压并激活内置运行时——不会静默沿用旧内容导致插件缺失；在线更新过更新的内核
也不会被降级覆盖（版本戳相等即跳过，打包产物不逐字节可复现，所以比较的是版本戳而非 sha512）。

### 应用（外壳）更新

Windows 使用自定义链路；macOS / Linux 使用 `electron-updater`。

1. 检测：`github.com/<owner>/<repo>/releases/latest/download/latest.yml`（镜像回退）
2. 下载：按架构选择安装包，ModelScope 镜像优先、官方直链次之、ghfast.top / gh-proxy.com 再回退
3. 校验：sha512 与 latest.yml 比对，镜像永远替换不了内容
4. 安装：**可视化安装向导**——点击「立即安装」后关闭应用、打开与首次安装相同的
   NSIS 向导（安装进度全程可见），完成后自动启动应用，安装包自动删除（取消安装也会删除）

### 中国大陆网络适配（不挂梯子也能更新）

两条更新链路都有回退链，默认开箱即用：

| 链路 | 官方源 | 回退 | 覆盖方式 |
|---|---|---|---|
| 版本解析 | `registry.npmjs.org` | `registry.npmmirror.com` | `DSH_APP_NPM_REGISTRIES`（逗号分隔）或 `NPM_CONFIG_REGISTRY` |
| 产物下载 | `github.com` Release | ModelScope 镜像（`modelscope.cn`，字节优先）、`ghfast.top`、`gh-proxy.com`（依次回退） | `DSH_APP_GITHUB_MIRRORS`（逗号分隔前缀；置空 = 关闭镜像） |

安全模型：**sha512 元数据（latest.yml / sidecar / manifest）优先从官方 GitHub 获取**；大文件
下载 ModelScope 镜像优先、官方次之、公共代理兜退，且每个下载候选（镜像 + 官方 + 每个代理）
都用同一份可信 sha512 校验——镜像被劫持也换不掉内容。内核运行时与外壳安装包走同一条字节链：
下载发生在外壳进程，不经代理注入，所以挂不挂梯子都优先走国内可达的镜像。

连通性自检（在目标网络环境跑一遍）：

```powershell
node scripts/probe-mirror.mjs
```

## 桌面化适配

外壳通过运行时注入为 Web UI 补桌面体验，harness 源码零改动：窗口拖拽、原生窗口按钮
让位、顶栏配色实时同步、中英双语 UI。品牌功能（侧边栏、模型页等）通过上面的
插件套件以 `--patch` 覆盖与 slot 注入实现，同等零上游改动。注入实现细节见
[ARCHITECTURE.md §2](docs/ARCHITECTURE.md)。

另一个桌面侧的接缝是**启动文件夹**：把文件夹作为启动参数交给外壳后，它经页面上一个全局函数
（`window.__dshAppOpenWorkspace`，由套件插件安装、外壳用 `executeJavaScript` 调用）把它开成工作区；
内核没有该插件时（回滚目标、安全模式）静默跳过，启动照常。实现见 `src/main/workspace-launch.ts`。

## 构建分发

```sh
npm run dist:win     # NSIS 安装器（x64 + arm64）
npm run dist:mac     # dmg + zip（x64 + arm64，公证走环境变量）
npm run dist:linux   # AppImage + deb（x64 + arm64）
```

应用图标：`resources/icon.png` 当前为占位品牌图标，发布前请替换为正式图标；
`npm run icon:gen` 生成占位图标，`npm run icon:build` 由它裁剪多尺寸 PNG + ICO（需 Pillow）。

内核运行时产物由 `scripts/build-runtime.mjs` 构建（每个 platform/arch 一份），
CI 工作流发布到 GitHub Releases：

```sh
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.8
```
