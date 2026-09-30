---
shell: patch
plugins:
---

标题栏配色在所有状态下都与页面主题一致：启动即是正确颜色（不再等主题变化才纠正）、打开自己的对话框或插件市场时同样跟随，深色下不再出现右上角发黑的一块。此前启动时采样早于主题写入、标题栏底带被内容层盖住、对话框遮罩写死黑色且铺满视口，三者叠加成了这几个现象。
The title bar matches the page theme in every state: it is correct from the first paint instead of only after a theme change, it follows when a dialog or the plugin market is open, and the dark block at its right end is gone. Three causes stacked up: sampling ran before the theme was written, the band was painted over by the content column, and the dialog scrim was a hardcoded black spanning the whole viewport.
