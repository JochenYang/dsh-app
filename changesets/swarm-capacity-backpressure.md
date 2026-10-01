---
shell: patch
plugins: plugin-swarm
---

并行子代理：内核的子代理槽位上限不再让条目直接失败。撞到上限的条目改为缩池重排队，重试预算只留给真正的传输失败；`subagent` 行的 `maxActiveSubagents` 抬到 16（默认 8），swarm 上限对齐到 12 留出余量。
Swarm: the kernel's live-child limit no longer fails items outright. A capacity rejection now shrinks the pool and re-queues the item, leaving the retry budget to genuine transport failures; the `subagent` row's `maxActiveSubagents` rises to 16 (from the default 8) with swarm's ceiling aligned to 12.
