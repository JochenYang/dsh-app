---
shell: none
plugins: plugin-codegraph
---

`codegraph_impact` 和 `codegraph_context` 的列表被截断时现在会明确说出来。实测一个真实符号有 664 处引用，此前只返回 40 条且没有任何提示，模型会以为看到了全部调用方然后漏改。现在被截断的答案末尾会写明还有更多，提示收紧问题再下结论。会话开头的项目概览也会带上「上一轮索引因文件上限被截断」这类警告，此前这个通道传的是空值，警告永远不出现。
`codegraph_impact` and `codegraph_context` now say when their lists were cut. Measured on a real symbol with 664 references: 40 rows came back with no signal at all, so the model believed it had seen every caller and edited the symbol anyway. A truncated answer now ends with an explicit warning and tells the caller to narrow the question before concluding. The project overview that opens each session also carries warnings such as "the last pass hit the file budget" — that channel was passed an empty value before, so the warning never appeared.
