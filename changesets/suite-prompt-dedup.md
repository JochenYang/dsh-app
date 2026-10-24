---
shell: none
plugins: plugin-swarm, plugin-memory, plugin-market
---

套件提示词去重：并行子代理把「什么时候用」留在会话段、「怎么用」全部交给工具描述，记忆卡的生命周期规则由工具描述与会话段共用同一份文本，市场安装的两条规则同理，代码图谱三个工具的说明与启动概览也各自收紧——实测每轮少约 1900 个字符的系统提示词。
Suite prompts deduplicated: the swarm section keeps only "when to use" and leaves "how" to the tool description, the memory card lifecycle rules are one shared string referenced by both the guidelines and the save tool, the marketplace's two install rules likewise, and the code graph's three tool descriptions and startup overview were each tightened — measured, about 1,900 fewer system-prompt characters per turn.
