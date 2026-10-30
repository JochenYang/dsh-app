---
shell: patch
plugins: none
---

跟随内核线 0.2.1-rc.5：三十八个内核包逐个解包比对，三十五个与 rc.4 逐字节相同，改动只在 client-ui-chat 的思考内容展示（新增 `rawText`、`text` 改为展示用文本，我们不注册该槽）与 client-modules、client-ui-sidebar 各一行的构建戳，因此这一步只是依赖换线，没有源码适配。
Follow the 0.2.1-rc.5 kernel line: unpacking all thirty-eight kernel packages, thirty-five are byte-identical to rc.4 and the only edits are client-ui-chat's reasoning display (a new `rawText`, `text` now display-ready — a slot this suite does not register) plus one build stamp each in client-modules and client-ui-sidebar, so this step is a dependency move with no source adaptation.
