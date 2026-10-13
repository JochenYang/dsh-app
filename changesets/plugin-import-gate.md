---
shell: patch
plugins:
---

新增插件静态 import 门禁：插件 `src/**` 里 import 的包必须出现在自己的依赖字段中，`@deepseek-ai/*` 的运行时 import 必须是 peerDependency。
Added a static import gate: every package a plugin's `src/**` imports must be declared in its own dependency fields, and a runtime `@deepseek-ai/*` import must be a peerDependency.
