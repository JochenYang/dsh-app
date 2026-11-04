---
shell: none
plugins: plugin-sidebar
---

Git 面板：状态列表的顺序改成与 VS Code 一致——「暂存的更改」在上、「更改」在下。原因很直接：暂存区才是提交按钮作用的那一半，读者先看它；原来把工作区放在上面，暂存之后那一块读起来像是「已经提交过了」。两个分区各自带数量标题，且只在有内容时出现（空分区不再显示「（0）」这种空标题）。「还原全部」跟着「更改」走。

Git panel: the status list now reads top-down the way VS Code orders it — 暂存的更改 (staged) above 更改 (changes). The staged half is what the commit button acts on, so it is what the reader is deciding about; the old order put the working tree first, which read as "already committed" once something was staged. Each section carries its own count and appears only when it has rows (no more "（0）" heading over an empty section), and the 还原全部 control stays with 更改.
