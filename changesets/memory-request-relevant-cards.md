---
shell: none
plugins: plugin-memory
---
记忆插件：当请求与某张未注入正文的卡片共享足够多的专有名词时，该卡正文会作为运行时上下文附在本轮（系统提示前缀不动，最多两张）；本机若装有 ZCode 且它为同一目录存有记忆索引，该索引以只读块带入提示（目录不存在则什么都不发生）；设置页的注入量面板显示这两项。
Memory plugin: when a request shares enough specific terms with a stored card whose body is not in the prompt, that body is attached to the step as runtime context (the cached prompt prefix stays untouched; two cards at most); when ZCode is installed and keeps a memory index for the same workspace, that index rides the prompt as a read-only block (nothing happens without it); the settings page's injection panel shows both.
