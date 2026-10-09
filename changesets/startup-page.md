---
shell: minor
plugins:
---

启动页重做：去掉开机视频与声音开关，改为自带品牌标记的独立页面——鲸鱼马赛克（取自会话页）在主题底色上入场，背景只保留一层呼吸光晕。启动进度条改为**单一变量驱动**：填充用裁剪而非改宽度（渐变几何不再漂移，前沿颜色不随进度变化），前沿辉光跟随同一个变量（不再有跨出轨道的光带），阶段刻度落回轨道内且按位置点亮，数值按浮点指数缓动推进而不再按整数百分比跳；窗口底色改为跟随主题（浅色机器不再先闪一帧深色）。主窗口交接前把「打开界面」这一步走完再交，进度条能读到 100%。

Reworked the startup page: the opening video and its sound toggle are gone, replaced by a self-contained page carrying its own brand mark — the whale mosaic (taken from the session page) assembles over the theme background, which keeps one breathing halo only. The boot rail is now driven by ONE variable: the fill is clipped rather than resized (so the gradient's geometry never drifts and the leading edge keeps its colour), the bloom follows that same variable (no streak can leave the track), the stage ticks sit inside it and light by position, and the value eases as a float instead of stepping by whole percent; the window background follows the theme, so a light-theme machine no longer flashes the dark colour first. The handoff to the main window now completes the "opening the interface" step before it happens, so the rail can read 100%.
