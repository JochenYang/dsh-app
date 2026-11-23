---
shell: none
plugins: plugin-codegraph
---
代码图谱插件：`codegraph_impact` 的每一行引用现在带上调用点那一行（行首是调用方名字），目标声明不超过 40 行时随答案带上源码，被引用的文件若在索引后改过会标出；答案过期时在第一行点名哪些被引用的文件变了；回放脚本新增会话末尾常驻上下文的度量。
Code graph plugin: every reference row of `codegraph_impact` now carries the line of the call, led by the caller's name; the target's declaration rides along while it is 40 lines or fewer, and a cited file changed since the index is marked; a stale answer names the cited files that moved, on its first line; the replay script measures the context resident at a session's end.
