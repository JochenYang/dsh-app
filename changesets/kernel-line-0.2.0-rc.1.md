---
shell: patch
plugins:
---

跟随内核线到 0.2.0-rc.1：24 个 `@deepseek-ai/dsh-*` 依赖与 16 个插件的 peer/dev 范围一起升（只改根 spec 会让插件编译在旧线上），锁文件整体重建；上游列出的 8 处破坏性变动没有一处打到我们的代码，运行时按新线重建并经真机启动验证。
The kernel line is followed to 0.2.0-rc.1: the 24 `@deepseek-ai/dsh-*` specs and the 16 plugins' peer/dev ranges move together (changing the root specs alone would leave the plugins compiling against the old line), the lockfile is rebuilt from scratch, none of the eight breaking changes upstream listed reaches this code, and the runtime is rebuilt on the new line and verified by a real start.
