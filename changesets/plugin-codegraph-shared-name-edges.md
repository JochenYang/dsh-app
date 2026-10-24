---
shell: none
plugins: plugin-codegraph
---

同名符号不再丢失调用关系。此前一个名字在多个文件里各声明一次时，所有指向它的调用都被判为「歧义」丢弃，`codegraph_impact` 返回空列表——读起来就是「没有人调用它」。实测一个函数在生产代码和测试工具里各声明一次，13 处真实调用一条边都没有建。现在少量同名（10 个以内）会连到每一个声明，用候选者列表让读者自己分辨；超过 10 个的（例如全项目 1325 个 `const result`）仍然不连，因为那种名字已经失去辨识度。重建后引用边挂在文件节点的比例从 53.2% 降到 36.5%，那个函数从 1 条入边变成 6 条真实调用。
Symbols that share a name no longer lose their call relationships. When one name was declared in several files, every call to it was dropped as "ambiguous" and `codegraph_impact` answered an empty list, which reads as "nothing calls this". Measured: one function declared in both production code and a test harness had thirteen real call sites and not a single edge. A name shared by up to ten declarations now links to every one of them, and the candidates list lets the reader tell them apart; names past ten (such as 1325 `const result` declarations in one project) still link to nothing, because a name that common carries no identity. After re-indexing, the share of reference edges hanging off file nodes dropped from 53.2% to 36.5%, and that function went from one inbound edge to six real call sites.
