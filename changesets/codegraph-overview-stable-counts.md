---
shell: none
plugins: plugin-codegraph
---

代码图概览里的计数改成量级（`~360 files`、`~5.8k symbols`），一次普通编辑不再改动这段文本，因此不再触发内核重发整份运行时上下文快照。
The code-graph overview now states its counts as magnitudes (`~360 files`, `~5.8k symbols`), so an ordinary edit no longer changes the text and no longer makes the kernel re-append the whole runtime-context snapshot.
