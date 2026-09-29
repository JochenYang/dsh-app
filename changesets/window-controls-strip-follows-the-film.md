---
shell: patch
plugins:
---

启动页两处收尾：原生窗口控件条在片子上改为**透明**（页面不再在控件区声明不透明底色，外壳侧保留 alpha——它此前被刷成一条不透明近黑），片子改为**完整放下**而不是裁切填满（默认窗口尺寸下 `cover` 会左右各裁约 70px，裁掉的正是 logo 的左边缘）。
Two follow-ups on the splash: the native window-control strip is transparent over the film now (the page declares no opaque colour under those controls and the shell keeps the alpha — it used to be painted a near-black opaque bar), and the film FITS instead of filling by cropping (at the default window size `cover` cut ~70px off each side, which is the wordmark's own left edge).
