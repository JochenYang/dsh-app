---
shell: none
plugins: plugin-effort
---

推理等级滑条：拖动时跨过档位节点即写入，官方菜单「推理等级」那一行的值跟着变（此前只在松手时写，整段拖动都显示旧档位）；同一时刻只允许一笔写入在途，拖动期间到达的节点由那一笔的响应收尾时补发，快速横扫与来回抖动各只写 2 笔而非每跨一格一笔；补上 `remote` / `remote.session` 的服务声明，修掉某些会话首次渲染时轨道不出现并抛 `cannot get property "remote.session" without inject`。
Reasoning-effort track: a level is now written as the pointer crosses into its band, so the official Effort row follows the drag (it used to be written only on release, leaving that row on the old level for the whole gesture); at most one write is in flight and crossings that arrive meanwhile are coalesced into the next one, so a fast sweep and a back-and-forth jitter cost 2 writes each rather than one per crossing. It also declares the `remote` / `remote.session` services, fixing a session whose first render threw `cannot get property "remote.session" without inject` and showed no track.
