---
shell: none
plugins: plugin-codegraph
---
代码图谱插件：把运行时才连起来的两半接进图里——Electron 的 `ipcMain.handle(通道)` 与 `ipcRenderer.invoke(通道)`、同一总线上的 `.on(事件)` 与 `.emit(事件)`、`app.get('/路径')` 与 `fetch('/路径')`——两边写法一致的键即为配对；`codegraph_impact` 的这类引用行带 `⇢ ipc|event|route` 标记与一次图例，说明它是按惯例合成的边而非解析出的事实；内联处理器与路由成为可查询的声明。
Code graph plugin: joins the two halves a parse cannot see — Electron's `ipcMain.handle(channel)` with `ipcRenderer.invoke(channel)`, `.on(event)` with `.emit(event)` on the same bus, `app.get('/path')` with `fetch('/path')` — on a key both sides spell the same way; such reference rows in `codegraph_impact` carry a `⇢ ipc|event|route` mark and a one-time legend saying they are synthesized from a convention rather than parsed; inline handlers and routes become queryable declarations.
