---
shell: none
plugins: plugin-rewind
---

撤回插件：工作区快照的哈希阶段受 `maxWalkMs` 与取消信号约束，快照收集改为按间隔下限触发（长会话里不再每次快照都全库扫描）。
Rewind plugin: the workspace snapshot's hashing phase now honours `maxWalkMs` and cancellation, and snapshot collection is throttled to an interval floor instead of a whole-store scan after every snapshot.
