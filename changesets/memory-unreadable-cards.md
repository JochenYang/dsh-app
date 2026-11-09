---
shell: none
plugins: plugin-memory
---

记忆插件：卡片读取区分「不存在」与「读不到」，读不到的卡不再被当成新建而覆盖，也不再被报告为删除成功；迁移时保留其 pin。
Memory plugin: a card read now separates "absent" from "unreadable", so a card that cannot be read is never overwritten as new nor reported as deleted, and its pin survives migration.
