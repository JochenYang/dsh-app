---
shell: patch
plugins: plugin-memory
---

修复记忆卡里出现双花括号就整个模型无法使用：注入记忆内容的那段提示词此前会被当成变量模板解析，卡片里只要写了任何模板语法（例如微信小程序的 `bindXXX="{{KEY}}"`），每次组装提示词都会报错，新建与恢复会话都一样。该段现在明确声明不做变量替换，卡片原文按原样进入上下文。
Fix a memory card containing double braces making the model unusable: the section that injects saved memory was parsed as a variable template, so a card quoting any template syntax (a WeChat mini-program `bindXXX="{{KEY}}"`, for example) failed every prompt assembly — new session and resumed alike. That section now declares itself exempt from variable substitution, so card text reaches the context verbatim.
