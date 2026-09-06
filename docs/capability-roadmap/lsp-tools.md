# LSP 代码智能工具（P5）

> 目标：给 agent 精确的"定义跳转 / 引用查找"工具，替代在大型 TS/Python 项目里
> 靠文本 grep 猜符号。

## 1. 现状

- 内核 `packages/lsp/`：`lsp/`（客户端框架）、`lsp-stdio/`（stdio 传输）、
  `tool-lsp/`（模型工具）。未挂载于任何 bundle（🔴 V1 待验证：npm 包名与发布状态，
  若在 apps/cli 依赖闭包内则与 schedule 同级简单）。
- plugin-fff 的 `ffgrep` 是文本匹配，`classifyDefinitions` 只是启发式标记
  （`plugins/plugin-fff/src/tools.ts:228`）；重名符号、跨文件引用场景误报率高。

## 2. 方案（概要，待 V1 后细化）

- 挂载 `tool-lsp` + 语言服务器配置（用户机器需有 tsserver/pyright 等——
  UI 或工具描述给出探测/提示路径）；
- 与 fff 的分工写进工具描述：找文件/文本用 fffind/ffgrep，符号级跳转用 lsp 工具；
- 设置页 V2：语言服务器状态检测（哪些语言有 LSP 可用）。

## 3. 验收（草案）

1. TS 项目内查某函数引用：工具返回精确引用清单（与 IDE 一致），非文本匹配近似；
2. 无语言服务器：稳定错误 + 指引文案，不崩会话；
3. 降级纪律同前（内核缺包不影响 boot）。

## 4. 优先级理由

低于 Hooks/会话检索：收益集中在大型强类型项目；上游该组的成熟度与配置成本
（用户要装语言服务器）未验证。放 P5，V1 探针顺手确认包发布状态后再定投入。
