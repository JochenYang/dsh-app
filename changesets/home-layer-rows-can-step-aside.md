---
shell: patch
plugins:
---

家层里带 config 的设置行不再让应用永远改不动：内核组装顺序是「bundle 层 → profile 补丁 → 家层（`$DSH_HOME/cordis.patch.yml`）→ 命令行 overlay」，家层排在后面就会把应用写进 profile 补丁的值压住，配置编辑器因此在写入前直接拒绝（`overridden by a home patch`）。现在启动就绪后检测这类行，经你确认把它移入本 profile——值按原字节保留，两个文件都先备份，其它 profile 回落到各自默认值；无需重启即可在设置里修改。
A home-layer row that carries a config no longer blocks the app for ever: the kernel composes `bundle layers → profile patch → home layer ($DSH_HOME/cordis.patch.yml) → command-line overlays`, so a row in the home layer shadows what the app writes into the profile patch and the configuration editor refuses the write before touching anything (`overridden by a home patch`). The shell now detects those rows once the app is up and, with your confirmation, moves them into this profile — the value is kept byte for byte, both files are backed up first, other profiles fall back to their own defaults, and the setting becomes editable without a restart.
