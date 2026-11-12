---
shell: patch
plugins:
---

办公转换在真机上真正跑通了两件事：经 `office_to_pdf` 工具的成功返回（此前只验到「用载荷里的真 kit 直接调」——经工具走的是垫片，而 0.2.2-rc.2 的 kit 从消费方解析到的入口锚定引擎，于是恒报 unavailable；垫片现在把引擎解析显式指向载荷的 `node_modules`）；带 Python 集的载荷也验到 `load_workspace_dependencies` 返回内置 python，导入 docx/pptx/openpyxl 成功。另修 smoke 套件的一处断言：MCP 条目的挂载现在是内核管理器的异步 reconcile，导入后单次读状态会拿到 `starting`，改成与 create 路径一致的轮询。

The office path is now proven through the tool itself: `office_to_pdf` answered `status: exported` with 18303 bytes. Previously only the payload's own kit had been tried, and the tool goes through the shim instead — 0.2.2-rc.2's kit anchors engine resolution at the entry the consumer resolved, so the shim (in the runtime tree, engine in the payload) could only answer unavailable; the shim now points `resolveEnginePackage` at the payload's `node_modules`. The Python-carrying payload was verified too: `load_workspace_dependencies` returned the bundled interpreter and importing docx/pptx/openpyxl succeeded. One smoke assertion also changed: an MCP entry's mount is now the kernel manager's asynchronous reconcile, so the import check polls like the create path instead of reading once and catching `starting`.
