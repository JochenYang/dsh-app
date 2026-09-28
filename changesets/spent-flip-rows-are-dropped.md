---
shell: patch
plugins:
---

启动时顺手摘掉 profile patch 里已经没用的套件残留行：老外壳写的「启用」行（如 `- id: ui-schedule` + `disabled: false`）在 0.2.0 上没有可改写目标，安全模式（套件层为空）下会重新打出 `patch: entry … not found`。只摘同时满足三个条件的行——id 由当前 overlay 以 insert 声明、没有 config、状态与层里那行一致——带配置的行与用户自己关掉的行一律保留，迁移前照旧留 `.pre-suite-layer-*` 备份。
Startup now also drops the suite's spent rows from the profile patch: an enable flip an older shell wrote (`- id: ui-schedule` + `disabled: false`) has no target on 0.2.0 and re-logs `patch: entry … not found` in safe mode, where the suite layer is written empty. Only rows meeting all three conditions go — the id is one the current overlay INSERTs, the row carries no config, and its state matches the layer's own — while rows carrying settings and rows a user switched off are kept as they are, with the same `.pre-suite-layer-*` backup as the rest of the migration.
