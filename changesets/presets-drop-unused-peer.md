---
shell: none
plugins: plugin-presets
---

插件预设包：清掉一个从未使用的 peer 依赖声明（`@deepseek-ai/dsh-client-ui-primitives`，0314be5 引入时多写的一行——该插件的源码从未引用 Tooltip 组件），纯声明修正，无行为变化。
Plugin presets: drops a peer-dependency declaration that was never used (`@deepseek-ai/dsh-client-ui-primitives`, a stray line from 0314be5 — the plugin's source never references the Tooltip component); a manifest-only correction with no behaviour change.
