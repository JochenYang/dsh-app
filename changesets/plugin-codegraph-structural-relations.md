---
shell: none
plugins: plugin-codegraph
---

代码图谱新增三类结构关系：继承（extends）、实现（implements）与类型引用（type reference）。此前 `codegraph_impact` 查一个接口只能找到「提到它名字的地方」，找不到「谁实现了它」——因为实现接口不是调用，不产生引用边；而改一个类型的字段会破坏所有在签名里用到它的函数，这些函数也从没调用过它。实测在 pi 项目上新增 142 条继承边、182 条实现边、25561 条类型引用边，索引耗时从 25.6 秒变为 26.6 秒。查询一个接口时，现在能看到 6 处签名依赖（`nodeLoader`、`HostOptions` 等），它们从不调用它但改它会坏。
The code graph now records three structural relationships it was blind to: inheritance (`extends`), implementation (`implements`) and type references. Previously `codegraph_impact` on an interface found only the places that NAMED it, never the classes that implement it, because implementing is not calling and leaves no reference edge; and changing a type's field breaks every function whose signature uses it, none of which ever called it. Measured on the pi project: 142 inheritance edges, 182 implementation edges and 25,561 type-reference edges added, with the index pass going from 25.6s to 26.6s. Looking up one interface now shows six signature dependencies (`nodeLoader`, `HostOptions`, and others) that never call it but break if it changes.
