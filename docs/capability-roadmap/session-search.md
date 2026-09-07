# 会话全文检索（P2）

> 目标：让用户和 agent 都能"搜到过去"——按内容搜历史会话（不是只搜标题），
> 并与 plugin-memory 合流成"记忆 + 历史检索"双通道。

## 1. 背景与现状

- 内核 `ctx.sessionQuery`（`@deepseek-ai/dsh-session-query`）是统一的会话历史查询服务：
  列会话、读事件、血缘追踪、**全文搜索**（需挂 sqlite 后端）。已随 dsh 发布。
- sqlite 后端 `dsh-session-query-sqlite` 在 base bundle 已挂，但
  `openAt: never`（`packages/bundle/base/cordis.patch.yml:129`）——**默认关闭**，
  web bundle 注释明确写了开启路径：后续 patch 层把 `openAt` 覆写为 `first-search`
  （延迟到首次搜索才开 sqlite 句柄，保启动安静）。
- agent 侧工具 `tool-session-query`（搜/读历史会话）存在但未挂载。
- 用户侧 UI：无内容搜索界面（侧栏只有标题搜索行）。

## 2. 方案设计

### 2.1 三层开启

1. **overlay 一行**（`dsh-app.patch.yml`）：
   ```yaml
   - id: session-query-sqlite
     config:
       path: ':memory:'      # 或 $DSH_HOME 下的持久文件，见开放问题
       openAt: first-search
   ```
   （覆写 base 行 config；id 对齐 base 的行 id，last-write-wins。）
   > 2026-09-07 教训：不要再加 `tool-session-query` 的 insert 行——该包
   > （`@deepseek-ai/dsh-tool-session-query`）不在 CLI 运行时闭包内
   > （apps/cli 无此依赖），insert 会导致 loader `ERR_MODULE_NOT_FOUND`，
   > 进而整个 `cordis:include` 失败 = 整棵插件树加载失败 = Electron 白屏。
   > overlay 里插任何包名前，必须先确认它在 CLI 闭包里。
2. **agent 能力**（暂缓）：`tool-session-query` 包进入 CLI 闭包后，挂载该行，
   模型即获得"检索历史会话"工具——这是记忆之外的第二条持久知识通道
   （记忆=策展后的条目；检索=原始对话）。在此之前 archives `/search`
   返回 `agentToolAvailable: false`，页面如实提示但搜索不受影响。
3. **用户 UI**：plugin-archives 扩展为"会话历史中心"：现有归档列表之上加搜索框
   （host route 走 fence 包一层 `ctx.sessionQuery.search`），结果 = 会话卡
   （标题/项目/命中摘要/时间，点击跳转会话）。不新建插件（同域合流，少一个套件成员）。

### 2.2 性能与成本

- `first-search` 语义：进程启动零开销；首次搜索时才建内存索引（node:sqlite）。
- 索引范围 = 持久化 session log 全量；大会话库首次搜索可能秒级——UI 加
  "正在建索引"状态，后端 route 设时budget。

## 3. MVP / V2 / 验收

**MVP**：overlay 开启 + agent 工具挂载 + archives 内搜索框（关键词 → 会话卡列表）。
**V2**：结果内事件级命中展开（`readSession` 有界上下文读取）；按项目/时间过滤；
跨会话"接着上次做"一键引用（命中会话 → 新会话附引用上下文）。
**验收**：
1. 对历史会话中出现过、标题不含的内容关键词搜索，能返回对应会话；
2. 首次搜索前启动日志无 sqlite 句柄痕迹（first-search 生效）；
3. 空库 / 零命中 / 超长查询均有稳定 zh-CN 响应；
4. tool-session-query 在 standard preset 会话内可调用（待该包进入 CLI 闭包后验证；
   之前写"V1 探针确认 preset 层挂载方式"不准确——当时探针跑的是 dev pnpm 环境，
   包解析与 packaged CLI 闭包不一致）。

## 4. 开放问题

- Q1 索引持久化：`:memory:`（每次首搜重建，冷）vs 固定文件（持久，需清理策略）。
  先用 `:memory:`（与上游 web 默认一致），V2 再评估文件化。
- Q2 权限：全文搜索会暴露所有项目的会话内容给当前会话的 agent——沿用上游信任模型
  （单用户本地产品），但在工具描述中写明范围。
