---
shell: patch
plugins:
---

应用更新改为无点击安装：下载完成后给出 10 秒倒计时（可取消，也可立即安装），随后静默安装并自动重启，安装期间显示我们自己的进度窗口（跟随深/浅主题），不再显示安装向导，也不再重复询问「立即安装」；装完自动重启，提示新版本并附更新说明入口，回滚同样如此。选择稍后的安装包保留 7 天，下次启动或手动检查时直接进入安装倒计时并复用已校验的字节，不再重新下载。
App updates now install without a single click: a 10-second countdown after the download (cancel it, or start right away), then installs silently and restarts on its own, with our own progress window (following the app theme) instead of a setup wizard — no pages to click and no second "install now" prompt. The new version announces itself and announces itself with a link to its notes (a rollback names itself too). A deferred installer is kept for seven days: the next startup or manual check goes straight to the countdown and reuses the verified bytes instead of downloading again.
