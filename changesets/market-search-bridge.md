---
shell: patch
plugins: plugin-market
---

市场插件：移除「旧 profile 还有 N 个插件未安装」的迁移提示与一键迁移入口，忽略后不再反复提醒；新增 market_search 让用户问「有没有能做 X 的 skill / 插件」时按真实目录回答，并新增 market_install_skill / market_install_plugin / market_uninstall_skill，用户选定后可由对话直接安装——与面板点击走同一套执行器与同一条串行队列；插件安装只装未装过的名字，同名已装（含本地/Git 开发副本）一律拒绝并说明，替换仍由面板在确认后执行；修复 skill 关键词搜索：SkillHub 已不接受 sortBy=relevance（返回 400），改用 score 后关键词搜索恢复出结果。
Market plugin: removed the "N plugins from the previous profile are not installed here" migration prompt and its install-all entry, so dismissing it no longer comes back; added market_search so "is there a skill/plugin for X" is answered from the real catalogs, plus market_install_skill / market_install_plugin / market_uninstall_skill so a chosen item installs straight from the conversation — over the same executors and the same serialized queue the panel's click uses; a plugin install only ever adds an uninstalled name, refusing a name that is already installed (a local/Git development copy included) and saying so, while replacement stays the panel's own confirmed action; fixed skill keyword search — SkillHub no longer accepts sortBy=relevance (it answers HTTP 400), so the query now sends score and keyword search returns results again.
