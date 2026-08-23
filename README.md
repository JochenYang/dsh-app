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
| 会话侧边栏（原生视图）：**文件页**——工作区目录树（懒加载、自动展开根目录）、文本/图片/Markdown 预览（目录与预览区独立滚动）；**Git 页**——按目录分组的变更列表、统一 diff 双行号、暂存/还原/提交、仓库文件列表、Git 图谱（点提交查看标题/正文/文件统计） | `@dsh-app/plugin-sidebar`（host + client 双面） | `plugins/plugin-sidebar/src/client/{file-tree,git-tab}.tsx` |
| 对话 minimap：右侧纵向导航条，每条消息一个刻度；悬停显示内容预览、点击跳转；仅在「对话」页渲染，长会话自动压缩刻度间距 | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/minimap.tsx` |
| 模型高级设置页：llm-pi-ai 模型级编辑器与整表管理（推理强度、输入模态、兼容开关）；目录外模型的伴生路由迁移；models.dev 表单预填（直连失败自动回退 gh-proxy 镜像） | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/models-advanced/` |
| 品牌主题与全中文 UI：`--dsw-alias-*` 令牌覆盖 | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client.ts:58` |

套件接线（每次 server 启动自动完成，`src/main/brand-suite.ts`）：

1. **模块解析**：三个插件链接进 `$DSH_HOME/profiles/node_modules/@dsh-app/`（Windows 为 junction）；
   开发源是仓库 `plugins/*`，生产源是激活内核里的 `app/node_modules/@dsh-app/*`。
2. **加载器覆盖**：`plugins/dsh-app.patch.yml` 拷入 userData，经 `dsh web --patch` 注入三个插件条目
   （应用在官方 bundle 层之后，last write wins，无需改上游 profile 模板）。

两条接缝均**优雅降级**：内核缺少套件插件（例如回滚目标）时原样启动、无阻塞。

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

开发模式下外壳会在本地 checkout 里 spawn `pnpm dsh web`（随机空闲端口），
不下载、不产生内核产物。dev 启动比生产版慢很多：pnpm + tsx 即时转译全部 TypeScript
源码是主要开销；生产版直接 spawn 预编译的 `lib/bin.js`，秒级就绪。

### 指定其他 checkout

```powershell
$env:DSH_APP_DEV="1"; $env:DSH_APP_DEV_RUNTIME="D:/codes/DSH-APP/deepseek-harness"; npm start
```

### 开发环境的已知差异

| 项目 | 开发模式 | 生产模式 |
|---|---|---|
| 内核来源 | 本地 checkout（`pnpm dsh web`，tsx 即时编译） | `userData/kernel/` 预装运行时（直连 node 二进制） |
| 启动速度 | 慢（10 秒级） | 快（2 秒级） |
| 更新检查 | 跳过（钉在 checkout） | 每 6h 自动 + 托盘手动 |

## 内核更新系统

应用自带版本化内核（`userData/kernel/`），不依赖系统是否安装过 dsh。更新链路：
解析 npm registry 的 dist-tag 版本 → 从 GitHub Releases 下载运行时产物 → 与附带的
sha512 比对校验 → 原子激活（旧版保留为 `previous`）→ 连续启动失败 2 次自动回退上一版。
内核运行时布局与更新流程详见 [ARCHITECTURE.md §4–5](docs/ARCHITECTURE.md)。

**内置运行时漂移检测**：升级安装时，如果新版本内置的运行时内容与磁盘上同名内核目录
不一致（例如套件新增了插件），启动时会自动检测（sha512 对比 + 版本守卫）并重新激活
内置运行时——不会静默沿用旧内容导致插件缺失；在线更新过更新的内核也不会被降级覆盖。

### 应用（外壳）更新

Windows 使用自定义链路；macOS / Linux 使用 `electron-updater`。

1. 检测：`github.com/<owner>/<repo>/releases/latest/download/latest.yml`（镜像回退）
2. 下载：按架构选择安装包，官方直链优先、ghfast.top / gh-proxy.com 依次回退
3. 校验：sha512 与 latest.yml 比对，镜像永远替换不了内容
4. 安装：**可视化安装向导**——点击「立即安装」后关闭应用、打开与首次安装相同的
   NSIS 向导（安装进度全程可见），完成后自动启动应用，安装包自动删除（取消安装也会删除）

### 中国大陆网络适配（不挂梯子也能更新）

两条更新链路都有回退链，默认开箱即用：

| 链路 | 官方源 | 回退 | 覆盖方式 |
|---|---|---|---|
| 版本解析 | `registry.npmjs.org` | `registry.npmmirror.com` | `DSH_APP_NPM_REGISTRIES`（逗号分隔）或 `NPM_CONFIG_REGISTRY` |
| 产物下载 | `github.com` Release | `ghfast.top`、`gh-proxy.com`（依次尝试） | `DSH_APP_GITHUB_MIRRORS`（逗号分隔前缀；置空 = 关闭镜像） |

安全模型：**sha512 元数据优先从官方 GitHub 获取**，镜像只在大文件下载阶段参与，
且每个下载候选（官方 + 每个镜像）都用同一份可信 sha512 校验——镜像被劫持也换不掉内容。

连通性自检（在目标网络环境跑一遍）：

```powershell
node scripts/probe-mirror.mjs
```

## 桌面化适配

外壳通过运行时注入为 Web UI 补桌面体验，harness 源码零改动：窗口拖拽、原生窗口按钮
让位、顶栏配色实时同步、全中文 UI。品牌功能（侧边栏、minimap、模型页等）通过上面的
插件套件以 `--patch` 覆盖与 slot 注入实现，同等零上游改动。注入实现细节见
[ARCHITECTURE.md §2](docs/ARCHITECTURE.md)。

部分做法借鉴自 pilot-harness 的 `apps/desktop`（进程树终止、日志凭据脱敏、
从子进程 stdout 解析 settled URL、loopback-only URL 校验等）。

## 构建分发

```sh
npm run dist:win     # NSIS 安装器（x64 + arm64）
npm run dist:mac     # dmg + zip（x64 + arm64，公证走环境变量）
npm run dist:linux   # AppImage + deb（x64 + arm64）
```

内核运行时产物由 `scripts/build-runtime.mjs` 构建（每个 platform/arch 一份），
CI 工作流发布到 GitHub Releases：

```sh
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.8
```
