---
shell: none
plugins: plugin-sidebar
---

侧边栏 Git 页签新增「树形 / 列表」查看切换：树形按顶层目录分组、可折叠（分组标题已写出目录名，组内行只显示相对路径，不再每行重复目录前缀）；列表把每个文件排成一行并显示完整路径，适合已知路径时直接找。切换只改变呈现方式，不改变行内容、操作按钮与点击查看差异的行为。
Sidebar Git tab gains a Tree / List view toggle: the tree groups by top-level directory with collapsible headers and labels each row relative to its group (the header already names the directory, so rows stop repeating it); the list puts every file on one row with its full path, which is what you want when you already know the path. The toggle changes presentation only — same rows, same actions, same click-to-diff behaviour.
