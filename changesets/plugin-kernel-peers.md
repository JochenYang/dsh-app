---
shell: none
plugins: plugin-presets, plugin-memory, plugin-rewind
---

三个插件把运行时由内核提供的包声明为 peerDependency，并同步补进 devDependencies（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-home-paths`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`），新增的静态 import 门禁不再拒绝它们。
Three plugins now declare the kernel-provided packages they import as peerDependencies, with the matching devDependency so the type check keeps resolving (`@deepseek-ai/schemastery`, `@deepseek-ai/dsh-home-paths`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`).
