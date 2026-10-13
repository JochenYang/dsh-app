---
shell: patch
plugins:
---

启动失败事件改为只记录派生字段（错误类别与错误码），同一口径也用在被包裹操作的失败行、内核更新检查失败与更新安装失败上，不再把可能含 feed URL、命令行、路径或凭据的原始错误消息写进用户会外发的 `dsh-events.jsonl`；作为 detail 值传入的 Error 改记 `[error]` 标记，原始文本仍进本机 `dsh-kernel.log`（经 `redact()`）与失败提示卡。
A failed boot records derived fields only (error class and code), and the same rule now covers a wrapped operation's failure line, a kernel update check and a shell installer spawn: no raw message — which can hold a feed URL, a command line, a path or a credential — reaches the shareable `dsh-events.jsonl`. An Error passed as a detail value is the marker `[error]`, and the text still reaches the local `dsh-kernel.log` (through `redact()`) and the failure card.
