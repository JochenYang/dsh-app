---
shell: none
plugins: plugin-presets, plugin-todo
---
预设与待办插件：配置备份在本机没有凭据库时，导出结果会注明「本备份不含凭据库，导入到其他机器后需重新填写 API 密钥」；导入不含凭据库的备份时，结果会注明「本机的 API 密钥未改动」。待办提醒在窗口最小化、隐藏到托盘或被完全遮挡时同时发出系统通知（经桌面壳的 notify 动作，只写「有 N 条待办到期」，不带任务内容），此前这种状态下提醒完全看不到。
Presets and todo plugins: when this machine has no credential store, the configuration-backup export now says the archive carries none and that the API keys must be entered again after importing it elsewhere; importing a backup without a credential store now says this machine's own keys were left untouched. A todo reminder now also raises a system notification while the window is minimised, hidden to the tray or fully covered (through the desktop shell's notify action, carrying only how many reminders are due, never a task's text), the states in which it previously could not be seen at all.
