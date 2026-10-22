---
shell: none
plugins: plugin-archives, plugin-sidebar
---

会话归档：每个会话和每个项目分组都补上「恢复」按钮，把会话移出归档集、重新出现在列表里；恢复不删日志，所以不弹确认框。
Session archives: every session and project group gains a Restore button that drops the session from the archive set and shows it in the list again; restoring never touches the log, so it needs no confirmation.

Git 面板的变更标尺：色块高度改为严格按变更行数占全文的比例绘制，去掉了原来 2px / 0.6% 的下限——那会让一行的改动看起来和一大段一样长。点击热区改用伪元素外扩，细小色块仍然可点。
The Git panel's change ruler now draws each mark at the true fraction of changed lines, with the old 2px / 0.6% floor removed — it made a one-line change look as long as a whole block. The click target moved to a pseudo-element overhang, so hairlines stay clickable.
