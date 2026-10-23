---
shell: none
plugins: plugin-codegraph
---

代码图谱重启后会记住所有已建图的项目，不再只显示本次开过的那一个；新增 PowerShell 支持；「因语言未安装被跳过」不再把「没有提取规则」的文件算进去。
The code graph remembers every project that has a graph across restarts instead of only the one opened this run; PowerShell is supported; and the "skipped because the language is not installed" count no longer includes files whose grammar has no extraction rules.
