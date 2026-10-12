---
shell: none
plugins: plugin-client-ui
---

模型高级设置页重做：新增「高级参数」卡片，把此前全应用都没有入口的路由级字段（凭据变量名与解析状态、推理档与思考预算、重试策略、请求超时、默认上下文/输出上限/输入模态、缓存保留、流式传输、图片请求预算、自定义请求头）收进一张分组折叠的卡，字段级报错、只写改动的键、冲突自动带新版本重试并保留输入；原来三张各自保存的路由卡随之删除，覆盖模式补上「添加覆盖」入口（候选来自实时模型目录）；整页交互控件（按钮/输入框/复选框）与两个对话框改用内核 UI primitive。
Advanced Models is reworked: a new "Advanced parameters" card gathers the route-level fields that previously had no editing surface anywhere (the credential variable and whether it resolves, the reasoning effort and thinking budgets, retry policy, request timeouts, default context/output limits and input modalities, cache retention, streaming transport, image request budgets, custom headers) into one collapsible, grouped card — validated in place, writing only the keys the user changed, and keeping the draft across a conflict while retrying with a fresh revision. The three cards that each saved on their own are gone, the override mode gains an "add an override" entry fed by the live model catalog, and the page's controls (buttons, inputs, checkboxes) plus both dialogs now compose the kernel's UI primitives.
