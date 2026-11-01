---
shell: none
plugins: plugin-market
---

插件市场打开时先显示上次的目录、在后台更新，不再等 6 小时后的第一次加载转圈三五秒；刷新失败会在面板上说明原因而不是只说「正在更新」；技能包下载有了大小上限；某个源暂时挂掉时保留它原有的条目并在下次重试，不再整源消失 6 小时；模型侧安装需要构建的包被拦下后，面板的「允许构建并重试」也能用上。
The market shows the previous catalog immediately and refreshes behind it, so the first open after six hours no longer sits on a spinner; a failed refresh says why instead of claiming it is updating; skill downloads are size-capped; a source that is briefly down keeps its rows and is retried on the next open; and "allow the build and retry" now works for packages the model tried to install.
