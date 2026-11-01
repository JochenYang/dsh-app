---
shell: none
plugins: plugin-memory, plugin-ppt, plugin-pdf, plugin-presets
---

往记忆卡里粘贴密钥会被拒绝保存，不再把明文密钥写进每次会话都会注入的文件；导出文档或配置到已存在的文件前会先要求确认，`pdf_edit` 也不再允许把结果写回源文件；PPT 与 PDF 的内置技能不再覆盖用户从市场装的同名技能。
Secrets pasted into a memory card are refused instead of being written to a file that is re-injected into every session; exporting a document or a backup onto an existing file asks first, and pdf_edit no longer accepts its own source as the output; the built-in PPT and PDF skills no longer overwrite a same-named skill the user installed from the market.
