# PLAN — 侧边栏底座（sidebar-dock）

> 状态：访谈第 2 轮后定稿草案（2026-08-22）。范围见 SPEC，价值与优先级见 PRD。

## 0. 架构基线（各阶段共用）

- 新插件 `@dsh-app/plugin-sidebar`：**host+client 双面单包**（`dsh.plugin.json`：host main + client main），接线走 brand-suite symlink（与 plugin-brand/plugin-client-ui 同模式），随 suite 打包进 runtime。
- host 侧：自注册 fenced HTTP 路由（前缀 `/plugins/@dsh-app/plugin-sidebar/...`，复刻 dsh 网关 trust-fence：Host 头 loopback 校验）暴露 fs / pty / git 能力。
- client 侧：cordis slot/服务挂载 + React UI；注册服务 `ctx.dshAppSidebar`（registerTab / registerFileViewer）。
- 验证管线沿用 [[plugin-client-ui-verify-pipeline]]：`tsc --noEmit && esbuild → 覆盖部署到已装内核 → electron probe`。

## 阶段计划

### M1 — 底座 + 文件树/预览 + 注册服务最小面（P0/P1）
| 项 | 内容 |
|---|---|
| host | fs 路由：目录树（懒加载分片）、文件读取（大小上限 + 二进制嗅探）；trust-fence |
| client | 底座容器（右侧面板 + 图标列 + 拖宽 + 会话隔离持久化）；文件树页；预览器：文本（高亮）/图片/Markdown；`registerTab`/`registerFileViewer` 最小服务面 |
| 侦察前置 | conversation 包布局与 slot 面（主面板挂载点选型：优先官方 slot，次选稳定 DOM 锚点） |
| 验收 | SPEC §4 底座/文件树/预览/三方注册四组断言 + probe |
| 量级估计 | 3–5 个工作日 |

### M2 — 终端（P1，host 重能力排雷）
- host：node-pty 会话管理（每会话独立、断线回放缓冲）；**runtime CI 加 node-pty 原生构建**（build-runtime.mjs 依赖矩阵，六平台）；
- client：xterm.js 懒加载 chunk；终端页（连接/断开/重连）。
- 验收：SPEC 终端三断言；CI 六平台构建产物齐全。
- 量级：3–4 个工作日（含 CI 调试）。

### M3 — 文件编辑与保存（P2）
- 编辑器选型（CodeMirror 6 倾向：体积小、按需语法包）；保存走 host fs 写路由（写信任边界：仅会话工作区内可写）；
- dirty 状态、Ctrl+S、保存冲突（mtime 校验）提示。
- 量级：2–3 个工作日。

### M4 — Git 面板（P2）
- host：每请求 spawn `git`（status/diff/log/stage/commit/revert，无库无状态——参考模式）；git 缺失时降级提示。
- client：状态列表 + diff 视图 + 操作。
- 量级：2–3 个工作日。

### M5 — 子代理/后台任务页（P2）
- 纯 client（现有 `subagents` wire API + 事件流），无 host 改动。
- 量级：1–2 个工作日。

## 依赖与顺序

M1 →（M2 ∥ M3 可并行，但建议先 M2 排雷）→ M4 → M5。M1 的底座 API 设计需预留 M2–M5 全部页面形态（tab 图标/标题/懒加载面板协议），避免返工——设计时以 SPEC §2 七项能力为压力测试面。

## 风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| node-pty 六平台 CI 构建（历史坑多：electron ABI / prebuilt 缺失） | 高 | M2 独立排雷；先只做 win/mac/linux x64，arm64 视上游 prebuilt 情况追加 |
| 会话页挂载点脆弱（内核升级 DOM 变化） | 中 | 优先官方 slot；DOM 锚点集中一个模块 + probe 断言 |
| dsh 内核升级破坏 fenced 路由注册方式 | 中 | 参考同类方案的版本支持矩阵做法；suite 版本锁 + 升级 probe |
| 重 chunk 拖累首屏 | 中 | 懒加载 + 启动增量纳入验收指标 |
| 写文件的安全边界（路径逃逸） | 高 | 写路由仅允许会话工作区内路径（resolve 后前缀校验）；probe 含逃逸用例 |

## 测试策略

- 每阶段：`tsc --noEmit` + esbuild + electron probe（渲染/交互/写链路真实落盘后还原）；
- host 路由：trust-fence 正反用例（loopback 过 / 非 loopback 拒）；路径逃逸用例；
- 卸载语义：插件禁用后无残留 DOM/路由（probe 断言）；
- 参考项目痛点回归：待用户提供 bug 清单后转化为断言（SPEC 开放问题 #1）。
