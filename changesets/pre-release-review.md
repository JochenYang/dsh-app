---
shell: patch
plugins: plugin-mcp, plugin-swarm
---

发版前那一轮独立审查的阻塞项全部关掉：把 `$ENV:` 这个本行已不解析的旧引用语法从占位符与文档里去掉，并给旧的 `$ENV:` 值补回真正的警告（卡片不再在鉴权失败时显示已挂载）；只读守卫与四条写路由一样返回编码错误，不再从处理器里抛裸 500；卡片开关改成一字段路由，不再用页面加载时的快照整条回写；`primary-runtime` 的链接改成先建暂存链接再换入，一次被拒绝的 junction 不会再毁掉可用的旧链接；两个 CDP 探针的助手入库，新克隆里也能跑；构建期垫片门槛改成问「树里还有谁在解析 kit」，provider 再改名会直接构建失败而不是静默丢能力。

Every blocking finding from the pre-release review is closed: the `$ENV:` syntax this line no longer resolves is gone from the placeholders and the docs, and a stored `$ENV:` value now raises a real warning (the card stops claiming "mounted" while auth fails); the read-only guard answers a coded error like the four write routes instead of throwing a bare 500 out of the handler; the card's switch is a one-field route instead of a full replace from the page-load snapshot; the `primary-runtime` link is staged beside the leaf before the old one is touched, so a refused junction no longer destroys a working link; the two CDP probes import a committed helper and run from a fresh clone; and the build's kit-shim gate asks who in the tree resolves the kit, so the next provider rename fails the build instead of silently losing the capability.
