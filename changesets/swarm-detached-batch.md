---
shell: none
plugins: plugin-swarm
---

并行子代理：在 run_code 程序内发起的批次改为交给后台任务执行，程序超时不再连带中止子代理，结果照常回传。
Swarm plugin: a batch started inside a run_code program now runs as a host background job, so the program's deadline no longer kills the batch with its subagents and the report still comes back.
