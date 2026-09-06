# Hooks 桥（P1）

> 目标：用户已有的 Claude Code / Codex `hooks.json` 在 DSH APP 里直接生效——
> 会话启动、prompt 提交、工具调用前后、run 结束等时机执行用户 shell 钩子，
> 可拦截 prompt/工具调用、注入上下文。这是"强制规则"的零上下文成本通道。

## 1. 背景与价值

- 内核 hooks 组（`packages/hooks/`）提供 `hook-protocol` 引擎 + 两个方言桥：
  `dsh-hooks-claude-code`、`dsh-hooks-codex`。**两包都在发布的 `dsh` CLI 依赖里**
  （`apps/cli/package.json`），运行时可用。
- 对标：Claude Code 官方建议"必须每次发生的规则用 hooks（模型不可绕过），
  上下文知识用 skills"。hooks 消耗零模型上下文（arXiv 2026 分析）。
- 代码质量杠杆：PreToolUse 拦截（如"禁止改 `src/generated/**`"、"提交前必须过 lint"）
  是确定性守门，比 prompt 约定可靠一个量级。

## 2. 内核契约（L1，`packages/hooks/hooks-claude-code/README.md`）

单行挂载，指向现有配置文件：

```yaml
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ./.claude/hooks.json   # 必填；hooks.json 或含 hooks 键的 settings 文件
    pluginRoot: ./.claude/plugins/my-plugin   # 可选；替换 ${CLAUDE_PLUGIN_ROOT}
    projectDir: .                       # 默认 session workspace；替换 ${CLAUDE_PROJECT_DIR}
    defaultTimeoutMs: 600000
    stderrSummaryMaxChars: 500
```

- 覆盖 Claude Code 文档化的 command-hook 子集；`SessionStart` / prompt 提交 /
  PreToolUse / PostToolUse / Stop 等时机；可阻塞（返回 model 可见消息）、附加上下文、强制继续。
- codex 桥同形（`configPath` 指向 Codex 的 hooks 配置）。
- 权限注意：hooks = shell 执行，配置文件与 shell 访问同级信任（上游原话），UI 需明示。

## 3. 方案设计

### 3.1 挂载（薄）

新增双面插件 `@dsh-app/plugin-hooks`（模式同 mcp-manager）：

- 配置：`$DSH_HOME/storages/dsh-app-plugin-hooks/config.json`：
  ```json
  { "enabled": true, "bridges": [
      { "dialect": "claude-code", "enabled": true, "configPath": "D:/proj/.claude/hooks.json" }
  ] }
  ```
- host 启动时为每条 enabled bridge 走 §mcp-manager 同款动态挂载（或 overlay 合并备选）。
  `configPath` 支持绝对路径与 `~` 展开；**不校验文件内容**（方言由上游解析，失败降级为
  日志 + UI 状态"加载失败"）。

### 3.2 设置页 section（order 13，"Hooks"）

MVP：
- 开关：总开关 + 每 bridge 开关；
- bridge 列表：方言、configPath、启用状态、加载结果；
- 添加向导：选方言 → 填路径（默认建议 `~/.claude/hooks.json`）→ 保存；
- 安全提示文案（hooks = 本机命令执行，来自文件即执行）。

V2：
- 钩子执行日志流（上游有 `hook/result` stderr 摘要持久化——确认事件面后做最近执行列表：
  时间/钩子名/结果/阻塞原因）；
- 新建 hooks.json 模板（PreToolUse 拦截示例：保护路径 / lint 门）。

## 4. MVP / V2 / 验收

**MVP**：单 bridge（claude-code 方言）+ 总开关 + 路径配置 + 重启后生效 + 状态展示。
**V2**：codex 方言、多 bridge、执行日志、模板。
**验收**：
1. 挂载一个含 PreToolUse 阻断的 hooks.json（拦截对某路径的写），agent 尝试写入被拒
   且模型收到钩子消息；
2. configPath 不存在：harness 正常启动，UI 显示"加载失败"，无崩溃；
3. 总开关关闭后重启：无任何钩子执行；
4. 降级：内核无 hooks 包时 boot 不受影响。

风险：hooks 引擎对 web 多会话的 per-session 语义（SessionStart 触发面）需在 V1 探针
确认——与 mcp-manager 的 V1 验证合并做。
