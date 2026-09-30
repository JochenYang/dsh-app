---
shell: patch
plugins: plugin-client-ui
---

鲸鱼背景在 v0.14.5 之后消失：外壳开始发布 `data-windows-titlebar`（标题栏适配要用），于是内核标题栏布局的两条规则生效——frame 与中列各自被刷成不透明底色。鲸鱼画布在最底层（`z-index: -1`），被整片盖住。现在鲸鱼的样式表按同等优先级把这两处底色改为透明；实测量：标记打开时，隐藏画布对页面像素的影响从 0 个恢复到 2485 个（与关闭标记时完全一致），两种主题下的底色与原先相同。
The whale background disappeared after v0.14.5: publishing `data-windows-titlebar` (which the caption adaptation needs) activated two kernel rules that fill the frame and the center column opaquely, and the canvas paints in the lowest layer, so it was buried whole. The whale's own stylesheet now makes both fills transparent at matching specificity; measured, with the marker on, hiding the canvas went from changing 0 page pixels to the same 2485 it changes with the marker off, and the base colour is unchanged in both themes.
