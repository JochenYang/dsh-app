---
shell: none
plugins: plugin-todo
---

待办板：任务可以设截止日期、清单、优先级、子任务与重复规则，页面加了今天/逾期/即将/已完成/全部视图、清单侧栏与批量操作，卡片显示逾期数与今日数；模型侧新增 `todo_update`，`todo_add` 可写新字段，`todo_list` 可按清单与截止区间过滤。
Todo board: tasks now carry a deadline, list, priority, steps and a repeat rule; the page gains today/overdue/upcoming/done/all views, a list rail and batch actions, and the card shows today's and overdue counts. The model gets a `todo_update` tool, `todo_add` can write the new fields, and `todo_list` filters by list and deadline window.
