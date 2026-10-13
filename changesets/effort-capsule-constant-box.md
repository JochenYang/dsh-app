---
shell: none
plugins: plugin-effort
---

推理等级胶囊不再随形态改变盒子：轨道下方的说明行恒常挂载（没有话说时是一行空行，高度有下限），容器自身不再把内容的宽度算进固有尺寸——真机实测，同一张卡片在「跟随服务默认」与已指定档位之间曾是 334.5px → 248px、高 138px → 118px，整个卡片连同轨道在指针没动的情况下横向位移 87px、纵向 20px；另有一处拖动映射的修正：一次手势内的指针位置统一按手势开始时的轨道盒子换算，档位不会再在指针没动时改判。英文那条「跟随默认」的说明缩短到一行放得下。
The Effort capsule no longer changes its box with its shape: the note line under the track is always mounted (an empty line when there is nothing to say, with a height floor), and the container no longer counts its contents' width towards its own intrinsic size — measured on the running app, one card was 334.5px → 248px wide and 138px → 118px tall between "following the provider default" and a pinned level, moving the whole card and the track 87px sideways and 20px down under a pointer that never moved; a second fix maps every pointer sample of one gesture through the box the gesture started on, so the level can no longer be re-decided while the pointer stands still. The English "following the default" sentence was shortened to fit one line.
