---
shell: minor
plugins: plugin-rewind, plugin-client-ui
---

新增消息撤回（`/rewind`）：会话回退到某条已发送消息之前，该消息及其之后的内容退出模型上下文并从对话里隐藏，原文回到输入框可改后重发；该段之后**由写入工具（`write` / `edit` / `str_replace_editor`）改动过的文件**同时恢复原状，shell 命令的改动会逐个列出并标注无法恢复。入口是用户消息下方悬停可见的图标与 `/rewind` 命令（留空弹可撤回消息列表），点图标先弹逐文件确认框（含前后对比与无法恢复的数量），确认后才执行；被移走的内容留在 `$DSH_HOME/storages/dsh-app-plugin-rewind/quarantine/`，由维护设置新增的第三个页签「撤回隔离区」按项删除。

Add message recall (`/rewind`): cut the conversation back to before a message you already sent, so it and everything after it leave the model's context and disappear from the transcript, and its text returns to the composer to edit and re-send; the files that range then changed through a write tool (`write` / `edit` / `str_replace_editor`) are put back, while a shell command's writes are listed one by one as unrestorable. The entry points are a hover icon under each user message and the `/rewind` command (bare = a picker), the icon confirming per file first (with a before/after comparison and a count of what cannot be restored), and the recall runs only once that is confirmed; what a recall displaces stays in `$DSH_HOME/storages/dsh-app-plugin-rewind/quarantine/`, discarded per item from the third tab of Maintenance.
