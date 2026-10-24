---
shell: none
plugins: plugin-codegraph
---

会话开头项目概览里「被引用最多的符号」现在报的是调用点总数，与 `codegraph_impact` 返回的条数完全一致。此前概览按不同调用者去重计数（实测一个符号显示 203），而工具返回的是全部调用点（664），同一个符号两个数字差三倍，模型无法判断该信哪个。现在概览与工具、也与「超过 40 条会提示截断」用的是同一个计数。
The most-referenced symbols in the session's project overview now report the total number of call sites, matching exactly what `codegraph_impact` returns. The overview used to count distinct callers (measured: 203 for one symbol) while the tool returned every call site (664) — one symbol, two numbers three times apart, and no way for the model to tell which to trust. The overview, the tool, and the "truncated above 40" warning now all count the same thing.
