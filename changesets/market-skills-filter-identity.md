---
shell: none
plugins: plugin-market
---

插件市场：技能卡片的名字现在可以点开详情卡片（简介全文、下载量/收藏/版本数、子分类标签、更新时间、作者页面，并可就地安装或卸载）；已安装技能卡片补上技能自身的简介，体积信息移到与插件卡片一致的底行，不再是一行孤立的灰字。修复详情接口把返回体当成列表信封解析导致的「answered code undefined」报错，以及配套的 host 构建缺失 ESM require 桥接导致插件整体加载失败（「按钮都不见了」）。补上此前完全没有 hover 反馈的基础按钮、主按钮、危险按钮与页签；分类筛选选中已选项时不再重新请求，切换页签时高亮不再播放入场动画。
Market plugin: a skill card's name now opens a detail card (full description, download/star/version counts, sub-category labels, last update, author page, plus install or uninstall in place); installed-skill cards gained the skill's own description, with the size line moved onto the same footer row the plugin cards use instead of standing alone as a grey line. Fixed the detail endpoint being parsed as the list envelope ("answered code undefined"), and the host build's missing ESM require handoff that made the whole plugin fail to load (the reported "all the buttons are gone"). Added the hover feedback the base, primary and danger buttons and the tabs never had; selecting the already-selected category no longer refetches, and the filter highlight no longer plays an entrance animation when switching tabs.
