---
shell: none
plugins: plugin-codegraph
---

代码图谱第七阶段：会话页顶部新增「代码图谱」视图，用一张图展示当前项目各文件与它们之间的引用，点进单个文件可看它声明的符号与文件内调用；图谱不再等工具被调用，回到一个项目时就自动开始建立（新会话与旧会话续用都算）。
Seventh stage of the code graph: a 代码图谱 tab on the conversation page draws the current project's files and the references between them, and opening one file lists the symbols it declares with the calls inside it; the graph no longer waits for a tool call — entering a project starts it, for a new session and a resumed one alike.
