---
shell: none
plugins: plugin-codegraph
---

`codegraph_context` 现在可以传文件路径，直接得到一个文件的符号清单——它声明了什么、每个符号被调用多少次，按调用次数排序，公共接口排在内部辅助函数前面。这补上的是文本搜索结构上答不了的问题：实测「列出这个文件定义了哪些符号」这类查询，关键词搜索只有 0–10% 准确率，「列出某个类有哪些方法」只有 6.5%，因为方法定义本身不会提到类名。会话开头的项目概览末尾也加了三句具体触发条件（谁调用了它、这个文件定义了什么、这个符号的周边是什么），按一项研究把清单移到提示末尾能显著提高工具使用率。
`codegraph_context` now accepts a file path and answers with that file's symbol outline — what it declares, how many times each symbol is called, ordered by call count so the public surface precedes the internal helpers. This closes a gap keyword search cannot close: measured, "list the symbols this file defines" scores 0–10% for text search and "list the methods of this class" scores 6.5%, because a method definition never names its class. The session's project overview also ends with three concrete triggers now (who calls this, what does this file define, what is this symbol's neighbourhood); a published study found that moving such a checklist to the end of the prompt substantially raises tool adoption.
