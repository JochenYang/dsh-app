---
shell: none
plugins: plugin-codegraph
---

每个会话开始时就带上当前项目的代码图谱概览——文件与符号数量、语言分布、没有任何文件 import 的入口文件、被引用最多的符号——不再等模型自己想起来去调用。实测过一个反例：模型在思考里写了「应该用 codegraph_find / codegraph_context」，列执行计划时却退回列目录和读文件，连续 8 次都没调用图谱。工具描述是「指令」，会输给「探索就是读文件」的习惯；概览是「答案」，在计划形成之前就已经在上下文里。概览限定 14 行左右，图谱还在建立的空图不输出任何内容。
Every session now starts with the current project's code-graph overview — file and symbol counts, the language split, the files nothing imports, and the most-referenced symbols — instead of waiting for the model to decide to ask. A measured counterexample: the model wrote in its reasoning that it should use `codegraph_find` / `codegraph_context`, then planned directory listings and file reads anyway, eight calls without touching the graph. A tool description is an instruction and loses to the habit that exploring means reading files; the overview is the answer and is already in context before the plan exists. The block is held to about 14 lines, and an empty or still-indexing graph contributes nothing.
