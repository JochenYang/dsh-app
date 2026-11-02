---
shell: none
plugins: plugin-archives
---

归档插件：删除改为先进回收站，回收站支持多选批量还原与彻底删除、删除时可选「先停止运行中的会话」；新增保留策略（7/15/30/90 天或永久、启动清理、立即清理与用量统计）与每次删除/还原/彻底删除/策略变更的审计日志；读不出的策略文件按「永久保留、不自动清理」处理。
Archive plugin: a deletion now moves the session into the trash first, the trash supports batch restore and batch purge plus a "stop running sessions first" option, and the page gains a retention policy (7/15/30/90 days or for ever, startup sweep, sweep-now and usage) plus an audit log with one line per delete/restore/purge/settings action; a settings file that cannot be read means "keep for ever, sweep nothing" rather than a 30-day policy nobody chose.

