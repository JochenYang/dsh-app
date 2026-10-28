---
shell: patch
plugins: none
---

跟随内核线 0.2.1-rc.4：三十八个内核包逐个解包比对，三十五个与 rc.3 逐字节相同，只有 client-modules、client-ui-conversation、client-ui-sidebar 三个的 `lib/` 有改动，都不触及本仓使用的工具、提示词与会话接口，因此这一步只是依赖换线，没有源码适配。
Follow the 0.2.1-rc.4 kernel line: unpacking all thirty-eight kernel packages, thirty-five are byte-identical to rc.3 and only client-modules, client-ui-conversation and client-ui-sidebar carry `lib/` edits — none touching the tool, prompt or session interfaces this repository uses, so this step is a dependency move with no source adaptation.
