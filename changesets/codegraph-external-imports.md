---
shell: none
plugins: plugin-codegraph
---
代码图谱插件：从项目之外的模块（Node 内建模块、`node_modules` 里装的第三方包）导入的名字不再被误连到项目里的同名声明——此前测试框架的 `describe`/`expect` 会让一个同名项目函数变成「最常引用」的符号；「最常引用」排行改为按源码文件（不含测试）的引用数排序并标注；升级后首次打开各项目会重建一次图谱。
Code graph plugin: a name imported from a module outside the project (a Node built-in, a package installed under `node_modules`) is no longer linked to an unrelated same-named project declaration — a test framework's `describe`/`expect` used to make a project function of that name the "most referenced" symbol; the "most referenced" list is now ranked and labelled by references from source files (tests excluded); each project's graph is rebuilt once on first open after the upgrade.
