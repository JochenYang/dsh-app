---
shell: patch
---

启动页：去掉鲸鱼背后那层固定 320px 的光圈（它比鲸鱼窄、又比鲸鱼高，两侧的尾鳍与左弧一定跨到光圈外），鲸鱼改为按自身墨迹包围盒居中——改前偏左 1 格、偏上 1.5 格，另有一个固定 6px 的下推；指针推散手感、配色与帧率与会话页统一（30fps 相位累加，改前实际只有 20fps）。
Startup page: the fixed 320px halo behind the whale is gone (narrower than the whale and taller than it, so the fluke and the left arc always crossed it), and the mosaic is centred on its own ink box — it had sat 1 cell left and 1.5 cells above the canvas centre, plus a fixed 6px nudge. The pointer push, the palette and the frame rate now match the session page (30fps behind a phase accumulator; the old gate measured 20fps).
