---
shell: none
plugins: plugin-codegraph
---

代码图谱第二阶段：tree-sitter 解析层，8 种常用语法随插件发布（C 与 C++ 共用一个语法文件），其余语言在设置页按需下载并按 sha512 校验；符号与调用边提取支持 TS/JS/Python/Go/Java/C/C++/C#，重载方法各有独立标识。
Second stage of the code graph: the tree-sitter parsing layer, with eight common grammars shipped in the plugin (C and C++ share one grammar file) and the rest downloaded on request from the settings page after a sha512 check; symbol and call-edge extraction covers TS/JS/Python/Go/Java/C/C++/C#, and overloads get distinct identifiers.
