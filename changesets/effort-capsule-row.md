---
shell: none
plugins: plugin-effort
---

推理等级那一行改成胶囊：轨道成为该行的第二行（不再是行下面的兄弟块），行右侧的等级名称与胶囊描边都取当前档位的颜色——名称按 WCAG 文字下限做最小幅度提升，提升基准含该行自身的 hover 底色，两种主题、全 range 实测 ≥4.5:1；描边是同一颜色的 85%（浅色）/75%（深色）透明度，合成后 ≥3:1；写进官方行的内联样式（含每次绘制重写的描边）在卸载时逐个还原，行已被官方卸载后还原同样安全；容器不再接收指针事件（轨道自己接管其范围），落空处按官方原本行为穿透到那一行；轨道吞掉"按下再松开"之后浏览器补发的那个 click，松手不会再弹开官方的等级列表。
The Effort row is now a capsule: the track is that row's second line rather than a sibling block beneath it, and both the level name beside it and the capsule's edge take the current level's own colour — the name lifted by the least amount that clears the WCAG text floor, computed against the row's own hover background as well, measured ≥4.5:1 across the whole range in both themes; the edge the same colour at 85% (light) / 75% (dark) alpha, measured ≥3:1 once composited; every inline style written to the official row — including the edge, rewritten on each paint — is restored one by one on unmount, safely even after the row itself has been replaced; the container no longer receives pointer events (the track takes its own area back), so a pointer that misses the track passes through to the row, which is the row's own behaviour; and the track swallows the `click` the browser fires after a press-and-release, so letting go of the knob no longer opens the official level list.

