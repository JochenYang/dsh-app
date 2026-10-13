---
shell: patch
plugins:
---

启动失败事件改为只记录派生字段（错误类别与错误码），不再把可能含路径、命令或凭据的原始错误消息写进用户会外发的 `dsh-events.jsonl`；该消息仍进本机 `dsh-kernel.log` 与失败提示卡。
A failed boot now records derived fields only (error class and code) instead of the raw message in the shareable `dsh-events.jsonl`; the message still reaches the local `dsh-kernel.log` and the failure card.
