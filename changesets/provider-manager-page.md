---
shell: none
plugins: plugin-client-ui
---

供应商管理（原「模型高级设置」）：照搬 dsh-provider-studio 的面板——供应商列表 → 卡片式供应商页（模型列表、底部高级配置、一个保存），并补上管理器缺的部分：从 218 个 models.dev 模板（或自定义端点）新建供应商、填写/清除 API Key、删除供应商；每个模型行可直接测连通性（绿色延迟 / 红色失败，由插件新增的 host 探针路由发出真实最小请求，密钥不出主机、拒绝跨源重定向、20 秒超时）；供应商行显示随包的 184 个品牌 logo。
Provider manager (formerly "Advanced models"): ports dsh-provider-studio's panel — a provider list, then a card per provider (model list, advanced band, one save) — and fills in what a manager needs: create a provider from 218 models.dev templates (or a hand-typed endpoint), set or clear its API Key, delete it; each model row can run a connectivity test (green latency / red failure) through the plugin's new host probe route, which sends the real minimal request without the key leaving the host, refuses cross-origin redirects and times out at 20 s; rows show the 184 bundled brand logos.
