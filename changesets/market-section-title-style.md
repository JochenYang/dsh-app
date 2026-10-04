---
shell: none
plugins: plugin-market
---

插件市场：补上「已安装技能」节标题的样式。`dshMkt-sectionTitle` 自技能页签落地（8e4f703）起只出现在 JSX 里、样式表从未定义过，一直靠浏览器默认 h3 渲染，视觉上像混进面板的一行文档标题；现在有明确的层级（13.5px/600，比面板标题低一级）和与网格的间距。
Market plugin: the installed-skills heading finally has a style. `dshMkt-sectionTitle` has appeared in the JSX only since the skills tab landed (8e4f703) and was never defined in the stylesheet, so it rendered as a browser-default h3 that read as a stray document heading inside the panel; it now has a deliberate level (13.5px/600, one below the panel title) and spacing to the grid.
