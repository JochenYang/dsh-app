# Changelog

DSH APP 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更（不含历史全量），
与 GitHub Release 的 release notes 保持一致。发布流程见 `AGENTS.md` §10。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.7]`），然后运行
`node scripts/gen-release-notes.mjs v0.1.7` 生成双语 notes。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，新条目加在列表顶部。

## [v0.3.0] - 2026-08-23

### 中文
- 新增会话侧边栏（会话页「文件」「Git」两个原生视图）：文件页浏览工作区目录树并预览文本与图片；Git 页按目录分组展示变更、双行号统一 diff 预览、暂存/还原/提交、仓库文件列表，以及居中 Git 图谱——点击提交查看完整正文与文件统计
- 新增模型高级设置页：为 llm-pi-ai 模型提供模型级编辑器与整表管理（推理强度、输入模态、兼容性开关），支持目录外模型的伴生路由迁移，models.dev 数据源表单预填
- models.dev 表单预填增加 gh-proxy 镜像回退：直连失败时自动尝试镜像，国内网络也可加载模型目录
- 对话 minimap 优化：刻度条加高、间距加大，悬停高亮跟随鼠标，仅「对话」页面显示，超长会话自动压缩间距

### English
- New conversation sidebar with two native views: the 文件 page browses the workspace tree and previews text and images; the Git page groups changes by directory, previews unified diffs with dual line numbers, stages/restores/commits, lists tracked files, and shows a centered graph modal — click a commit for its full message and file stat
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
