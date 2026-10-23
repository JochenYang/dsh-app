---
shell: none
plugins: plugin-codegraph
---

代码图谱索引不再冻结界面：分阶段让出事件循环、分批提交事务，文档引用改为一条提及只连一个声明，且只在文档或符号变化时重扫。实测一个 1771 文件的项目从卡死 241 秒降到首次 17.9 秒、二次 93 毫秒。
The code graph no longer freezes the UI while indexing: each phase yields to the event loop, transactions commit in batches, a document mention links to one declaration instead of every name-alike, and document edges are re-derived only when a document or a symbol changed. Measured on a 1771-file project: 241 seconds of a frozen window became 17.9s on the first pass and 93ms on the second.
