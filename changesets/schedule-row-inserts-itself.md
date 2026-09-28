---
shell: patch
plugins:
---

日程页在 0.2.0 上不再丢：这一行改为随套件插入（不再改写上游的禁用行——0.2.0 的 web bundle 已不携带该行，改写没有目标），此前每次启动会打两条 `patch: entry "ui-schedule" not found`，而日程页与提醒目录静默缺失。
The schedule page no longer drops on 0.2.0: the row is inserted by the suite instead of overriding upstream's disabled row — 0.2.0's web bundle no longer ships one, so the override had no target, every start logged two `patch: entry "ui-schedule" not found` lines, and the schedule page and its reminder catalog were silently absent.
