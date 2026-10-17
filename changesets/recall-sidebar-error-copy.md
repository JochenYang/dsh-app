---
shell: none
plugins: plugin-rewind, plugin-sidebar
---

撤回与侧栏 Git 的两处报错文案改准：撤回请求没能送达内核时（会话引用已释放、连接中断）不再显示「缺少必要的内核能力」，而是说明请求没送达并带上内核原话；侧栏 Git 在非仓库目录里不再把 git 的 stderr 包进「Git 操作失败」，而是直接说明该目录不是 Git 仓库，并且不再顺带发起同一次注定失败的历史读取。
Two error messages now say what happened. A recall request that never reached the kernel (a released session reference, a dropped connection) reports that it never arrived and carries the kernel's own message, instead of claiming a kernel capability is missing. The sidebar's Git tab reports a folder that is not a repository as that state — not as "Git failed" with git's stderr wrapped inside — and no longer issues the doomed history read that followed.
