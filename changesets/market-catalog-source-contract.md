---
shell: none
plugins: plugin-market
---

插件市场目录源的公开契约补到外部作者可用：schema 的安装命令语法改由解析器自己的 npm/git 目标语法拼出（原先手工写的 `^dsh plugin .+ add \S+$` 既放行 `add !!!` 之类的空目标，又拒绝真实商店发布的一行），展示类字段接受真实源实际发布的 `null`（version/downloads 等），`$id` 换成可解析的真实 URL 并随包发布 `docs/`。字段漂移守卫由按函数名做文本匹配改为对 `src/` 全目录做 TypeScript AST 扫描，未实现关键字的校验改为对整份 schema 静态全量检查，文档表新增 Type/Required 两列与 schema 双向比对；随包新增真实源节选 fixture（schema 与解析器逐条对齐）。
Market plugin: the catalog-source contract is now usable by an outside author — the install-command grammar is derived from the parser's own npm/git target grammars instead of hand-written (the old `^dsh plugin .+ add \S+$` both admitted a targetless `add !!!` and refused a line the live store publishes), the display fields accept the `null` the real sources publish (version/downloads and friends), and `$id` is a resolvable URL with `docs/` shipped in the package. Field drift is now guarded by a TypeScript AST scan over the whole `src/` tree rather than text matching over a function list, unimplemented schema keywords are audited statically over the entire schema rather than only where an instance walks, and the doc tables gained Type/Required columns compared both ways with the schema; unedited excerpts of the live sources ship as fixtures so the schema is asserted against bytes this project did not author.
