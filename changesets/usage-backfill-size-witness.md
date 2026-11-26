---
shell: none
plugins: plugin-usage
---

用量统计插件：日志尺寸未变的会话不再每轮解压重读，定时扫描的 CPU 开销大幅下降；实时事件跨过未折算的历史时不再推进水位，缺口交给回填补齐，不再永久少计。
Usage plugin: session logs whose size did not change are no longer decompressed on every rescan, cutting the periodic scan's CPU cost; a live event that jumps past unfolded history no longer advances the watermark, so the backfill fills that gap instead of the usage being under-counted for good.
