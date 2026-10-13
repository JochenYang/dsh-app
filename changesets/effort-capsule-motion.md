---
shell: none
plugins: plugin-effort
---

推理等级胶囊的动效：拖动跨档时轨道里的方块不再瞬移（扫过速度在拖动与写入在途期间冻结，等档位真正被会话采用才变化一次），方块不再凭空出现／消失而是淡入淡出（不可见的方块保留原位、保留相位并暂停动画），填充前沿多了一道随能量淡入的推进辉光，能量进入上三分之一时方块带 1.5px 的上下微幅漂移（系统开启「减少动态效果」时整层马赛克照旧不出现）。
Effort capsule motion: the tiles no longer teleport when a drag crosses a level (the sweep's timing is frozen while a gesture or its write is in flight, and changes once when the level is actually adopted), tiles fade in and out instead of appearing and vanishing mid-track (an unlit tile keeps its place, its phase, and pauses), the fill's leading edge gains a bloom that fades in with energy, and above the top third of the energy range the tiles drift 1.5px vertically — with the whole mosaic still removed under `prefers-reduced-motion`.
