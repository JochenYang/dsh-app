---
shell: none
plugins:
---

构建：运行时构建改从仓库提交的 package-lock.json 取内核版本，不再跟随 npm `next`；同时为套件插件声明的每个内核 peer 写入精确版本覆盖，避免插件 tarball 的范围 peer 把更新的内核拉进同一棵树。
Build: the runtime build now takes the kernel version from the committed `package-lock.json` instead of following npm `next`, and pins every kernel peer the suite declares, so a plugin tarball's range peer can no longer pull a newer kernel into the same tree.
