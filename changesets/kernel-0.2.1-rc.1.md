---
shell: patch
plugins: plugin-swarm, plugin-creative
---

跟随内核 0.2.1-rc.1：并行子代理改走统一的激活接口（tool_filter 换成 agent_preset），创作角色的工具限制改在 subagent/start 边界施加；办公载荷按内核自己的七个技能目录校验，旧的 check_office.py 标记已不存在。
Kernel 0.2.1-rc.1: swarm delegates through the unified activation seam (agent_preset replaces tool_filter) and creative roles restrict their child at the subagent/start edge; the office payload is validated by its seven skill directories, now that check_office.py is gone.
