---
shell: patch
plugins:
---

新增配置级检查点与恢复入口：每次健康启动（宿主就绪且窗口已交接到真实界面）后，把激活 profile 的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml` 与 `$DSH_HOME/cordis.patch.yml` 逐字节复制到 `<userData>/dsh-app-config-checkpoints/` 下的一代检查点（每文件 1 MB、每代 2 MB 上限，保留 3 代、整体上限 6 MB），启动失败时失败对话框多出「恢复上一次可用配置」一项（托盘也有一项）；恢复只写清单里的四个文件、写入前把被覆盖的文件另存为 `.bak-before-restore-<时间戳>`、不删任何文件、不跑任何命令，恢复后重启应用，`node_modules` 不在恢复范围内（由既有的 `profile-heal` 在下次启动时对齐已安装树）。安全模式下不写检查点，且永不自动恢复。
Configuration checkpoints and a restore entry: after every healthy start (host ready and the window handed to the live UI) the booted profile's `package.json`, `cordis.patch.yml`, `pnpm-lock.yaml` and `$DSH_HOME/cordis.patch.yml` are copied byte for byte into one generation under `<userData>/dsh-app-config-checkpoints/` (1 MB per file, 2 MB per generation, three generations kept, a 6 MB family ceiling), and a failed start now offers "Restore the last working configuration" on the failure card and in the tray; a restore writes only the four listed files, saves everything it replaces as `.bak-before-restore-<stamp>` first, deletes nothing, runs no command, relaunches the app afterwards, and leaves `node_modules` to the existing `profile-heal` step at the next start. Safe-mode runs never capture a checkpoint, and nothing is ever restored without the user asking.
