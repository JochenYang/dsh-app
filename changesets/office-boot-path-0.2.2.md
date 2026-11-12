---
shell: patch
plugins:
---

办公载荷的启动路径只做它在 0.2.2-rc.2 还剩的那件事：回答内核子进程的 primary-runtime 路径。技能由内核包自带的 `assets/` 提供，于是外壳不再把四个技能目录复制到用户数据目录、也不再在启动时校验它们；同时删掉旧线为了「子进程每次启动都 statSync 解释器」而物化 Node 的那段逻辑（那份前提随 `desktop-office` 一起消失），并顺手清掉旧布局留在叶子上、含解释器却没有 `runtime.json` 的死目录。

The office payload's boot path now does the one thing 0.2.2-rc.2 still asks of it: answer the kernel child's primary-runtime path. The skills come from the kernel package's own `assets/`, so the shell no longer copies the four skill directories into the user data directory or validates them at start, the interpreter materialization goes with the `desktop-office` precondition it served, and a dead pre-0.2.2 tree left at the leaf (interpreter, no `runtime.json`) is cleaned up instead of being kept forever.
