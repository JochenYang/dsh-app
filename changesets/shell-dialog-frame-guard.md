---
shell: patch
plugins: none
---

关闭窗口时的渲染进程报错不再刷满日志：注入脚本前会确认窗口的渲染帧仍可响应，而不再只看窗口对象是否已销毁。此前每次关窗都会打印一条 `Render frame was disposed before WebFrameMain could be accessed`，对话框与遮罩同步都受影响。
Closing a window no longer fills the log with renderer errors: an injected script now checks that the window's render frame can still answer instead of only that the window object exists. Every close used to print `Render frame was disposed before WebFrameMain could be accessed`, from both the themed dialog and the overlay sync.
