# 桌面壳体验（plugin-brand 落地 / 诊断中心 / 首启补全 / 工作区直达）

- Status: partial
- 核对日期：2026-11-23（本文件此前标 active 且内容停在立项时的状态；以下按代码与真机核对）

> 桌面壳相对"浏览器开 dsh web"的差异化都在这一层。plugin-brand 是多数项的前置地基。

## 1. plugin-brand 落地（✅ 按实际形态完成；原设计两项不再需要）

现状（`plugins/plugin-brand/src/index.ts`）：桌面桥的 host 半边已完整——动作路由与
Connection 路由都在。`open-in-folder` / `pick-directory` 由内核自己的 seam 执行；
`notify` / `save-text-as` / `open-logs` / `about-info` / 办公负载与配置检查由 shell 执行，
路由把坐标交给页面、由页面从 app origin 调用（`shell-actions.ts`）。诊断读取（日志尾、
导出事实）也在。真机上 `npm start -- --remote-debugging-port=<p> <目录>` 验证过
`[workspace] launch folder … → ok`。

原设计中**两项不再需要**（`docs/agents/known-gaps.md` 第 1 条）：

1. **app-info 服务**：三个事实（shell 版本、内核版本、渠道）已经经 shell 的 `about-info`
   动作到达客户端，「关于」页显示真实的双版本（`plugin-client-ui/src/client/about/`）。
   不需要 host 侧再提供一个服务；源码头部的 TODO 过时，未改（改 src 要带版本号与
   changeset，而它没有行为变化）。
2. **settings namespace `brand`**：内核的设置域是「按 profile 里的插件条目投影它的
   `Config` schema」（`dsh-settings` 的 `SettingsForms`），没有独立命名空间的注册 API；
   套件里也没有任何 shell 级偏好需要经它存。没有消费者，不做。

**桥的 remotes 现状**：`openInFolder`（原生动作）✅；`saveTextAs`（诊断导出）✅；
`notify` ✅——shell 实现（`src/main/index.ts` 的 Electron `Notification`）与路由都在，
2026-11-23 起有待办提醒作为第一个调用方（窗口隐藏时）；`focusSession`（通知点击跳转）
未做，是 `notify` 的后续项。

## 2. 诊断中心（✅）

设置页「诊断」section 已有：桌面功能状态卡、内核日志尾（200 行）、诊断导出（脱敏包，
经 `save-text-as`）、办公负载行。状态卡里的重启计数仍无来源（`plugin-brand/src/index.ts`
头部注明）。

## 3. 首启体验补全（✅ 已完成）

- 内核下载**暂停/恢复**（`startup-window.ts` 的暂停按钮 → `index.ts`
  `setPauseToggleHandler` → `kernel.pauseDownload()`/`resumeDownload()`，`Range`
  续传）；
- **校验和显示**：启动页展示已校验的摘要 + "运行时已校验"徽标
  （`setStartupDigest`，`static/startup.html`）；
- 失败路径文案分层：`updater.allSourcesFailed` / `updater.integrityFailed` /
  `kernel.artifactMissing` / `kernel.integrityFailed` 各自可行动。

## 4. 工作区直达（部分）

- `dsh-app.exe <path>` 启动即打开该工作区：✅（`src/main/workspace-launch.ts`
  `pickWorkspaceArg`，裸目录参数即工作区；2026-11-23 在 pi / cindy 两个目录上实跑过）；
- 托盘菜单"最近工作区"：未做（想法，未排期）；
- Windows 资源管理器右键"在 DSH APP 中打开"（NSIS 注册表项）：未做（想法，未排期）。

## 余项

`focusSession`（通知点击聚焦会话）、托盘最近工作区、资源管理器右键菜单、诊断卡的重启计数来源。
都不是缺陷，没有排期；要做时从本节取。
