---
shell: none
plugins: plugin-codegraph
---

`codegraph_impact` 的截断样本不再偏斜。此前按符号路径字典序取前 40 条，实测一个符号有 664 处引用分布在 105 个文件里，返回的 40 条却全部来自同一个文件——那样的「样本」等于在说「调用者都在这里」，而这是假的。现在改成每个文件先取一条轮转，40 条覆盖 40 个不同文件。同时同名符号优先解析到本文件内的声明：实测一个函数在生产代码和测试工具里各声明一次，所有调用边都被判为歧义丢弃，而本文件内的声明本来就没有歧义。
`codegraph_impact` no longer returns a lopsided sample when a list is cut. It used to take the first 40 rows in path order: measured, a symbol with 664 references across 105 files answered 40 rows that all came from ONE file — a "sample" that claims the callers live there, which is false. Rows are now drawn one per file in turn, so 40 rows cover 40 different files. A shared name also resolves to the declaration in the SAME file first: measured, a function declared in both production code and a test harness had every call edge dropped as ambiguous, even though the local declaration was never ambiguous at all.
