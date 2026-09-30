---
shell: patch
plugins:
---

内核运行时构建会在开始前清掉本机 `runtime-dist/` 里**同一目标平台**的旧版本产物（旧 runtime 与旧 office payload 及其 sha512 附属文件），只保留本次要构建的版本。此前每次换线都会留下约 400 MB 再也读不回来的文件（三个线累积到 1.9 GB）。
The kernel runtime build now retires this machine's `runtime-dist/` artifacts of OTHER versions for the same target cell before it starts (the old runtime, the old office payload and their sha512 sidecars), keeping only the version being built. Each kernel-line bump used to leave ~400 MB nothing could ever read back again (1.9 GB after three lines).
