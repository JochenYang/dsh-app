---
shell: patch
---

安装与更新不再弹「DSH APP 无法关闭」：旧版卸载器在 `--updated` 下必定失败退出（实测四组隔离场景，与文件数量无关），安装器重试五次后弹框。现在安装器在调用旧卸载器前先移除其注册表项与旧目录，旧卸载器不会被运行；新卸载器的删除逻辑也改为直接删除，从根源上不再触发该失败。
Installs and updates no longer raise "DSH APP cannot be closed": the previous version's uninstaller always fails under `--updated` (four isolated scenarios, independent of file count), and the installer retried five times before showing that dialog. The installer now removes the old registry entries and directory before that uninstaller would be invoked, so it never runs; the new uninstaller's delete logic also removes in place, so the failure cannot recur.
