---
shell: none
plugins: plugin-ppt, plugin-doc, plugin-sheet, plugin-pdf
---

办公套件：修复胶囊条样式丢失后不会恢复。四个办公插件的样式表原先只在 apply() 时注入一次，之后没有任何代码对它的生死负责；实测一台活动安装上四个 `<style>` 标签全部消失，输入框旁那条就退化成裸 div——`display: block`、四枚竖排、宽度只剩 48px、与卡片间的 8px 间距也没了，而 apply() 不会再次运行，于是永远是裸的。现在每轮对账都会重新断言自己的样式表，掉了会自己长回来。
Office suite: the capsule bar's stylesheet now self-heals. The four office plugins injected theirs once from apply(), after which nothing owned its lifetime; measured on a live install, all four `<style>` tags had gone and the bar rendered as a bare div — `display: block`, four stacked hosts, a width of 48px, and no 8px gap to the card — and since apply() never ran again it stayed that way. Every reconcile pass now re-asserts its own stylesheet, so a dropped tag grows back on the next frame.
