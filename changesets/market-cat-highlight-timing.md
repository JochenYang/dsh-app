---
shell: none
plugins: plugin-market
---

插件市场：修复分类筛选高亮的「首帧抑制」不可靠——原实现用 requestAnimationFrame 翻回标记，而窗口失焦或后台时浏览器会节流帧回调，标记便一直停在抑制态（实测连续 30 次采样共 4.35 秒都未恢复）。改为写入 DOM 并强制一次重排，不再依赖帧时钟：实测首次挂载 0 个转场（无入场动画）、后续切换仍有 2 个 160ms 滑动转场、无焦点窗口下标记立即为 false。同时把技能名上的原生 title= 换成内核 Tooltip（该约定在 0314be5 已确立），删掉详情接口里从未赋值的 homepage 死字段。
Market plugin: the category highlight's first-placement suppression was frame-dependent — it flipped the flag back inside a requestAnimationFrame, and a background or unfocused window throttles those callbacks, so the flag stayed on (measured: 30 samples over 4.35 s, never cleared). The placement and the flag are now written straight to the DOM with one forced reflow, so the behaviour no longer rides the frame clock: measured, the first mount shows 0 transitions (no entrance motion), a later selection still shows the two 160 ms indicator transitions, and in an unfocused window the flag reads false immediately. The skill name's native title= became the kernel Tooltip (the suite's convention since 0314be5), and the detail interface lost a homepage field that was never assigned.
