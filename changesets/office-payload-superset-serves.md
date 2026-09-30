---
shell: patch
plugins: plugin-client-ui
---

办公组件：内核只要求套件本身时，磁盘上「同一套件 + Python 集」的产物直接算满足要求，不再提示更新；诊断页的「已安装」判定改按 shell 的结论，而不是版本字符串是否相等。
Office components: a payload carrying the kit plus its Python set now serves a kernel that requires the kit alone, so the row stops offering an update whose only possible outcome was the same payload again.
