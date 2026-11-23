---
shell: none
plugins: plugin-memory
---
内存插件：Linux 上错误文本里的路径脱漏一处尾巴（存储根目录的同级路径 `<root>ory\x.md` 只替换了前半段），会话日志读取在 Node 24 与 26 上都按帧读取，损坏的尾帧不再丢掉整个文件；Windows 运行时的 Node 解包不再依赖 runner 镜像上已失效的 Expand-Archive。
Memory plugin: on Linux the error-text scrubber no longer leaves the tail of a path next to the store root (`<root>ory\x.md` lost only its front), and the session-log reader reads frame by frame on Node 24 and 26 alike, so a torn tail no longer costs the whole file; the Windows runtime build extracts Node without Expand-Archive, which the runner image no longer serves.
