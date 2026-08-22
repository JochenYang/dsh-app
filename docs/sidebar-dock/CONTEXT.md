# CONTEXT — 侧边栏底座共享语言

> 需求访谈活文档（requirements-interview 流程，两轮收敛 2026-08-22）。
> 状态标记：✅ 已确认 / 🟡 工作假设（待确认） / ❓ 未决

## 术语表（Glossary）

| 术语 | 定义（用户视角） | 状态 |
|---|---|---|
| **侧边栏底座**（Sidebar Dock） | 会话页右侧可展开/收缩的面板容器，承载多个侧边栏页面 | ✅ |
| **侧边栏页面**（Sidebar Page / Tab） | 底座内的一个标签页式内容区 | ✅ |
| **图标列**（Dock Toggle Rail） | 窗口右上角、原生窗口控制按钮正下方的竖直图标列，点击展开/收缩对应页面（VSCode 活动栏风格）——即需求的"状态栏展开/收缩按钮"落位 | ✅（第 1 轮用户提议"标题栏关闭按钮下方"） |
| **内置页面**（Built-in Pages） | 文件树/预览、编辑、终端、Git、子代理任务。**侧边对话已裁定砍掉**（第 2 轮，"没必要"）；内嵌浏览器远期 | ✅ |
| **三方注册**（Third-party Registration） | 其它 dsh 插件经 `ctx.dshAppSidebar` 服务（registerTab / registerFileViewer）注册侧边栏页面与文件预览器 | ✅（形态学参考同类开源方案） |
| **文件树 / 预览 / 编辑** | 浏览工作区目录 → 只读查看（高亮/图片/MD）→ 可写保存，三层递进 | ✅ |
| **信任边界**（Trust Fence） | host 路由的浏览器信任围栏（Host 头 loopback 校验）+ 写文件的工作区路径约束 | 🟡（命名沿用参考项目，实现期确认） |
| **双面插件**（Dual-face Plugin） | 同时有 host 半（Node：fs/pty/git）与 client 半（React UI）的单包 dsh 插件，模式同同类开源方案（已验证） | ✅ |

## 命名映射（Naming）

| 产品术语 | 代码命名 | 状态 |
|---|---|---|
| 侧边栏底座插件 | `@dsh-app/plugin-sidebar`（`plugins/plugin-sidebar/`） | 🟡 |
| 三方注册服务 | `ctx.dshAppSidebar`（`registerTab` / `registerFileViewer`） | 🟡 |
| host 能力路由前缀 | `/plugins/@dsh-app/plugin-sidebar/*`（fenced） | 🟡 |
| 面板 UI class 前缀 | `dshAsb-` | 🟡 |
| 需求文档目录 | `docs/sidebar-dock/` | ✅ |

## 值得保留的决策（ADR）

### ADR-1：三方注册 = 自有 ctx 服务（非官方 slot、非独立协议）
- 用户顾虑：避免污染 dsh 官方。
- 决策：注册协议是**我们自己插件暴露的服务**（`ctx.dshAppSidebar`），官方 slot 表零改动；复用 cordis 服务的依赖/生命周期机制，不自研注册协议。形态参考同类方案的 ctx 服务注册模式（其生态规模已验证）。
- ✅ 第 2 轮随"自研"决策一并确立。

### ADR-2：自研，不集成同类开源方案
- 用户裁定：该插件"有很多 bug"，不直接封装/捆绑；仅作架构参考（MIT）。
- 推论：host 侧能力自建路径（fs/pty/git + fenced 路由）被该项目的存在所验证——可行；终端从"后置"提前到 M2 排雷。
- ❓ 遗留：请用户提供具体 bug 清单 → 转化为验收回归项（SPEC 开放问题 #1）。

### ADR-3：host+client 双面插件，能力不经内核 wire API
- 内核 wire API 无终端/Git/文件写入；host 半直接用 Node 能力（node-pty / spawn git / fs）经自注册 fenced 路由暴露。
- 不 fork 内核、不旁路内核安全模型（自带 trust-fence，等价复刻 dsh 网关围栏）。

## 访谈进度（已收敛）

- **第 1 轮（2026-08-22）**：MVP=底座+文件树/预览先行；开关=标题栏关闭按钮下方；三方扩展澄清（用户顾虑"污染官方"）。
- **第 2 轮（2026-08-22）**：用户出示同类开源参考项目 → 三问三答：**自研**（参考项目 bug 多，不集成）；**侧边对话砍掉**；版本策略作废。终态：自研双面插件 + 5 内置页 + ctx 服务注册 + 图标列开关。
- 产出：SPEC.md / PRD.md / PLAN.md（同目录）。待办：用户补 bug 清单；M1 前侦察 conversation 挂载点。
