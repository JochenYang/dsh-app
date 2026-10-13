---
shell: none
plugins: plugin-effort
---

composer 胶囊里的推理等级文字改成本档位的颜色并加粗：与弹出菜单里同一个等级的名字取同一个颜色（同一个 ramp、同一次读取，两处不会各算一套），比内核原本的 caption 灰更实；档位变化、深浅主题切换、会话切换时同步更新，该会话没有档位时还原成内核自己的颜色与字重；深色主题下该文字所在的输入卡片比菜单卡片更浅，等级色的对比度下限基准因此改到这张卡片上重算（全 range 最深一档的名称色由 `#AE92FF` 调整为 `#B297FF`，两张实测表同步更新，四个表面扩为六个 —— 含 composer 卡片及其 hover —— 实测仍 ≥4.5:1）；标记属性只在官方那个 span 上写一次，卸载时连同颜色一起还原。
The reasoning-level text in the composer capsule now takes its level's own colour and a heavier weight: the same level colour the popup menu's capsule shows (one ramp, one reading, so the two surfaces can never compute different answers), instead of the kernel's pale caption tone; it follows a level change, a theme switch and a session switch, and falls back to the kernel's own colour and weight when that session has no level on the scale; because the composer's card is lighter than the menu's in the dark theme, the contrast basis moved to that card and the darkest level's name colour was recomputed (`#AE92FF` → `#B297FF`), with both measured tables updated — four surfaces becoming six, the composer's card and its hover among them — still measured ≥4.5:1; the mark is written once on the official span and is removed, with the colour, on dispose.
