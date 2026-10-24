---
shell: none
plugins: plugin-codegraph
---

索引中途失败不再让图谱永久低报影响面：失败的那一轮会清掉未完成文件的缓存记录，下次索引重新解析这些文件并把引用关系补回来。此前第一阶段已提交文件的时间戳，第二阶段失败后（例如退出应用或另一个进程占用数据库）下次索引会认为文件没变而跳过，那些文件的引用边就此永远缺失，而图谱状态仍显示「已是最新」。
A pass that fails partway no longer leaves the graph under-reporting impact forever: the failed round clears the cache record of the files it did not finish, so the next pass re-parses them and rebuilds their references. Phase one had already committed those files' timestamps, so a phase-two failure (quitting the app, another process holding the database) made the next pass treat them as unchanged and skip them — their reference edges stayed missing for good while the graph still reported "up to date".
