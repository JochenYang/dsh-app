---
shell: none
plugins: plugin-codegraph
---

代码图谱的概览把符号数改用「约 360 个文件、约 5.8k 个符号」这样的量级，不再让每轮索引都改动计数；装上一个语言语法后会立刻重建该语言的索引，不再等到下次重启；删除某个项目的图谱后，图谱页会告诉你去设置里重建或在该项目里打开一个会话，而不是一直转圈。
The graph overview reports its counts in magnitudes ("~360 files, ~5.8k symbols") so a re-index no longer churns the snapshot; installing a language grammar re-indexes that language immediately instead of waiting for a restart; and a project whose graph was deleted now says where to rebuild it instead of spinning.
