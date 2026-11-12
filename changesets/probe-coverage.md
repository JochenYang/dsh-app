---
shell: patch
plugins: plugin-mcp, plugin-swarm
---

补齐覆盖：`probe-whale` 改成 CDP 驱动运行中的窗口（旧版要一个 http URL，而桌面文档是 `dsh-app://app`、宿主 token 又被日志脱敏，因此它一直跑不了），量的是两张 canvas 实际绘了多少像素；新增 `probe-settings-rail.mjs`，在没有已构建 harness 检出的机器上也能判设置栏（行数、每行一个字形、维护区一行）。`plugin-mcp` 的 P2 一并收尾：状态每页只读一次、删掉无人使用的导出、内核留着收尾记录的条目单独报告、编辑表单不再允许改服务器名；`plugin-swarm` 的 schema 测试改为校验编译后的 schema 并覆盖三种返回形态。

Coverage closes out: `probe-whale` now drives the running window over CDP — the old version needed an http URL, while the desktop document is `dsh-app://app` and the host token is redacted in logs, so it could never run — and it measures how many pixels each canvas actually paints. A new `probe-settings-rail.mjs` judges the rail on a machine without a built harness checkout (row count, one glyph per row, one merged maintenance row). `plugin-mcp`'s P2s are done too: one fleet read per page, the unused exports removed, a retained cleanup record reported as such, and the edit form no longer offers a rename; `plugin-swarm`'s schema test now validates the compiled schema across all three response shapes.
