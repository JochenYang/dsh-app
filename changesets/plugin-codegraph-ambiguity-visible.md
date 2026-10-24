---
shell: none
plugins: plugin-codegraph
---

`codegraph_impact` 遇到同名声明时会列出各个候选，而不是含糊地说「没匹配到」。实测一个函数在生产代码和测试工具里各声明了一次，所有指向它的调用关系都被判为歧义丢弃，工具却返回「没有唯一匹配」——读起来就像「没人调用它」。现在会说明同名几处、给出可用的 id，并明确「歧义不等于没有调用方，请用文本搜索核对」。截断时也会给出总数，而不只是说「还有更多」：实测一个函数有 664 处引用，以前显示「40 条已截断」，现在显示「664 处引用，40 条已显示」。空结果会附带一句说明：通过接口、动态分发或变量转发的调用不产生引用关系，空列表不代表可以安全改动。
`codegraph_impact` now names the candidates when a name is declared more than once, instead of saying "no unambiguous symbol matched". Measured: one function is declared in both production code and a test harness, so every call edge to it was dropped as ambiguous while the tool answered "no unambiguous symbol matched" — which reads exactly like "nothing calls this". It now says how many declarations share the name, gives usable ids, and states plainly that ambiguity is not absence. Truncated answers also carry the total: a function with 664 references used to show "40 rows, truncated", and now shows "664 references, 40 shown". An empty result carries the note that a call through an interface, a dynamic dispatch or a variable leaves no edge, so an empty list is not permission to change something.
