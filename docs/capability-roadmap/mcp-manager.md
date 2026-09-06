# MCP 服务器管理（P0）

> 目标：把"配置一个 MCP 服务器要手写 patch YAML"变成设置页里的表单操作。
> 内核侧能力（`@deepseek-ai/dsh-mcp-client`）已随 dsh 运行时发布，本需求是纯套件层工作。

## 1. 背景

MCP（Model Context Protocol）是给 agent 接入外部工具服务器的事实标准：文件系统、GitHub、
数据库、浏览器控制、记忆服务器等。内核已有完整桥接（工具以 `mcp__<serverName>__<tool>`
原生注册、自动重连、命名冲突保护），但上游定位是"部署者写 overlay 行"，没有终端用户 UI：

- 配置入口 = 手编 `cordis.patch.yml` 行（`packages/mcp/mcp-client/README.md` 的示例即最终形态）；
- 改一个 server 要改 overlay → 重启 → 出错排查看日志；
- 坊间痛点（用户原话）：*"当前确实没有直观页面来配置转换，配置 MCP 特别麻烦"*。

同类产品（Claude Desktop / Cursor / Claude Code 的 `.mcp.json`）都把 MCP 配置做成
一等公民 UI/文件，这是 DSH APP 的明显缺口。

## 2. 内核契约（已验证，L1）

来源：`deepseek-harness/packages/mcp/mcp-client/README.md`（0.1.2-rc.1）。

**一个 server = 一个插件行**，多个 server 挂多行同名插件、各自 config：

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-web
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: web
    transport: streamable-http
    url: http://localhost:3000/mcp
    headers:
      Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `serverName` | 必填 | 工具命名空间，`[A-Za-z0-9_-]{1,32}`，同注册域内唯一 |
| `command`/`args`/`env`/`cwd` | — | stdio：可执行文件、参数、附加 env（并经 scrub 的环境）、工作目录 |
| `url`/`headers` | — | streamable-http：端点与额外请求头 |
| `toolCallTimeoutMs` | 60000 | 单次 `tools/call` 超时 |
| `failOnStartupError` | false | true 时初始连接失败会让 harness 拒绝启动（**我们固定 false**） |
| `reconnect.{enabled,initialDelayMs,maxDelayMs,maxAttempts}` | true/500/30000/10 | 断线重连预算 |

关键行为：

- 工具名 `mcp__<serverName>__<rawName>`，与 Claude Code / Codex 同形；重启与会话历史里的
  权限规则因此保持稳定。
- 初始连接失败：harness 照常启动，该 server 工具不出现，错误进日志（`failOnStartupError:false`）。
- 冲突保护：同名 serverName 后者加载报错；server 内重复工具名整体拒载（不会出现半套工具）。
- **仅桥接 tools**，resources/prompts 不支持。
- 成本提示（写进 UI 文案）：每个 server 的工具定义会占每请求上下文；挂太多 server 推高 token。

## 3. 产品设计

### 3.0 JSON 编辑与批量导入（2026-09-06 增补，用户反馈）

在 §3.1 表单之上补齐两条 JSON 通道（对标 VS Code MCP 编辑器的 表单/JSON 切换）：

- **编辑弹层 表单/JSON 双模式**：右上角切换。JSON 视图显示/接受该条目的标准
  mcpServers 片段 `{"server-name": {...}}`，直接粘贴 Claude / Cursor / VS Code
  形状（`type: "stdio"|"http"`、`command`/`args`/`env`/`cwd`/`url`/`headers`/
  `toolCallTimeoutMs`）；包装形式 `{"mcpServers": {...}}` 仅在只含一个服务器时
  接受（编辑模式对应一个服务器）。表单 ⇄ JSON 双向转换，JSON 失败时留在 JSON
  视图并报错。掩码规则与表单一致（明文值显示 ••••••，回传保真）。
- **列表页「导入 JSON」**：批量粘贴 `{"mcpServers": {...}}` 或裸映射；逐条导入
  （`POST /server/import`），单条失败不影响其余，返回 `{imported, failed}` 报告
  并逐条挂载。
- **映射规则**（`src/wire.ts`，browser 可复用的纯模块）：`type: sse` 明确拒绝
  （内核桥只支持 stdio 与 Streamable HTTP）；type 缺省时按 url/command 推断；
  未知字段忽略（向前兼容）；服务器名即键名，须满足 serverName 模式。

### 3.1 设置页 section（order 12，"MCP 服务器"）

列表视图（每 server 一张卡）：

- 名称（serverName）、传输类型徽标（stdio / HTTP）、启用开关；
- 状态行：工具数、最近一次连接结果（成功 / 失败原因摘要 / 已停用）；
- 展开区：完整配置字段 + 该 server 提供的工具清单（名称 + 一句话描述）；
- 操作：编辑 / 测试连接 / 删除。

添加/编辑表单：

- transport 单选切换字段组（stdio: command/args/env/cwd；http: url/headers）；
- `serverName` 实时校验 `[A-Za-z0-9_-]{1,32}` + 与现存不重名；
- env 键值对编辑器；headers 键值对编辑器（http）；
- 高级折叠区：toolCallTimeoutMs、reconnect 参数（给默认值，少暴露）。

交互状态（不可省）：保存中 / 测试中 / 连接失败的失败原因展示 / 删除二次确认 /
空状态引导（"MCP 是什么 + 添加第一个服务器"）。

### 3.2 与 `$DSH_HOME/cordis.patch.yml` 手写行的关系（共存 / 迁移）

上游定位 MCP 配置 = 部署者在 patch 层手写行，因此老用户（含我们自己的开发机）
可能在 `$DSH_HOME/cordis.patch.yml` 里已有 `@deepseek-ai/dsh-mcp-client` 行。
两种来源的关系：

| | cordis.patch.yml 手写行 | servers.json（本插件） |
|---|---|---|
| 本质 | 内核启动时的静态 loader 装配 | 插件的动态挂载（`ctx.loader.create`） |
| 生效时机 | 改后需重启（或依赖 HMR） | 保存即时挂载/卸载 |
| 可见性 | 无 UI，失败只进内核日志 | 状态徽标 + 实时工具数 + 失败原因 |
| 出错影响 | YAML 写错影响整个用户层 | 单条失败单条显示，boot 不受影响 |

- **并存可用**：两边是不同的 loader entry，互不感知；工具都以 `mcp__<serverName>__*`
  注册。唯一冲突：**同 serverName 两边都配 → 后挂载者失败**（上游按注册域拒绝重名；
  本插件的实例挂载在后，失败会显示在 UI 状态里）。
- **建议收敛到 servers.json 单一来源**：迁移路径 = 把手写行抄成 mcpServers JSON
  （或用「导入 JSON」粘贴），确认挂载成功后删除 cordis.patch.yml 里的对应行。
  例：`- id: mcp-exa / name: '@deepseek-ai/dsh-mcp-client' / config: {serverName:
  exa, transport: streamable-http, url: ..., toolCallTimeoutMs: 120000}` 等价于
  `{"exa": {"type": "http", "url": "...", "toolCallTimeoutMs": 120000}}`。
- 不做 patch 文件的自动解析导入：用户层 YAML 支持 `!!js` 表达式与锚点，安全解析
  需要整套 loader 语义；JSON 粘贴导入已覆盖迁移成本。

### 3.3 数据流

```
设置页 (client) ──POST/PUT/DELETE──> /plugins/@dsh-app/plugin-mcp/api/servers (host, fenced)
                                        │ 校验（serverName 合法性、传输字段完整性、去重）
                                        ▼
                              $DSH_HOME/storages/dsh-app-plugin-mcp/servers.json
                                        │ 变更后
                                        ▼
                          动态挂载/卸载对应 mcp-client 实例（见 §4.2）
```

## 4. 架构方案

### 4.1 新增双面插件 `@dsh-app/plugin-mcp`

- host（`src/index.ts`）：读 `servers.json` → 为每个 enabled server 动态挂载
  mcp-client；注册 fenced API routes（CRUD + test + status）；零全局副作用。
- client（`src/client.ts`）：`settings.section` order 12；表单 + 列表；轮询或推送状态。
- 接线：`brand-suite.ts` 的 `SUITE_PLUGIN_DIRS` 加入 `plugin-mcp`；
  `dsh-app.patch.yml` 增加 overlay 行；`build-runtime.mjs` 无需改（suite 由目录枚举）。
- **overlay 里不写任何 server 行**（用户配置不留在 overlay），只写插件本体行：
  `- id: mcp-manager \n  name: '@dsh-app/plugin-mcp'`。

### 4.2 动态挂载（本需求唯一的技术不确定点 → 先验证）

主方案：host 插件内用 cordis loader 动态创建/销毁实例：

```ts
const dispose = await ctx.loader.create({
  name: '@deepseek-ai/dsh-mcp-client',
  config: { serverName, transport, command, args, env, ... },
})
// 卸载/禁用时调用 dispose 或 loader 对应销毁 API
```

依据：`apps/cli/src/profile-boot.ts:283-285` 已在 host 上下文用
`ctx.loader.create({ name, config })` 挂载插件（HMR fallback 路径），该模式存在。

**验证步骤 V1**（写代码前，半天）：临时 probe 插件在 dev 模式对 `ctx.loader.create`
挂一个本地 stdio echo MCP server，确认 (a) 实例工具出现在下一轮 prompt；
(b) dispose 后工具消失；(c) 连接失败不影响 boot。

备选方案（V1 失败时）：插件把 `servers.json` 变更写好后，由 shell 在**下次 server
启动**时把 enabled server 合并进 `dsh-app.patch.yml` 的 insert 行
（`brand-suite.ts` 本来就每次启动重写 overlay）。代价：增删改 server 需重启 server
（托盘已有"重启服务"入口，UI 提示即可）。此方案零新机制，MVP 亦可先走这条路。

### 4.3 状态与工具清单

- 连接状态：mcp-client 失败只写日志。插件需从 ctx 读各实例结果——具体读取面
  （loader 实例查询 / tools 注册表按 `mcp__<server>__` 前缀统计）在 V1 一并确认；
  最坏情况 MVP 只展示"已启用/已停用"，错误文案引导看日志（诊断中心 P 后续承接）。

## 5. 安全（严谨项）

1. **stdio server = 在用户机器上执行任意命令**。UI 在添加 stdio server 时必须明示
   （"将以此命令在本机启动进程"），并展示完整 command+args。这与用户手写配置等价，
   不做沙箱（上游 sandbox 体系另有定位），但要显式告知。
2. **凭据**：env/headers 里可能出现 token。约定：
   - 值支持 `$ENV:VAR_NAME` 引用语法（保存时解析为环境变量引用，文件里只存引用名）；
   - 文件明文值允许（与 Claude Code `.mcp.json` 同级风险，用户本地文件），但
     **routes 返回给 client 时脱敏**（值替换为 `••••`，编辑时原样回填仅当用户主动重输）；
   - 日志红线复用 server.ts 的 redact 规则；任何 route 不得回显完整 token。
3. **routes 全部过 Host fence**（loopback + Host 头校验），写操作仅限本机 UI。
4. `serverName` 白名单校验（正则即上游契约），防止工具名注入空间。

## 6. MVP / V2

**MVP（建议 1 个迭代）**：
- servers.json 存储 + 全量 CRUD routes + 表单校验；
- 挂载：V1 通过 → 动态挂载；V1 失败 → overlay 合并 + 重启生效；
- 列表/添加/编辑/删除/启用停用 + 失败原因（日志摘要）；
- `$ENV:` 引用语法 + 回显脱敏。

**V2（后续迭代）**：
- 工具清单预览与工具数统计；测试连接按钮；
- 从 Claude Code / Cursor 配置**一键导入**（读 `~/.claude.json` 的 mcpServers 键
  或 `.mcp.json`——迁移路径，降低切换成本）；
- 常用 server 目录（官方 filesystem/github/fetch 等预设模板，一键填充）。

## 7. 验收标准（行为化）

1. 添加一个 stdio server（如 filesystem），不重启，下一轮对话模型工具列表出现
   `mcp__<name>__*` 工具并调用成功；删除后工具消失。
2. `serverName` 重复 / 含非法字符 / transport 字段缺失：保存被拒且给出 zh-CN 原因。
3. 启动时 server 不可达：harness 正常启动，其它功能不受影响；UI 显示该 server 失败。
4. 保存的 env 值在 GET 响应与日志中均不回显明文。
5. 内核回滚到无 mcp-client 的旧版：仅本插件功能缺失，boot 不受影响。
6. `npm run typecheck` + 插件 tsc 通过；新增 routes 过 fence 探针。

## 8. 工作量与风险

> **实现状态（2026-09-06）**：已按本方案实现（`plugins/plugin-mcp/`，overlay 行 +
> SUITE_PLUGIN_DIRS 接线），未提交。§4.2 的 V1 验证已由 `scripts/smoke-suite.mjs`
> 自动化覆盖（真实内核上 create → 挂载出 `mcp__smokeecho__*` 工具 → disable → delete
> 全链路 200/状态断言）；掩码往返与校验拒绝路径有单测（`plugins/plugin-mcp/tests/`，
> 23 例）。用户实测入口：设置 → MCP 服务器。

- 工作量：host 插件 + routes + 存储 ~2 天；client 表单/列表 ~2-3 天；V1 验证 0.5 天；
  联调 1 天。合计约一个迭代的核心位。
- 风险：
  - R1 loader 动态挂载不可用于插件上下文 → 备选方案兜底（§4.2），不影响交付形态；
  - R2 mcp-client 无状态查询面 → MVP 状态展示降级（§4.3）；
  - R3 上游 API 变化（rc 线常态）→ 套件冒烟探针（dev-process-tooling.md）先行落地，
    V1 验证顺带覆盖。
