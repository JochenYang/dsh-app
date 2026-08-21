# Changelog

DSH APP 的版本变更记录。每个版本只记录相对**上一发布版**的增量变更（不含历史全量），
与 GitHub Release 的 release notes 保持一致。发布流程见 `AGENTS.md` §10。

发布时把 `[Unreleased]` 改为具体版本号（如 `[v0.1.7]`），然后运行
`node scripts/gen-release-notes.mjs v0.1.7` 生成双语 notes。

双语条目对齐维护：`### 中文` / `### English` 子节条目一一对应、顺序一致，新条目加在列表顶部。

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
