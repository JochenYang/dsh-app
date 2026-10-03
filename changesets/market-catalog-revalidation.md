---
shell: none
plugins: plugin-market
---

插件市场：目录打开不再整包重下。主源（约 5 MB）此前每次缓存过期都无条件全量下载，是国内网络下「打开市场很慢」的主因——现在下载会携带上次响应的 ETag/Last-Modified 做协商，源未变化时 304 直接复用本地缓存（实测 5.17 MB / 8.1 秒 → 0 字节 / 0.33 秒），并在缓存过期后仍先渲染已有数据。请求恢复 gzip 压缩协商（传输约降 4 倍），针对「代理剥掉 content-encoding 头」的旧故障改为字节层 gzip 魔数探测解压，不再误报「目录源损坏」。
Plugin market: opening the catalog no longer re-downloads the whole thing. The primary source (~5 MB) was fetched unconditionally whenever the cache expired — the main cause of slow opens on mainland links. Downloads now carry the previous response's ETag/Last-Modified; an unchanged source answers 304 and the local cache is reused (measured 5.17 MB / 8.1 s → 0 bytes / 0.33 s), and an expired cache still renders its rows. gzip negotiation is back (roughly 4x less transfer), and the old "proxy strips content-encoding" failure is answered with a byte-level gzip magic probe instead of reporting the source as broken.
