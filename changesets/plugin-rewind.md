---
shell: minor
plugins: plugin-rewind
---

新增消息撤回（/rewind）：把会话回退到某条已发送消息之前，该消息及其之后的内容退出模型上下文、在对话界面隐藏，原文回到输入框可改后重发；同时把该消息之后**由写入工具改动过的文件**恢复原状。撤回入口是用户消息下方悬停可见的图标，以及 `/rewind` 命令（留空弹出可撤回消息列表，`/rewind <n>` 直接撤回第 n 条）。**点图标会先弹出确认框**，逐文件列出将要恢复/移走的文件、标注动作、可展开查看前后内容对比，并明确告知有多少文件无法恢复；确认后才执行。撤回只在回合边界进行，回合运行中会拒绝。

文件恢复的范围有明确边界：只覆盖 `write`/`edit`/`str_replace_editor` 三个工具（实测占全部工具调用的 22.9%）；`pwsh`/`run_code` 等 shell 命令创建、改写或删除的文件**不在覆盖内**（占 31.4%），这类改动会在确认框和撤回结果里逐个列出并标注"无法恢复"，不会假装已还原。恢复遵循"不删除"原则：被改文件的当前内容先移入隔离区再写回先前内容，撤回期间新建的文件同样是移入隔离区而不是删除，因此撤回本身可撤销。隔离区位于 `$DSH_HOME/storages/dsh-app-plugin-rewind/quarantine/`。

新增「撤回隔离区」设置页（位于维护设置的第四个页签）：列出每次撤回移走的文件，标明来源路径与原因（被替换 / 新建），可按项或按会话删除以回收磁盘。删除是不可逆的，因此逐项确认而非一键清空。

Add message recall (/rewind): cut the conversation back to before a message you already sent, so it and everything after it leave the model's context, disappear from the transcript, and its original text returns to the composer for editing and re-sending — and put back the files that turn range changed through a write tool. The entry points are a hover icon under each user message and the `/rewind` command (bare = a picker, `/rewind <n>` = recall that one directly). **The icon opens a confirmation first**: every file to be restored or moved away is listed with its action, an expandable before/after comparison, and an explicit count of what cannot be restored — and the recall runs only once that is confirmed. A recall always cuts at a turn boundary and is refused while a turn is running.

The file restore has a stated boundary: it covers only `write`, `edit` and `str_replace_editor` (22.9% of measured tool calls). Files a shell command (`pwsh`, `run_code`) created, rewrote or deleted are NOT covered (31.4%) — those are named individually in both the confirmation and the result rather than reported as reverted. Nothing is ever deleted: a changed file's current bytes are moved into a quarantine before the before-image is written back, and a file the recalled range created is moved there too, so the recall itself stays reversible. The quarantine lives at `$DSH_HOME/storages/dsh-app-plugin-rewind/quarantine/`.

Adds a Recall Quarantine settings tab (the fourth tab of the maintenance section): it lists every file a recall displaced, names the path it came from and why it was kept (replaced / created), and deletes individual items or a whole session to reclaim disk. Discarding is irreversible, so it is confirmed per item rather than offered as a single global button.
