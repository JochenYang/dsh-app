# Capability Roadmap — 能力与功能增强路线图

> 2026-09-06 调研立项。来源：对 0.1.2-rc.1 内核（与 dsh-app 适配线同版本）未挂载能力域的
> 系统盘点 + 同类产品对标。证据等级与文件引用见各文档。
>
> 状态标记：📄 已立项（本文档）/ 🔍 待验证（有前置验证步骤）/ 👀 观望 / ✅ 已完成

## 背景与结论

内核 `packages/` 里有一批**已完整实现、但 `dsh web` 装配层未挂载或默认关闭**的能力域。
发布的 `dsh` CLI 包（`apps/cli/package.json` dependencies）已含
`dsh-mcp-client`、`dsh-schedule`、`dsh-hooks-claude-code`、`dsh-hooks-codex`、
`dsh-webhook(-github)`——即运行时 tarball 的扁平 `node_modules` 里就有这些包，
overlay 按名挂载即可，**无需改内核、无需新增 npm 依赖**。

已经默认挂载（勿重复建设）：plan mode、goal、todo、compaction、skills、jobs、
workflow/ralph、subagent(spawn/fork)、web 检索、审批、权限预设、轨迹、`/export`。

## 文档索引与优先级

| 优先级 | 文档 | 主题 | 状态 |
|---|---|---|---|
| P0 | [mcp-manager.md](mcp-manager.md) | MCP 服务器管理（UI 化配置 + 动态挂载） | ✅ 已落地（main 未 push） |
| P1 | [hooks-bridge.md](hooks-bridge.md) | Hooks 桥 + DSH 原生规则 | ✅ 已落地（main 未 push，用户已实测拦截生效） |
| P2 | [session-search.md](session-search.md) | 会话全文检索（sqlite 后端 + UI） | ✅ 已落地（main 未 push；agent 工具暂缓，见搁置区） |
| P3 | [schedule-reminders.md](schedule-reminders.md) | Schedule 会话内定时提醒 | ✅ 已落地（main 未 push，用户已实测投递生效；系统通知 V2 待 desktop bridge） |
| — | [code-quality-enhancements.md](code-quality-enhancements.md) | 验收钩子（MVP 已验证，单门价值不足，停止投入；等效替代=原生 Hook 用户自配） | 📄 |
| — | [desktop-shell-experience.md](desktop-shell-experience.md) | plugin-brand 落地 / 诊断中心 / 首启补全 | 📄 |
| — | [dev-process-tooling.md](dev-process-tooling.md) | PR CI / 套件冒烟探针 / 版本对齐脚本 | 🔧 CI 门 + 冒烟探针已落地；单测/对齐脚本/看板未做 |

## 搁置区（判死刑项，留档备查，不占队列）

| 原优先级 | 主题 | 死因 | 重启条件 |
|---|---|---|---|
| P4 | 外部 CLI 子代理（Claude Code / Codex） | provider 后端包（dsh-subagent-claude-code / -codex）不在 CLI 闭包；硬上需改构建组合 + 白屏风险 | 上游把包打进 apps/cli 闭包 |
| P5 | LSP 代码智能工具 | dsh-lsp / -stdio / tool-lsp 全不在 CLI 闭包，同上 | 同上 |
| P6 | Agent Teams | 上游 experimental，未稳定 | 上游转正 |
| P2 子项 | agent 侧 session_search 工具 | dsh-tool-session-query 不在 CLI 闭包；insert 曾致整树失败白屏（2026-09-07 事故） | 同上 |

## 依赖关系

```
desktop-shell-experience (plugin-brand: app-info + desktop bridge) ←── schedule-reminders 的系统通知
                                                                 ←── 诊断中心
mcp-manager（P0）── 建立"套件插件动态挂载内核可选包"的模式
                 ── hooks-bridge / lsp-tools 直接复用该模式
dev-process-tooling 的套件冒烟探针 ── 建议先于 P0-P3 落地（否则新插件无运行时验证手段）
```

## 公共落地模式（P0–P2 共用，做完 MCP 后是流水线作业）

1. **挂载**：`plugins/dsh-app.patch.yml` 增加 `insert` 行（overlay 由 shell 每次
   server 启动时复制，`brand-suite.ts`）。内核可选包已随 dsh 发布，直接按名引用。
2. **用户配置**：遵循套件既有约定——`$DSH_HOME/storages/dsh-app-plugin-<name>/config.json`，
   插件启动时读取，settings 页可写；overlay 是静态的、用户手改不保留，所以一切
   用户可编辑状态放 storages 配置文件（同 plugin-swarm / plugin-usage / plugin-memory）。
3. **UI**：client 半 `ctx.slots.inject('settings.section', ...)`（参照
   `plugins/plugin-client-ui/src/client.ts:188`），order 分配避开上游
   （11=模型高级设置已占用，15=Plugins，20=agent-presets）：
   **12=MCP 服务器，13=Hooks，14=诊断**。
4. **Host routes**：`/plugins/@dsh-app/plugin-<name>/api/*`，全部过 Host fence
   （loopback 校验，参照 `plugins/plugin-sidebar/src/trust-fence.ts`）。
5. **降级纪律**：内核缺对应服务时只挂状态路由、boot 不受影响（套件既有稳定性纪律）。

## 范围外（本期不做）

- MCP resources/prompts 桥接（上游明确 Only tools are bridged）。
- 上游已默认挂载能力的产品化包装（见上）。
- agent-team / acp / e2b / webhook（见表）。
