---
shell: none
plugins: plugin-todo
---

待办提醒：错过的提醒现在会被明确标注，并且能看出还积压了几条。之前的行为是「只要时间过了就一直等着」（没有过期窗口，程序关着也不影响，第二天启动照样会提醒），但提醒卡片只印一个 `09:00`——第二天 11:30 才看到时，它读起来像是刚刚准点响的；现在跨天会印完整日期（`2026-11-04 09:30`），标题改成「错过的提醒」，右上角还会说「还有 N 条」。积压按提醒时间从早到晚排队，最早的那条先响；用户点了完成、推迟或关闭才算处理掉。

Todo reminders: a missed reminder is now labelled as one, and the backlog behind it is visible. The behaviour was already "wait indefinitely" — there is no expiry window, so a reminder whose time passed while the app was closed still rings on the next start — but the notice printed a bare `09:00`, which read as an on-time ring when seen at 11:30 the next morning. A reminder from another day now prints its full date (`2026-11-04 09:30`), the title says 错过的提醒 (missed reminder), and the header adds "N more waiting". The queue is ordered oldest first, and a reminder stays armed until the user marks it done, snoozes it or dismisses it.
