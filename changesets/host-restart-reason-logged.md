---
shell: patch
---

内核子进程重启的原因现在写进 `dsh-kernel.log`，不再只发给一个打包版不存在的控制台。
The kernel child's restart reason now reaches `dsh-kernel.log` instead of a console a packaged build does not have.
