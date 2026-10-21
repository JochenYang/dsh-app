---
shell: none
plugins: plugin-rewind
---

撤回新增「只撤回对话」：消息撤回而文件保持不动，可从确认框选择或输入 `/rewind conversation <n>`；预演也按所选范围作答（`/rewind plan conversation <n>`），所以清单不会列出不会被改动的文件。工作区快照改为在每轮开始时采集，撤回能把文件还原成发消息那一刻的状态。
Recall gains a messages-only scope that leaves every file untouched (a choice in the confirmation dialog, or `/rewind conversation <n>`), and the preview answers for that same scope (`/rewind plan conversation <n>`), so the dialog never lists files it will not touch. The workspace snapshot is now taken when a turn opens, so a recall restores the tree as it was when the message was sent.
