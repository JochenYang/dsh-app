---
shell: none
plugins: plugin-websearch
---

网络搜索设置页改为按内核注册表报告搜索来源：0.2.1 新增的 DeepSeek Search API 现在有自己的卡片，某个 id 的 loader 行被 patch 层禁用时显示原因而不是让卡片消失，「使用中」以 ctx.web 实际配置的 id 为准。切换在 0.2.1 上会被内核的配置编辑器拒绝（它拒绝编辑被 `--patch` 覆盖层接管的行），所以同一个行改由 profile 自己的补丁层承载、切换写进那一层；启动时按保存的选择重新应用一次，重启后仍然生效。每次读取都取当前 ctx.web 实例，写完之后页面立刻反映真实来源。两条 DeepSeek 路线各有自己的名称、说明与计费文案：模型检索按 token 计费且没有按次单价，只有 Search API 才有 2026-11-01 起的 5 元 / 千次价格。
The web-search settings page now reports the search source from the kernel's registry: 0.2.1's DeepSeek Search API gets its own card, an id whose loader row is disabled says why instead of vanishing, and "in use" follows the id ctx.web is actually configured with. On 0.2.1 a switch is refused by the kernel's config editor when a `--patch` overlay owns that row, so the same row now rides the profile's own patch layer and the switch writes into it; the saved choice is re-applied at every start, so it survives a restart, and every read takes the current ctx.web instance so the page reflects the source that actually answers. The two DeepSeek routes now carry separate names, hints and price lines: model retrieval bills by token with no per-call price, and only the Search API has the 2026-11-01 CNY 5 / 1000-call price.
