---
shell: patch
plugins:
---

修复更新安装：不再用已安装的同一个可执行文件显示进度（它锁住旧文件，安装器退出 0 却不替换）；倒计时卡片位于标题拖拽区导致按钮点不动的问题一并修好。
Fix the update install: the progress helper no longer runs from the installed executable (it held the old binaries open, so the installer exited 0 without replacing anything); the countdown card's buttons now work inside the title drag region.
