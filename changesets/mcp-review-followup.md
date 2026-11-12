---
shell: patch
plugins: plugin-mcp, plugin-swarm
---

补齐两轮审查发现的问题：MCP 设置页清空某个字段（环境变量、参数、超时）会真的删掉它，而不再把旧值悄悄留着继续发给子进程；掩码值在写入时按当时的条目解析，别的写者刚换掉的凭据不会被旧值覆盖；读不到 `mcp-manager` 行配置时报错而不是显示空舰队；旧 `servers.json` 在行里已齐备时也会被移走，删掉的服务器不会被下次启动复活；`primary-runtime` 叶子上不是本壳写的目录改为拒绝而不是删除。swarm 的子代理名字能穿过重试车道，单发路径不再把 undefined 写进工具值。

Closes what two review rounds found: clearing a field in the MCP page (env, args, timeout) now really removes it instead of silently keeping the old value and still handing it to the child; a mask sentinel is resolved against the entry as it is at write time, so a credential another writer just rotated is not overwritten with the stale one; an unreadable `mcp-manager` row reports an error instead of an empty fleet; the legacy `servers.json` is retired even when the row already holds every key, so a deleted server is not resurrected on the next start; and a `primary-runtime` leaf directory this shell did not write is refused rather than deleted. Swarm's child name survives the retry lane, and the one-shot path no longer puts an undefined name into the tool value.
