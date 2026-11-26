---
shell: none
plugins: plugin-rewind
---

撤回插件：回合内一旦有工具跑过就不再重拍快照，还原目标始终是回合开始时的树；大仓库上不再每个工具调用都遍历一次。
Rewind plugin: a turn's workspace snapshot is never re-taken once a tool of that turn has run, so a recall restores the tree as it stood at the turn's start and a large repository no longer pays a walk at every tool call.
