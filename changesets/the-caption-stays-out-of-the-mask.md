---
shell: patch
plugins:
---

打开「添加插件」这类对话框时，右上角窗口按钮所在的标题栏不再被遮罩压成深色，颜色继续跟随页面主题（浅色页面白色标题栏、深色页面深色标题栏）。原因是内核的模态遮罩靠 `--dsh-frame-chrome-top` 避开标题栏，而外壳从未发布该变量，遮罩因此盖住了标题栏。
Opening a dialog such as "add plugin" no longer darkens the title bar that holds the window buttons: the strip keeps following the page theme (white on a light page, dark on a dark one). The kernel's modal mask reserves the caption through `--dsh-frame-chrome-top`, which the shell never published, so the scrim painted over the title bar.
