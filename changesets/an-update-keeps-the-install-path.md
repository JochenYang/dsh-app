---
shell: patch
plugins:
---

应用内更新不再把新版本装到默认位置：此前安装器会先删掉记录安装路径的注册表项，再按该键去读路径，读到空值便回落到 `C:\Program Files`——你装在别的盘上时，更新就静默换了地方。现在只清掉用于调用旧卸载器的那个键，记录路径的键保留，旧目录仍按它给的路径删除。
An in-app update no longer installs into the default location: the installer used to delete the registry entry that records the install path before reading it, so it read an empty value and fell back to `C:\Program Files` — an install on another drive silently moved. Only the entry that summons the previous uninstaller is cleared now, the path entry is kept, and the old directory is still removed by the path it holds.
