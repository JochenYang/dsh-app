---
shell: patch
plugins: plugin-mcp, plugin-swarm, plugin-websearch
---

MCP 归内核管理器：`@deepseek-ai/dsh-mcp-manager` 现在一个服务器挂一个 client，按行的 `config.servers` reconcile，所以我们的 plugin-mcp 不再自带 `servers.json`、也不再动态挂载——页面保留，存储改成那行的配置（经内核 config editor 写入），状态读 `ctx.mcpManager`，旧文件一次性导入后改名留档（旧文件的全局开关映射成逐条关闭，升级不会把你关掉的舰队挂起来）。另外两处跟官方：swarm 的批次结果带上内核给的子代理名字（报告与 `list_agents` 一致），我们的 web 搜索与抓取 provider 补上 `title` / `description`（否则内核那个页面只能显示 id）。

MCP moves to the kernel manager: `@deepseek-ai/dsh-mcp-manager` mounts one client per configured server and reconciles the row's `config.servers`, so plugin-mcp keeps its page but drops its own `servers.json` and its dynamic mounting — the row's config is the store (written through the kernel config editor), status comes from `ctx.mcpManager`, and the old file is imported once and renamed aside (its retired global switch becomes per-entry `enabled: false`, so an upgrade never mounts a fleet you had turned off). Two more follow-the-official changes: swarm's batch results carry the child's kernel-assigned name, so a report and `list_agents` agree, and our web search and fetch providers now declare `title` / `description` for the kernel's own provider picker.
