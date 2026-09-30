---
shell: patch
plugins:
---

应用更新在替换进程前先问内核有没有任务在跑：宿主自己的 `quit-inspection` / `update-tasks` 回答（正在生成、跑工具、子智能体、排队消息、后台作业都算），有任务时先警告再让用户决定；宿主答不上来一律按「有任务」处理。此前是直接启动安装向导并退出，会把正在进行的对话静默切断。
The app update now asks the kernel whether work is in flight before it replaces the process: the host's own `quit-inspection` / `update-tasks` answers it (generating, running a tool, subagents, queued messages and background jobs all count), the user is warned and decides when there is work, and an unanswerable host always reads as "work in flight". It used to spawn the installer and quit outright, cutting a running conversation in half.
