---
shell: patch
plugins:
---

日志目录新增结构化事件文件 `dsh-events.jsonl`：每行一个 JSON 事件（启动/退出、内核子进程的启动与退出码、宿主就绪、内核更新检查与安装、安装/回滚的开始与结束及耗时），带单次启动的关联 id 与单调序号，按 2 MiB 与跨 UTC 天轮转、保留 4 代（总量上限 10 MB）；值一律先经 `redact()` 擦除并截断到 2000 字符，`redact()` 新增 URL userinfo 规则（`scheme://user:pass@host` 只留 `[redacted]@`），`shell.update.mirror` 改记来源标签而非原始 URL，`host.start.failed` 只记派生字段（how/code/signal/attempt），内核子进程 stderr 尾巴与提示词、响应正文一样不进这个文件。
The log directory now carries `dsh-events.jsonl`: one JSON event per line (startup and quit, the kernel child's start and exit code, host readiness, kernel update checks and installs, each install or rollback with its result and duration), tagged with a per-start correlation id and a monotonic sequence, rotated at 2 MiB and on a UTC day change with four generations kept (a 10 MB ceiling); every value passes the existing `redact()`, which gained a URL-userinfo rule (`scheme://user:pass@host` keeps only `[redacted]@`) and stays capped at 2000 characters, `shell.update.mirror` records a source label instead of the raw URL, and `host.start.failed` records derived fields only (how/code/signal/attempt) — so the child's stderr tail can no more land in the file than prompts or response bodies can.
