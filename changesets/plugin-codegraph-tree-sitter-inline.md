---
shell: patch
plugins: plugin-codegraph
---

修复代码图谱无法生成：树解析库此前以运行时查找的方式加载，而运行时不会安装插件的依赖，于是每次索引都报「找不到 web-tree-sitter」。现在改为在打包时并入插件自身，安装后不再依赖任何外部模块。
Fix the code graph failing to build: the parser library was loaded by a runtime lookup, but the runtime never installs a plugin's dependencies, so every index attempt reported "cannot find web-tree-sitter". It is now bundled into the plugin itself, so an installed copy needs no external module.
