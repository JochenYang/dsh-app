---
shell: patch
plugins:
---

跟随内核线到 0.2.0-rc.2：根 23 个 `@deepseek-ai/dsh-*` spec 与 16 个插件的 peer/dev 一起升到 `^0.2.0-rc.2`，并按换线规程清空根与全部插件的 `node_modules`/lockfile 重装（保留旧 lockfile 会 ERESOLVE 失败）；运行时按新线重建，全部门禁与真机检查重跑。
The kernel line is followed to 0.2.0-rc.2: the root's 23 `@deepseek-ai/dsh-*` specs and the 16 plugins' peer/dev ranges move to `^0.2.0-rc.2` together, with the documented clean reinstall (keeping the old lockfile ERESOLVEs), and the runtime is rebuilt on the new line with every gate and the real-machine checks re-run.
