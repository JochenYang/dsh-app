# DSH App

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的品牌桌面客户端。
Windows / macOS / Linux，面向公开发布。

## 一段话架构

DSH App 是围绕本地 dsh 服务的 **Electron 薄外壳**。它捆绑一个版本化的**内核运行时**
（dsh + 品牌插件套件），负责其完整生命周期（首装、更新、回滚），并在一个沙箱窗口里
渲染现成的 dsh Web UI。品牌功能全部是 **dsh 插件**，绝不 fork 上游——上游 dsh 发布新版时，
应用只需换内核，套件原样保留。

```
┌─ Shell（Electron）   窗口 / 托盘 / 生命周期 / 外壳自更新
│    └─ BrowserWindow → http://127.0.0.1:<port>
├─ Kernel runtime     userData/kernel/<version>/   （不可变，原子切换）
│    ├─ node/         Node.js 二进制（随产物打包）
│    ├─ app/          npm 安装好的 dsh + @dsh-app/plugin-*
│    └─ manifest.json 版本 + sha512
└─ Brand suite        plugin-brand（host）+ plugin-client-ui（client）
```

详细设计（更新机制、回滚、渠道、打包）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

应用**不依赖**系统里是否安装过 dsh，只认 `userData/kernel/` 下自管理的版本化内核：

1. **解析版本**：查 npm registry 上 `@deepseek-ai/dsh` 的 dist-tag（stable=`latest`，
   beta=`rc`，`DSH_APP_CHANNEL=beta` 切换）。
2. **下载产物**：GitHub Releases 取 `dsh-runtime-<platform>-<arch>-<version>.tgz`。
3. **校验**：与 Release 附带的 `.sha512` 比对（镜像同样校验，见下）。
4. **激活**：解压进版本目录 → 原子改写 `current.json`（旧版保留为 `previous` 供回滚）。
5. **回滚**：新内核连续启动失败 ≥2 次自动退回上一版。

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

## 桌面适配（外壳注入，不动 harness）

外壳在页面加载时注入一小段桌面样式（`<style id="dsh-desktop-chrome">`），harness 源码零改动：

- **窗口拖拽**：侧栏 logo 行与会话顶栏标题行设为 `-webkit-app-region: drag`，
  其中所有按钮/链接/输入框设 `no-drag`——空白可拖窗，控件可点击；
- **原生按钮让位**：右栏折叠时给顶栏 utilities 区让出窗口按钮宽度，导出等按钮不被遮挡；
- **右上角配色实时同步**：观察器事件驱动（非轮询）——DOM/主题/尺寸一变即采样窗口按钮下方
  的实际有效颜色（含全屏遮罩的 alpha 合成），颜色变化时才推给外壳设置 `titleBarOverlay`；
- **中文 UI**：托盘菜单、安装向导、全部状态文案与弹窗均中文化。

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

## 首次公开发布前（清单）

- [ ] `electron-builder.yml` 设置 `publish.owner`（GitHub org/user）。
- [ ] `src/main/index.ts` 设置 `DSH_APP_ARTIFACT_OWNER/REPO` 默认值或环境变量
      （当前占位符 `YOUR_GITHUB_OWNER` 必须替换，否则生产版无法解析产物）。
- [ ] macOS：Apple 开发者账号 → `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、
      `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` 密钥。
- [ ] Windows：代码签名证书 → `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`
      （可选；不签会有 SmartScreen 警告）。
- [ ] `resources/icon.png` 换成正式品牌图标（512×512）。
- [ ] 品牌套件发布到 npm，`scripts/build-runtime.mjs` 从 `file:` 引用切到 registry 引用。
- [ ] 开发循环里接好 `plugins/plugin-brand` 服务与 `plugins/plugin-client-ui` 槽位组件（M3）。

## 仓库结构

```
src/main/        Electron 外壳（入口、窗口、托盘、服务、更新器、IPC）
src/kernel/      内核运行时管理器（manifest、sources、integrity、生命周期）
src/shared/      常量 + 共享类型
static/          安装向导窗口（首装 UI，中文）
plugins/         品牌 dsh 插件套件（host + client）
scripts/         静态拷贝 + 内核产物构建 + 镜像连通性探针
.github/         CI：三平台应用构建 + 内核产物矩阵
```
