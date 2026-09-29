---
shell: patch
plugins:
---

启动页的留白带不再是黑条：片子保持**完整放下**（不裁切），同一条片子在背后铺一层放大模糊的底衬把窗口填满，并重调两层遮罩——顶部 36px 保持足够深度让原生窗口按钮的浅色符号可读，中段随即淡出，底部只压 dock 文字那一段。实测：顶部留白带走片上颜色（左暗墙到右亮窗，采样跨度 70），控件条亮度 30/53 仍可读。
The splash's letterbox bands are no longer black bars: the film still fits WHOLE (never cropped), the same clip runs blurred and filling behind it, and the two scrims are retuned — depth kept over the 36px control strip so its light symbols stay readable, a fade immediately under it, and a floor only where the dock's text sits. Measured: the top band carries the film's own colours (dark wall to bright window, a 70-level spread across the samples), and the strip stays at luma 30/53.
