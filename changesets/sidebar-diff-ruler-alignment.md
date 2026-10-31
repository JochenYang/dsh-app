---
shell: none
plugins: plugin-sidebar
---

Git 面板 diff 预览：右侧变更标尺现在与代码行严格对齐。此前它作为滚动容器的兄弟节点按**视口高度**铺开、且不随内容滚动，色块被压缩且静止，长 diff 里指的位置和实际改动完全对不上。
Git panel diff preview: the change ruler now lines up with the code rows. It used to be a sibling of the scroll container, so it spanned the VIEWPORT height and stood still while the diff scrolled — the marks were compressed into the visible area and pointed at lines that were not there.
