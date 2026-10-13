---
shell: patch
---

启动页那行状态文字只在消息本身变化时才淡入淡出：解压进度这类同一行内的计数更新改为原地重写，不再每次重放 100ms 淡出（那次淡出短于它自身的 200ms 过渡，整行长期停在半透明状态，即用户看到的闪烁）；待写入的旧文案会被新消息取消，文案立即生效、不再滞后一个节拍。
The splash status line fades only when the message itself changes: count updates inside one line (extraction progress) are rewritten in place instead of replaying the 100ms fade — a fade shorter than its own 200ms transition, which left the line stuck mid-fade, the reported blink — and a pending write is cancelled by a newer message, so the text lands immediately instead of a tick late.
