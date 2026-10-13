---
shell: none
plugins:
---

构建输入：11 个插件的 `devDependencies` 补上 `@deepseek-ai/dsh-client-ui-primitives`（与既有 3 个插件同 spec），使 CI 的 `--legacy-peer-deps` 树上也能解析到它，从而让插件类型门禁在全部 18 个插件上真正生效。不改变任何插件的行为、不 bump 版本、不改依赖范围。
Build input: eleven plugins now declare `@deepseek-ai/dsh-client-ui-primitives` in their own `devDependencies` (the spec the three plugins that already did use), so it resolves on CI's `--legacy-peer-deps` tree and the plugin type gate runs for all eighteen. No plugin behaviour, version or range changes.
