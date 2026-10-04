---
shell: none
plugins: plugin-market
---

插件市场：卡片头像改为作者的真实 GitHub 头像（由仓库地址推导，加载失败回退首字母色块），并恢复网格改版时丢失的作者名一行——头像与作者名从此一一对应；修复「会话区页面」的启动竞态（打开面板时矩形尚未量出，关闭守卫抢先触发导致按钮看似无反应），现在只有页面已显示后锚点消失才收起。
Plugin market: card avatars are now the author's real GitHub picture (derived from the repo URL, falling back to a letter mark on load error), and the author row lost in the grid rewrite is restored — avatar and byline always name the same author; the conversation-area page no longer closes itself during its first measurement frame (the race that made the footer button look dead), collapsing only when the anchor disappears after the page was shown.
