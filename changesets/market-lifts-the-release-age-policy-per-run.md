---
shell: none
plugins: plugin-market
---

插件市场把「放开一次发布冷静期」放进命令本身：这个 profile 的锁文件按常态就钉着冷却期内的版本（套件与跟随的内核线当天发布、用户刚装过的插件也是），而 pnpm 在每条命令前校验锁文件，所以装卸此前都要先失败一次才成功；现在一次就成，profile 自己的策略与其余运行照旧不动，也不写回任何文件。
The market now carries the one-shot release-age lift on the command itself: this profile's lockfile routinely pins versions inside pnpm's cooldown window (the suite and the followed kernel line publish same-day, as does every plugin just installed) and pnpm verifies the lockfile before every command, so install and uninstall used to fail once before succeeding; they now succeed first time, with the profile's own policy and every other run untouched and nothing written back.
