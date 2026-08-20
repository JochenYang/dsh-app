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
品牌功能以 dsh 插件实现，不 fork 上游。分层、内核运行时布局、更新与回滚机制、打包等
架构设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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
内核运行时布局与更新流程详见 [ARCHITECTURE.md §3–4](docs/ARCHITECTURE.md)。

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
让位、顶栏配色实时同步、全中文 UI。注入实现细节见
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
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.7
```
