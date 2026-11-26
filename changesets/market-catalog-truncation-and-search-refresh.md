---
shell: none
plugins: plugin-market
---

市场插件：目录条目上限从 5000 提高，超出每源或合并上限时不再静默丢弃——宿主日志、缓存与模型搜索都会说明目录不完整；缓存文件上限随之提高到 32 MB，满额缓存不再被当作损坏文件整体忽略；某个目录源读不到时，模型搜索把该源列为失败而不是答「没有」；`market_search` 遇到过期目录改为在后台刷新并落盘，最多等待 5 秒后先用旧快照作答，刷新失败时如实说明失败并记为失败而不是「正在刷新」。
Market plugin: the per-source entry cap no longer drops a directory's tail silently, and a merge that hits the total cap is reported the same way — the host log, the cache and `market_search` now say when the catalog is incomplete; the cache file cap rises to 32 MB so a full-size cache is no longer discarded as corruption; a catalog source that cannot be read is reported as a failure instead of as "no match"; and `market_search` refreshes an expired catalog in the background and persists it, answering from the old snapshot after at most 5 seconds — a refresh that fails says so and is reported as a failure rather than as "refreshing".
