---
shell: none
plugins: plugin-codegraph
---

`codegraph_context` 的 `symbol` 改为可选，不传时回答项目概览：文件/符号/边数量、语言分布、没有任何文件 import 的入口候选、被引用最多的符号。此前三个工具都强制要一个具体符号名，「这个项目的入口在哪」这类问题没有名字可传，模型只能退回列目录和读文件——实测一次真实的定位提问因此产生了 `working_directory`、查找文件和四次读取调用，尽管图谱已经建好。概览在 1771 文件的真实项目上耗时 88 毫秒。入口候选按「测试/示例文件降权、cli/main/index 这类约定文件名升权」排序，枢纽只取顶层声明，避免把 `.filter`、`.trim` 这类同名变量当成项目核心。
`codegraph_context` now takes `symbol` as optional and answers a project overview when it is omitted: file/symbol/edge counts, the language split, the files nothing imports, and the most-referenced symbols. All three tools previously demanded a concrete symbol name, so a question like "where does this project start" had no name to pass and the model fell back to listing directories and reading files — measured in a real session, one orientation question produced `working_directory`, a file search and four reads even though the graph was already built. The overview takes 88ms on a real 1771-file project. Entry candidates rank test/example files down and conventional `cli`/`main`/`index` filenames up, and hubs consider top-level declarations only, so same-named variables such as `.filter` and `.trim` are not reported as the project's core.
