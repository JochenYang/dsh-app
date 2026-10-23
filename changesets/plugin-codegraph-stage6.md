---
shell: none
plugins: plugin-codegraph
---

代码图谱第六阶段：文档里提到的符号现在会连成 `documents` 边，`codegraph_context` 能直接给出解释这段代码的文档行；调用边改为归属到所在函数而非整个文件，于是「谁调用了它」能答到具体符号；新增 Rust、Ruby、PHP、Shell 四种语言的提取规则。
Sixth stage of the code graph: a document that names a symbol now becomes a `documents` edge, so `codegraph_context` points at the paragraph explaining the code; a call edge is attributed to the function that makes it rather than to its whole file, so "who calls this" names the symbol; and extraction rules arrive for Rust, Ruby, PHP and Shell.
