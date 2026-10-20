---
shell: none
plugins: plugin-effort
---

推理等级的轨道改用内核自己的 Tooltip 显示按键提示，不再用浏览器原生 `title`（后者由系统绘制、延迟和字体都不受主题控制，和这张卡片其他部分放在一起像是浏览器残留）。同时给每个刻度加了指针反馈：指针悬停到某一档时，该刻度会放大到 2.2 倍并高亮——放大用 `transform` 而不是改宽高：不必为每个指针采样做一次排版，而且放大以刻度自身圆心为原点（改宽高会保留左上角、让圆点偏移半个增量）；过渡只挂在 `transform` 上，所以档位变化（刻度的颜色）仍然即时，不会跟着淡入淡出。悬停只是一个独立的 `data-hover` 状态，不写任何值；系统开启「减少动态效果」时标记仍然出现，只是不再有过渡。
The reasoning-effort track now shows its keys hint through the kernel's own Tooltip instead of the browser's native `title` — the latter is drawn by the OS, with its own delay and type that cannot follow the theme, and beside the rest of this card it read as a browser artefact. Every tick also gains pointer feedback: the level under the pointer grows to 2.2x and takes the theme's primary label colour, so the level a click would select is visible before the click. The growth is a `transform`, never a size change, so neighbouring ticks are not re-laid out; the transition is on `transform` alone, so a level change (a tick's colour) stays instant instead of fading with it. The hover is its own `data-hover` state and writes no value, and with reduced motion enabled the mark still appears — it just gets there without a transition.
