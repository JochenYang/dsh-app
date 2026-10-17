---
shell: none
plugins: plugin-websearch
---

网络搜索设置页改为按内核注册表报告搜索来源：0.2.1 新增的 DeepSeek Search API 现在有自己的卡片，某个 id 的 loader 行被 patch 层禁用时显示原因而不是让卡片消失，「使用中」以 ctx.web 实际配置的 id 为准，不再回显页面自己存下的旧值。切换按钮已移除：0.2.1 把 searchProvider 改成只读的 volatile 字段，而 profile 的 web 行由桌面套件的 --patch 覆盖层决定、内核配置编辑器拒绝编辑被覆盖层接管的行——页面上点一下不可能真的切换，所以改成如实说明来源由哪里决定。两条 DeepSeek 路线各有自己的名称、说明与计费文案：模型检索按 token 计费且没有按次单价，只有 Search API 才有 2026-11-01 起的 5 元 / 千次价格。
The web-search settings page now reports the search source from the kernel's registry: 0.2.1's DeepSeek Search API gets its own card, an id whose loader row is disabled says why instead of vanishing, and "in use" follows the id ctx.web is actually configured with rather than the page's stored value. The switch is gone: 0.2.1 turned searchProvider into a read-only volatile field, and the profile's `web` row is owned by the desktop suite's `--patch` overlay, which the kernel's config editor refuses to edit — so a click here could never take effect, and the page says where the source is decided instead. The two DeepSeek routes now carry separate names, hints and price lines: model retrieval bills by token with no per-call price, and only the Search API has the 2026-11-01 CNY 5 / 1000-call price.
