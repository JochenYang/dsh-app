---
shell: patch
plugins:
---

外壳：内核目录被清理工具按目录名删掉文件时不再「看起来完整」——启动前核对制品自带的文件清单，缺文件就按损坏安装处理（比此前多发现 10 个被删文件），且不再退回同样损坏的上一版内核（会直接走安装包内重新安装）。无法判定（清单缺失/损坏或路径过长）一律放行，避免把完好安装锁死。
Shell: a kernel directory whose files a disk cleaner removed by directory name no longer passes as complete — the start now checks the artifact's own file inventory and treats a missing file as a broken install (10 deleted files it previously missed), and it no longer rolls back into an equally damaged previous kernel (it goes straight to the bundled reinstall). Anything it cannot judge (no inventory, a corrupt one, an over-long path) is allowed through, so a healthy install is never locked out.
