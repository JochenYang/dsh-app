# 桌面壳体验（plugin-brand 落地 / 诊断中心 / 首启补全 / 工作区直达）

> 桌面壳相对"浏览器开 dsh web"的差异化都在这一层。plugin-brand 是多数项的前置地基。

## 1. plugin-brand 落地（前置项，最先做）

现状：`plugins/plugin-brand/src/index.ts:27-40` 三个 TODO（settings namespace、
app-info 服务、desktop bridge remotes），套件里唯一的空壳。

**方案**（按原设计收口，见 AGENTS.md §6）：
1. **app-info 服务**：shell 经 server spawn 时注入版本信息（或 host route 读取
   manifest + shell 版本文件）→ client 可显示"DSH APP x.y.z / 内核 dsh a.b.c"，
   更新卡片文案获得真实版本号。
2. **settings namespace `brand`**：shell 级偏好（更新渠道偏好、遥测开关占位、
   onboarding 标记）走 dsh-settings 体系而非自造 IPC。
3. **desktop bridge remotes**：`openInFolder(path)`（资源管理器定位）、
   `saveTextAs(name, content)`（native 另存为——轨迹导出等后续功能的地基）、
   `notify(title, body)`（系统通知——schedule-reminders V2 的依赖）、
   `focusSession(sessionId)`（通知点击跳转的雏形）。
   全部过 trusted-host fence；client 侧经正常 dsh API seam 调用（消灭专用 IPC）。

**验收**：设置页"关于"显示真实双版本；"打开日志目录"按钮经 bridge 打开资源管理器。

## 2. 诊断中心（用户支持刚需）

现状：排障 = 让用户翻 `<userData>/logs`（server.ts tee 的日志）+ 手动描述现象。

**方案**：设置页"诊断"section（order 14）：
- 状态卡：shell 版本、内核 active/previous 版本、渠道、上次内核检查时间、
  server 运行时长与重启次数（index.ts 已有这些内部状态，补一个 IPC/服务读出）；
- 日志：最近 200 行实时 tail（host route 读日志文件尾）+ "打开日志目录"（bridge）；
- 导出诊断包：脱敏 zip（日志 + current.json + 系统信息；redact 规则复用
  server.ts 的 credential 片段过滤），一键另存（bridge）；
- 快捷操作：重启 server / 检查内核更新（托盘已有能力的 UI 化）。

**MVP**：状态卡 + 日志 tail + 打开日志目录。**V2**：诊断包导出。
**验收**：模拟一次 crash restart 后，诊断页能看到重启计数与最近错误行；
导出的 zip 经 redaction 复查无 `api[key|_key]/authorization/token` 命中。

## 3. 首启体验补全（✅ 已完成）

- 内核下载**暂停/恢复**（`startup-window.ts` 的暂停按钮 → `index.ts`
  `setPauseToggleHandler` → `kernel.pauseDownload()`/`resumeDownload()`，`Range`
  续传）；
- **校验和显示**：启动页展示已校验的摘要 + "运行时已校验"徽标
  （`setStartupDigest`，`static/startup.html`）；
- 失败路径文案分层：`updater.allSourcesFailed` / `updater.integrityFailed` /
  `kernel.artifactMissing` / `kernel.integrityFailed` 各自可行动。

## 4. 工作区直达（待验证的体验项）

- `dsh-app.exe <path>` 启动即打开该工作区（🔴 V1：读 `src/main/index.ts`/`window.ts`
  确认现有 argv 处理与 dsh web 的 workspace 打开 URL 形态）；
- 托盘菜单"最近工作区"（shell 记录最近打开的 workspace 路径，点击 → 聚焦/新开会话）；
- Windows 资源管理器右键"在 DSH APP 中打开"（安装器注册表项，NSIS 配置）。

**验收**：带路径启动直接落到该工作区会话；托盘最近列表打开正确路径。
