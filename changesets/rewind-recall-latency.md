---
shell: none
plugins: plugin-rewind
---

撤回：确认后立即返回，不再等待快照库的全库清理（清理改为后台合并执行）；插话消息首次渲染时不再报错。
Recall: the confirmation returns at once instead of waiting for a whole-store snapshot cleanup, which now runs in the background and coalesces; a steering row no longer errors on its first render.
