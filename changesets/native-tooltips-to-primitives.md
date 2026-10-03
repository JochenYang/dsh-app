---
shell: none
plugins: plugin-archives, plugin-doc, plugin-hooks, plugin-market, plugin-mcp, plugin-memory, plugin-pdf, plugin-ppt, plugin-presets, plugin-sheet, plugin-sidebar, plugin-swarm, plugin-usage
---

桌面端界面提示统一到内核自带的 Tooltip 组件：12 个套件插件里 61 处原生 `title=` 属性全部替换（图标按钮、徽章说明、截断路径全显、危险操作提示、办公胶囊提示），悬停气泡从系统延迟约 1 秒的灰框变为即显的品牌样式（按钮 500ms 延迟防扫过误触、截断文本 0ms 即显、路径类限宽 640px）；所有按钮保留 `aria-label`，气泡按需 portal 到 body 避免被弹层裁剪；其余 8 处 `title=` 经核实是确认弹窗组件的标题属性，不是原生提示，未动。
Desktop tooltips are unified onto the kernel's own Tooltip component: 61 native `title=` attributes across 12 suite plugins are replaced (icon buttons, badge explanations, truncated-path reveals, destructive-action hints, office capsule hints) — the system grey bubble with its ~1s delay becomes the instant brand-styled bubble (500ms delay on buttons to survive a sweep, 0ms for text reveals, path bubbles capped at 640px); buttons keep their `aria-label` and bubbles portal to the body where a clipping ancestor would hide them; the remaining 8 `title=` attributes are confirmed dialog-title props of the confirm component, not native tooltips, and stay.
