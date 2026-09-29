---
shell: patch
plugins:
---

启动页改成循环播放的开场片：进度条、五个步骤轨与文案重做成叠在片子上的一栏（有总长时显示百分比，无总长时走柔光扫动而不是冻住），新增声音开关——默认静音（还没有任何用户手势时，带声自动播放本就必被拒），点一下即开声；失败卡改为居中对话框，仍跟随系统主题。片子放在 `static/media/`，随外壳一起打进 asar，打包门禁改成放行该子目录并断言片子在场。
The splash now plays the opening film on loop, with the progress bar, the five-step rail and the copy redesigned as one dock over it (a real ratio shows a percentage; without a total the bar sweeps instead of freezing) plus a sound toggle — muted by default, because an unmuted autoplay is refused outright before any user gesture, and one click is that gesture. The failure card is a centred dialog and still follows the system theme. The film lives in `static/media/`, ships inside the asar with the shell, and the packaging gate now admits that subdirectory and asserts the film is present.
