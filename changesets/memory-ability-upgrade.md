---
shell: none
plugins: plugin-memory
---
记忆插件：每轮带入更多卡片正文（按新旧取用、取消分类配额），正文上限提到 500 字，召回未命中会自动回退；删除前撤销副本写不出时不再丢卡，后台整理失败可诊断并退避，设置页新增工具调用计数、注入量与坏目录提示。
Memory plugin: more card bodies ride into each turn (taken newest-first, no per-category quotas), the body cap rises to 500 characters, and a recall miss falls back on its own; a deletion whose undo copy cannot be written keeps the card, the background curator diagnoses and backs off its failures, and the settings page gains tool-call counts, injection figures and a notice for unreadable directories.
