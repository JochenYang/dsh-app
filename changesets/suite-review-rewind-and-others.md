---
shell: none
plugins: plugin-rewind, plugin-usage, plugin-hooks, plugin-swarm, plugin-sidebar, plugin-archives, plugin-mcp
---

回滚（rewind）不再在超时后继续改写磁盘，被裁掉的撤销副本会让「已恢复」改报部分覆盖；用量统计在日志格式升级那一次不再把同一条消息数两遍；hook 条目要么整条生效、要么整条不生效，不会再出现「界面说没挂上、实际已经在拦」；子代理批量任务遇到网络瞬断会重试而不是整批按失败收尾；Git 面板在 macOS 从 Finder 启动时也能找到 git；删除归档会话前会核对目录名。
Rewinding no longer keeps writing files after its deadline, and a trimmed undo copy makes the recall report partial coverage instead of full; usage statistics no longer count one message twice across a log-format upgrade; a hook entry is either fully mounted or not at all, never "reported off while blocking"; a batch of subagents retries a dropped connection instead of failing the whole batch; the Git panel finds git under a Finder launch on macOS; and deleting an archived session checks the directory name first.
