---
shell: patch
---

智能体团队浮窗不再透明：皮肤伪元素过去被设置对话框的拖拽条规则（`[class*="_panel"]::before`，把整块面板改成 20px 拖拽区）劫持，规则收窄到 `data-shortcut-modal="settings"` 后恢复；玻璃填充同时改为近不透明，补上本机不渲染 backdrop-filter 的缺口。
The Team panel is no longer see-through: its skin pseudo-element was hijacked by the settings dialog's drag-strip rule, now scoped to `data-shortcut-modal="settings"`; the glass fill is near-opaque as well, covering the machine's unrendered backdrop-filter.
