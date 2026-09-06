# 代码质量增强（验收钩子 / 审查桥 / 检查点映射）

> 三条互相独立、可分别立项的质量线。共同理念（对标 2026 产品线：Cursor Bugbot、
> Codex review、Claude Code hooks）：**质量靠确定性机制回收，不靠模型自觉。**

## 1. 验收钩子（质量反馈环）

**问题**：agent 声称完成 ≠ 项目可编译/测试通过。绿测≠需求满足（用户 AGENTS.md 纪律），
但目前这个检查完全依赖用户手动。

**方案**：会话静默（turn/end 后去抖，复用 plugin-memory distiller 的静默窗口模式）
后，套件插件对**该会话工作区**运行验收命令，失败结果回灌为 follow-up 消息：
- 默认验收序列（可按项目配置于 `dsh-app-plugin-verify/config.json`）：
  1. `typecheck`（默认探测 `npm run typecheck`，可覆盖命令）；
  2. 可选：`test` 命令（默认关闭，防大测试套件误触发）。
- 命令执行经 host 侧 `execFile` 参数数组 + 工作区路径围栏（同 plugin-sidebar git-routes
  的安全基线）；超时上限；输出截断（模型可读尾部）。
- 回灌纪律：只报失败 + 失败摘要，成功则**静默**（避免每轮噪声）；连续 N 次失败后
  停止回灌改提示用户（防死循环烧 token）。
- 与 Hooks 的关系：Hooks 是用户自带的守门（P1）；本项是产品内建的默认验收网，
  零配置开箱即得。可长期共存。

**MVP**：typecheck-only、单工作区、失败回灌 + 防循环。**V2**：项目级自定义序列、
测试命令、报告卡（设置页展示最近验收结果）。
**验收**：故意改坏类型 → 会话自动收到 typecheck 失败摘要；修好后不再打扰；
无 package.json 的工作区静默跳过。

## 2. 审查桥（改动 → 审查会话）

**问题**：上游"审查"tab + github-review overlay 面向 GitHub PR（需 TLS 隧道），
本地改动没有一键审查路径。

**方案**：plugin-sidebar 的 Git 面板（已有 grouped changes / unified diff 数据面，
`git-routes.ts`）加按钮"发起审查会话"：
- 以当前工作区未提交改动（staged+unstaged diff）为输入，创建一个只读审查 preset 会话
  （plan-mode 式禁写约束由 prompt 段保证，或复用上游只读审查 prompt 的形态），
  prompt 内嵌 diff 与"找出缺陷/风险，按严重度列 findings"指令；
- 产出 = 审查会话的消息流（复用现有会话 UI，零新 UI 面）。

**MVP**：按钮 + diff 组装 + 固定审查 prompt。**V2**：findings 结构化（severity 标签）、
"一键按 finding 修复"回到原会话、审查历史归档（入 plugin-archives 域）。
**验收**：有未提交改动时按钮可用且审查会话能指出注入的已知缺陷；无改动时按钮禁用
并提示；超大 diff（>64KB）分块或提示用户缩小范围。

## 3. 检查点映射（会话轨迹 ↔ Git 快照）

**问题**：对标 Claude Code checkpointing/rewind（代码/会话分别还原）。dsh 有会话
持久化与血缘，我们有 Git 面板，但两者没有对齐视图。

**方案（轻量起步）**：Git 面板 graph 中标注"此提交由会话 X 创建"
（利用 plugin-usage 已有的 session↔事件数据，或 commit message trailer 约定），
点击从提交跳转会话（反向：会话轨迹里该轮提交打标记）。
真正的 rewind（自动快照/还原）不做——与上游 session/guard 域重叠且风险高，
待上游 checkpoint 类能力落地再承接。

**MVP**：单向标注 + 跳转。**验收**：会话内产生的提交在 graph 上可见来源会话并可跳转。

## 优先级

验收钩子 > 审查桥 > 检查点映射。验收钩子独立于 P0-P3 可先行（无内核依赖），
且直接服务"代码质量"这个用户目标。
