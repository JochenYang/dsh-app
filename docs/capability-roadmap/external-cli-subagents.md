# 外部 CLI 子代理（P4）

> 目标：把本机已装的 Claude Code / Codex CLI 作为一次性子代理后端——
> DeepSeek 主 agent 可把独立子任务委托给外部模型 CLI 执行，swarm 未来可把它们当 worker。

## 1. 背景与内核现状

- standard preset 里两行 **disabled**（`packages/preset/agent-presets/presets/standard/agent.cordis.yml`）：

  ```yaml
  - id: tool-subagent-codex
    name: '@deepseek-ai/dsh-tool-subagent'
    disabled: true
    config: { provider: codex, toolName: subagent_codex, backgroundMode: one-shot, maxDepth: provider-managed }

  - id: tool-subagent-claude-code
    name: '@deepseek-ai/dsh-tool-subagent'
    disabled: true
    config: { provider: claude-code, toolName: subagent_claude_code, backgroundMode: one-shot, maxDepth: provider-managed }
  ```

  文件内注释给了开启路径：**安装对应 Bundle 到 Profile 并重启 Host，复制 preset 并去掉
  disabled**。即需要 `packages/subagent/subagent-claude-code/`、`subagent-codex/`
  对应的 bundle 进入运行时（🔴 待验证 V1：这两个 bundle 的 npm 包名是否在
  `dsh` CLI 依赖里；不在则需要 runtime 构建侧补充安装——这是与其它提案的关键差异）。

- `backgroundMode: one-shot`：不可续聊、一次交付；与内部 `spawn`（continuable）不同。

## 2. 方案设计（两段式）

### 阶段一：可用（验证后多半是配置工作）

1. V1 验证（先行）：
   - `npm view` 确认 `@deepseek-ai/dsh-subagent-claude-code` / `-codex` 是否已发布、
     是否在 apps/cli 依赖闭包内（决定 runtime 里有没有）；
   - 若不在：评估 `build-runtime.mjs` 在 app/package.json 追加这两个依赖（仍是 npm 安装，
     不违反"不改内核"，属于**运行时组合**——需在 AGENTS.md §4 记录此例外及其升级维护点）。
2. 套件插件 `@dsh-app/plugin-external-subagents`（或并入 plugin-brand）：
   不用复制 preset——宿主侧直接挂 tool 行（agent-plane 工具在 preset 域，见 web bundle
   注释"Disabling rather than deleting is deliberate"——🔴 V1 需确认 host overlay 挂
   tool-subagent 是否对 preset 会话可见；若必须入 preset 域，则提供"预设管理"路径，
   见阶段二）。
3. 前置检查：工具描述与 UI 提示要求本机存在 `claude` / `codex` CLI；缺失时工具返回
   稳定错误（同 plugin-fff 的 `{ ok:false, reason }` 纪律）。

### 阶段二：好用

- 设置页"外部代理"section：检测本机 CLI（版本探测）、开关各 provider、
  （若上游要求）preset 定制入口；
- swarm 集成：orchestrator 的 provider 参数扩展为可混编
  （`spawn` + `claude-code` + `codex` 混合 worker 池）——独立需求文档，先不展开；
  依赖 swarm orchestrator 现有 provider 抽象的扩展点评估。

## 3. 价值与风险

- 价值：混合编排（DeepSeek 主控 + 外部模型执行独立子任务）；用户已有 CLI 订阅的复用。
- 风险：
  - R1 bundle 可能未随 dsh 发布（V1 一票否决项，验证半天）；
  - R2 one-shot 语义与 swarm 的 continuable 假设冲突（阶段二再解决）；
  - R3 外部 CLI 的鉴权/费用完全在用户侧，UI 必须明示"由外部 CLI 计费执行"。
- 优先级低于 MCP/Hooks 的原因：价值依赖用户装了竞品 CLI；验证成本前置。
