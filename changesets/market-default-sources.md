---
shell: none
plugins: plugin-market
---

插件市场：默认目录源去掉 GitHub Pages 源（国内无代理时 5 MB 要 6-8 秒、公开代理拒绝该域名，缓存过期后打开市场就在等它），只留 npm 镜像包目录与社区源；单个目录源失败不再让列表静默缩水——失败源用自己上次的缓存行参与渲染，失败原因仍会提示，下一次打开仍会重试该源；卡片头像改直连 GitHub 头像域，不再绕行 github.com 跳转（无代理时该跳转连接超时 10-21 秒，是头像加载慢的原因），加载失败仍回退首字母色块。
Market plugin: the default catalog sources drop the GitHub Pages origin (5 MB in 6-8 s on a proxyless mainland link, refused by public proxies — an expired open waited on it), keeping the npm-mirror package catalog and the community store; a failed source no longer silently shrinks the list — it lends its cached rows to the panel while its failure is still reported, and the next open retries it; card avatars load straight from GitHub's avatar host instead of the github.com redirect (whose first hop timed out in 10-21 s without a proxy — the slow-avatar report), with the letter-block fallback unchanged.
