---
shell: none
plugins: plugin-memory
---

记忆插件：移动卡到别的项目前先校验目标目录可解析回工作区，同一张卡的并发移动串行执行，失败时把目标端连 pin 一起还原。
Memory plugin: a card move now validates that the destination resolves back to a workspace, serialises concurrent moves of one card, and restores the target's text and pin when the move fails.
