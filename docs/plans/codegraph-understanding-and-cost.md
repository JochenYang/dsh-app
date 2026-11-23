# CodeGraph：少读文件也能读懂项目，少往上下文里塞东西

- Status: done
- Plan date: 2026-11-23
- Risk: medium

> 状态列是唯一进度源：Gate 通过前必须逐行更新该阶段条目；禁止用「本轮完成度」之类的汇总段代替状态列。本文件只写我们自己的做法与证据。

## Goal / Why

让 `plugin-codegraph` 在两件事上更有用：**模型不打开文件也能知道一段代码是什么、做什么、动了会碰到处**；**为此付出的上下文比它替掉的要少**。

成功标准（每条都有量法，见「Test plan」）：

- 推送的项目概览在一个会话里因自身文本变化而被重发的次数：p90 从 24 次降到 ≤3 次；由它造成的重读至少少七成。
- 文件大纲每行带**签名**（≤25 行时再带一行摘要），在 ≤1,200 token 的默认预算内回答「这个文件声明了什么、各自做什么」。
- 一条点名了文件或符号的请求，在模型做计划之前就拿到一份 ≤1,700 字符的起始包；短消息（<600 字符）基本不触发（≤2%）。
- `codegraph_impact` 多一组「引用它的测试文件」，并可展开到 3 层调用方。
- 采用率、答案大小、快照重发次数都进回放脚本与 `/status`，改任何一项之前先有基线。

动机——2026-11-23 在本机 234 个真实会话（13,046 步）与本仓库的真实图谱上量到的：

| 事实 | 数字 |
|---|---|
| 上下文的账几乎全是「重读」 | 工具结果共追加 7,377 万字符，被后续步骤重读合计 123 亿字符（×166）；≥20 步的会话里，每个追加的字符中位被重读 40 次、p90 161 次。`inputTokens`（未命中缓存的输入）1.42 亿，`cacheReadTokens` 32.2 亿，是前者的 22 倍 |
| 工具结果里最大的是读文件与跑脚本 | `read` 3,992 次、2,080 万字符（单次 p50 2,795、p90 12,700、最大 113,580）；`run_code` 8,727 次、1,990 万字符；`grep` 1,942 次、398 万字符 |
| 代码图谱几乎没被调用 | 35 个会话（15%）的运行时上下文里有项目概览；其中 5 个会话调用过 `codegraph_*`，一共 6 次（find 1、impact 1、context 4） |
| 概览自身在反复变化 | 35 个会话重发了 354 次运行时上下文快照（p50 3 次、p90 28 次、最多 47 次），**280 次是概览文本自己变了**；按各会话的放大倍数折算，重读 1.60 亿 + 0.43 亿字符（约 5,100 万 token），占有概览会话缓存读的 2.4% |
| 变化的原因很琐碎 | 274 个版本差里：标题行的计数 229 次（`~440 edges` → `~450`）、枢纽行的引用数 138 次（`~34` → `~35`、`9` → `~10`）、入口行 82 次（行号平移、新文件出现）、索引状态切换 32 次 |
| 大纲只有名字 | `codegraph_context` 的大纲行是 `function name:line — N call site(s)`；本仓库抽样 400 个 TS 声明，41% 上方紧邻一段注释（p50 152 字符），这些都没进图谱 |
| 同名声明极多 | 本仓库 28,918 个声明里 20,470 个（71%）与别的声明同名（`dir`×317、`store`×237）；`variable` 占 80% |

一句话结论：图谱的结构是对的、答案的「诚实规则」也齐（截断必说、歧义必说），但 (1) 它唯一主动送进上下文的东西在跟着每次编辑抖动，(2) 它给的多是「位置」而不是「内容」，(3) 模型基本不主动来问。所以本轮做三件事：把已经送出去的东西变稳，把位置升级成带签名与摘要的内容，在模型开口之前把点名的文件与符号送到它面前。

## Scope

- Must-have：阶段 1–4（度量与稳态、签名与摘要、请求预取、影响面）。
- Out of scope：内核改动（快照的追加与淘汰规则）；其它插件；语义／向量检索；语言服务器精化；索引性能（原生解析、逐文件抽取缓存、文件监听）；对外 API 的破坏性变更（工具名与参数只增不改，返回值只增字段）。

## Ruled out

| 方案 | 为什么排除 |
|---|---|
| 语义／向量检索 | 依赖重（嵌入模型下载与镜像），且本插件的检索不按分数排序；先用结构答案把采用率做起来 |
| 中英词表（「报表」→`report`）做任务检索 | 实测：52% 的用户消息含表中词，但只有 8% 映射到**唯一**声明的标识符，且命中的是「状态／任务／数据」这类通用词——语义太弱，只会带进噪声 |
| 把三个工具合成一个带 `operation` 的工具 | 三个工具的描述合计 2,858 字符（约 715 token／请求），占有概览会话缓存读的 0.2%；省下的不如改接口的风险大 |
| 大而全的仓库地图（数千符号按重要度排） | 同类实现里 3,847 个符号的地图约 2.4 万 token，是我们整段概览的 50 倍；沿用「有界概览 + 按需下钻」 |
| 用 steer 消息做预取 | 会在聊天列表里多出一条消息；我们用运行时上下文座位（折叠显示，文本不变不重发） |
| 语言服务器精化（定义／引用／悬停） | 精度收益真实，但要起子进程、依赖用户机器上已装的服务器；另立计划 |
| 原生解析插件、逐文件抽取缓存、文件监听 | 改的是索引耗时不是模型读到的 token；首轮 17.9 s／1,771 文件、二轮 93 ms 可接受 |
| 结果内代码行去重、HTML 元素 id 索引 | 场景窄 |

## 现状与证据（2026-11-23 实测）

**A. 采用与体量**（`scratch/codegraph-plan/usage.mjs`、`explore.mjs`）

| 项 | 值 |
|---|---|
| 带概览的会话 | 35 / 234；调用过 `codegraph_*` 的 5 个，共 6 次 |
| `codegraph_*` 答案大小 | find 507 字符（1 次）；impact 817（1 次）；context p50 3,422、最大 5,142（4 次） |
| 模型怎么探索 | 61 个会话在 `run_code` 里调工具（子调用）；最常见的开头是连续 `run_code`（53 个会话），其次是 read／glob／grep 串 |
| 读文件 | 原生 1,462 次（43% 带行范围）＋代码内 2,530 次；同一会话重复读同一路径占 25%，一个路径最多读 9 次 |
| 概览对开场的影响（仅供参考，项目与时期不同） | 前 3 步的文件类调用：有概览 p50 3／p90 4，无概览 p50 4／p90 6 |

**B. 快照账单**（`usage3.mjs`、`churn.mjs`）

| 项 | 值 |
|---|---|
| 概览大小 | p50 1,942 字符；整份快照 p50 2,792 |
| 重发次数 | 354 次，其中带概览的 338 次：概览自身变化 280 次、只随别的贡献重发 58 次（其余 16 次的快照里没有概览） |
| 折算重读 | 1.60 亿 + 0.43 亿字符（概览在其中占 0.25 亿） |
| 别的贡献的变化 | `app:web-surface` 39 次、`dsh-app:task-context:current` 22 次、`harness:source` 11 次 |

**C. 本仓库图谱**（`graph-shape.mjs`，只读打开 `graph.db`）

| 项 | 值 |
|---|---|
| 规模 | 963 文件、28,918 符号、158,636 边（references 74,246、documents 45,929、contains 28,918、type_refs 4,864、exports 3,077、imports 1,598） |
| 符号种类 | variable 23,030、function 3,714、interface 980、method 727、type 344、class 85 |
| 同名 | 2,352 个名字共 20,470 处声明 |
| 签名与注释 | 400 个 TS 声明：声明头部 p50 409 字符（未归一化，含多行）；41% 有紧邻注释，p50 152、p90 520 字符 |
| 顶层 `variable` 的真身 | 抽样 500 个：函数值 19（4%）、工厂调用 12、其余 469 是真常量 |

**D. 预取标定**（`prefetch-calibrate.mjs`、`prefetch-zh.mjs`）

| 项 | 值 |
|---|---|
| 样本 | 项目现有图谱的 150 个会话，452 条用户消息 |
| 含代码形 token | 114 条（25%），每条 p50 7 个 |
| 严格闸：命中图中文件或**唯一**声明的标识符 | 40 条（9%）；**长消息（≥600 字符）78 条里 35 条（45%）**，短消息 374 条里 5 条（1%） |
| 标识符的命中午 | 490 个标识符形 token：唯一 76、多处声明 13、无声明 401；344 个路径形 token：命中 153、未命中 191 |
| 包大小 | p50 1,120 字符、最大 1,720（上限 3 个文件、3 个符号） |

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| M1 | P0 | 用量回放脚本 `plugins/plugin-codegraph/scripts/usage-replay.mjs`：对真实会话日志输出采用率、答案大小、每会话快照重发次数与「哪一行变了」、读文件体量。只输出计数与大小。日志解码库的复用方式按门禁结果定：优先把 `plugins/plugin-memory/scripts/lib/session-log.mjs` 上移到仓库 `scripts/lib/`，两个插件共用一份；门禁不允许跨目录引用时保留副本，两处头注释互指。**实施**：解码库已上移到 `scripts/lib/session-log.mjs`（记忆插件的两个脚本与一个测试改为引用它），门禁无异议；另入库 `prefetch-replay.mjs`（见 R3） | [x] |
| M2 | P1 | 运行期计数进 `/status`（每个项目一行，键齐全）：`overviewChanges`（本进程内概览文本被采用的 changes 次数）、`find`／`impact`／`context` 调用数、`prefetchAttached`／`prefetchSkipped`、`grepNotes`。只进 JSON，不做界面 | [x] |
| S1 | P0 | 概览稳态：①计数改 1–2–5 量级桶（1、2、5、10、20、50…；3–7 记 `~5`），标题行与语言分布都在内；②枢纽先按引用边数落到量级桶，再按「桶降序、id 升序」取前 K，集合只在跨桶时变；③入口行在同一类目内按路径排序，去掉符号计数；④同一会话内概览文本变化后 5 分钟内不再切换（到点后的下一次装配再换）。见 D1 | [x] |
| S2 | P1 | 重索引期间不翻转：`indexing` 状态下返回**该会话上次展示的文本**（会话从未展示过才用项目最近一次完整块；都没有才返回状态句——首次建索引的窗口）；工具答案里的 `freshness` 照常报告。失败句始终原样透出。**实施时的修正**：原写法「按项目记住最近一次完整块」会让推迟期内的会话先看到新文本、下一步又被收回，每次重索引翻转一次 | [x] |
| S3 | P2 | 概览加一行顶层目录分布（最多 5 个，按量级桶降序、同桶按名字；`projectLayout` 给精确计数，分桶与排序只在渲染侧） | [x] |
| U1 | P0 | 图谱存签名与摘要（`SCHEMA_VERSION` 4 → 5）：`symbols.signature`（归一化的声明头部，≤200 字符）与 `symbols.doc`（紧邻上方的注释块首句，≤160 字符）。抽取对声明节点的文本通用：取到第一个体开始符（`{`、`=>`，Python 取 `:`）或 3 行为止；注释按语言的行前缀识别。各语法族各一条真实语法用例。**实施**：上限 200 字符由常量约束而非行数；注释要穿过 `export` / `lexical` 包裹层找上一个兄弟节点（否则本仓库 72% 的注释会丢），Python 另取 docstring；并带上 `edges.narrowed`（引用是否被同文件声明或 import 子句收窄）。实测符号集与边集与升级前逐项相同（478 个 TS 文件）。**审查后的修正**：签名剥块注释与行注释（`//` 仅在行首或空白/分隔符之后，URL 默认值不受影响）、控制字符替换为 `?`、200 上限含省略号——签名会以 user 角色进入附注与预取包，注释里的文字不能冒充内核说的话 | [x] |
| U2 | P1 | 大纲与检索行带签名：文件大纲按规模分级（≤25 行签名＋摘要，≤60 行只签名，更多只名字）；`codegraph_find` 在 ≤10 条结果时每行附签名；`codegraph_context(symbol)` 的同文件列表带签名。**实施**：`names` 行不带 `[exported]`（顺序已是导出在前）；find 行保留 `path:line`（跨文件时位置是唯一线索）；本仓库 58 个 `src/main` 文件实测：≤25 个声明全落 full，26–60 档一半落到 names（签名行含 id 与位置约 150 字符，46 行即超预算），>60 全 names 且无一超 1,200 token | [x] |
| U3 | P1 | 按答案的 token 预算：列表部分默认 ≤4,800 字符（约 1,200 token），超了自动降一级细度并在首行说明；首行带 `~N/1200 tokens`。`codegraph_context` 增可选参数 `detail: auto｜names｜signatures｜full`。源码切片沿用 `budget.ts` 的表，不并入。**实施**：预算只量列表行（首行、note、imports、尾句不计）；显式 `detail` 是梯子的起点，只降不升；`names` 仍超则保留最长前缀、至少 1 行，`file.detail`/`file.cut` 进 JSON，裁行计入 `truncated`；首行写 `· detail: <level> · ~N/1200 tokens[ · K row(s) cut to fit the budget…]`；大纲查询上限 40 → 200 | [x] |
| U4 | P2 | 同一文件的路径只写一次：同文件列表（siblings、calledBy 的同文件行）把路径提出来写一遍。**未做**：闸门「视实测大小」——实测每个文件的大纲都在预算内，路径重复是 26–60 档掉到 names 的次因（主因是签名行里的 id 与位置），留待下一轮按计数决定 | [ ] |
| U5 | P2 | `codegraph_context(symbol)` 的 `calls` 行在唯一解析时附目标签名（≤15 行时）。**实施**：唯一解析按（行，被调名）计而非按行——`return target(x) + dup()` 一行两个调用各自无歧义 | [x] |
| R1 | P1 | 请求预取：监听 `agent/inbox/claimed`（只取 `kind:'user'`），从消息里抽代码形 token（带代码扩展名的路径；camelCase／PascalCase／snake_case 标识符，每条最多 14 个）；路径按 `files` 精确或唯一后缀匹配，标识符按**唯一**声明解析；至少解析出一个才附。包 ≤1,700 字符，经 `systemPrompt.context`（名 `dsh-app:codegraph:request`，order 61）附加；图表未就绪（`indexing`／`stale`）不附；开关 `DSH_APP_CODEGRAPH_PREFETCH=0`。见 D2。**实施**：token 补入 SCREAMING_SNAKE_CASE 常量名（标定正则漏了 `MAX_RETRIES` 这一类；与回放脚本同步修改并重跑：严格闸 40 → 41/452）；路径形 token 只当文件、绝对路径与 `../` 不解析、零声明的文件不占槽位；只有 `user` 且非纯空白的消息才替换请求（接线用例抓到过纯空白消息把请求清空的缺陷，已修）；计数按请求计一次而非按装配计。回放脚本与模块有两处口径差（脚本对绝对路径取相对名再试、文档命中计入 `pathHit`），标定因此略宽于发货的闸。**审查后的修正**：①token 正则的驼峰分支原为 `[a-zA-Z0-9]*`，与下一组首字母重叠，`aAAAA…_` 在 26 个字母时 580 ms、40 个时小时级——改 `[a-z0-9]*`（token 集合不变），两处副本同改，加 2 s 超时用例；②已发出的包在重索引窗口里保持上次文本（而不是返回空再恢复），免得一次编辑轮次白翻两次快照；③概览 context 补 `interpolate: false`（路径里的 `{{name}}` 会让整段 prompt 抛错，本轮加目录名扩大了触发面）；④包里的符号行不再带 id（名字按构造唯一，框定句写一次 `codegraph_impact("<name>")`） | [x] |
| R2 | P1 | 包的内容：每个命中文件（≤3 个）给至多 8 行迷你大纲（导出与被引用最多的在前，带签名）；每个命中符号（≤3 个）给位置、签名、调用点数。首句框定为背景资料、非指令。**实施**：预算紧时行 8 → 5 → 3 级降，再丢项（从末尾丢，最后一个符号先于任何文件） | [x] |
| R3 | P1 | 预取标定脚本入库 `scripts/prefetch-replay.mjs`（只输出计数）：阈值与 token 规则改动后重跑比较。**实施**：脚本随 M1 入库；R1 改规则后重跑：452 条消息，带 token 114（25%），严格闸 41（9%；长消息 45%、短消息 2%），包 p50 1,120、p90 1,720 字符 | [x] |
| I1 | P1 | `codegraph_impact` 增一组「引用它的测试文件」（从引用行里按测试文件形状筛出去重后的文件，≤15 个，附一句「先跑这些」）；引用行带置信标记：`✓` 是被 import 子句收窄过的，`~` 是只按名匹配的（`edges` 增 `narrowed` 列，随 v5）。**实施**：未收窄的行不带标记（不是 `~`），图例只在出现过 `✓` 时打印；`narrowed` 为 0 时 JSON 不带键；测试形状为 `*.test.*`/`*.spec.*`/`*.e2e.*`、`tests/`/`__tests__/` 目录、cs/java/kt/swift 的 `*Tests`/`*Test` 后缀；`relatedTo`（extends/implements/type_refs）的行未带标记——规格只要求 `referencesTo` | [x] |
| I2 | P2 | `codegraph_impact` 增 `depth`（默认 1，最大 3）：调用方逐层展开成缩进树，节点上限 60、每层每符号 ≤12 行，按符号 id 去重、环处写 `(see above)`，每层各报截断。**实施**：截断数写在它发生的那个节点上（`300 caller(s), 12 shown`），60 节点触顶写进标题（`TRUNCATED at 60`）；不传 `depth` 时 JSON 无 `callers` 键、文本无树。**审查后的修正**：`seen` 不再预置被问的符号——预置让自递归函数把自己标成 `(see above)` 而上方空无一物；现在它作为普通调用方出现一次，它的调用方（根）才是 `(see above)` 叶子 | [x] |
| A1 | P2 | 检索附注（实验）：模型直接发起的 `grep`（`parent` 为空，即不是 `run_code` 里的子调用）、模式是裸标识符且在图中唯一声明时，经 `additionalContexts` 附一句位置与调用点数及下一步；每个标识符每会话最多一次；图表非 `current` 不附；开关 `DSH_APP_CODEGRAPH_GREP_NOTE=0`。见 D3。**实施**：附注里的下一步写名字不写 id（`resolveSymbol` 对唯一名字的判定与附注同一条规则；id 会把路径再付一遍，本仓库 48 字符的路径会从「签名＋指针」掉到「只剩计数」）；先有附注再记「已告知」；只认 `grep`（`glob` 的 pattern 是路径）；接线需要 `createUserMessage`，插件新增 peer 依赖 `@deepseek-ai/dsh-llm`（与 hooks/memory/rewind/swarm 一致）。真机两轮里模型都把检索放进 `run_code`（即便明说不要用）：选了 PTC 执行器后模型直接调用原生工具会被判 `UNKNOWN_TOOL`，所有检索都是子调用，而子调用同样走 `prepare → dispatch → post-execute` 管线、其 `additionalContexts` 被 PTC 执行器转挂到外层结果。按原范围附注在这类配置下永不触发，所以**偏离 D3 的「模型直接发起」：附注覆盖子调用，每次外层调用最多 5 条（按外层执行的 `parent` token 计，两个外层调用并行时互不干扰），被上限跳过的名字不消耗「每会话一次」**；真机复验：`run_code` 里检索 `sumLedgerDay` → 附注随外层结果到达，`grepNotes=1` | [x] |
| P1 | P2 | 压缩产物按形状跳过：文件头（前 4 KB）平均行长 ≥500 字符判为生成文件（手写源码实测约 70），文档豁免（散文一段一行）；与现有的后缀、横幅规则并列，计入 `generated`。**实施**：规则是形状不是裁决，手写的长行文件（长 SQL、内嵌 base64）也会被命中；安全审查指出工具答案对此沉默会让「无此符号」看似定论——加 `ProjectMeta.generatedSkipped`，`freshnessNote` 对每个工具答案报告跳过数（老库缺该字段时读为 0：这个读发生在重建之前、读的是旧 blob，严格了会在升级时丢掉项目身份） | [x] |
| P2 | P2 | 旧计划 `plugin-codegraph.md` 的状态列收口（W12 仍标 `[~]`、阶段 3 的闸门仍标 `[ ]`，实现早已落地）。**实施**：另发现它引用的真机探针 `scripts/probe-codegraph.cjs` 已不在仓库——测试表第 8 行（路由围栏 401）如实记为测试缺口，进了 Deferred | [x] |

## Phases

| 阶段 | 包含条目 | Gate |
|------|----------|------|
| 1 度量与稳态 | M1, M2, S1, S2, S3 | 条目全 `[x]`；T1–T8 PASS；真机：连续 5 次编辑引起的概览版本数 ≤2、重发次数 ≤2；回放脚本给出基线表 |
| 2 读得懂 | U1, U2, U3, U5（U4 视实测大小） | 条目全 `[x]`；T9–T15 PASS；本仓库重建一次图谱并量出大纲大小；真机一轮 |
| 3 预取 | R1, R2, R3 | 条目全 `[x]`；T16–T19 PASS；回放：严格闸命中率与包大小同 D 节；真机：点名两个文件的消息 → 快照里出现包 |
| 4 影响面 | I1, I2 | 条目全 `[x]`；T20–T23 PASS；两路独立审查无阻塞 |
| 5 采用实验与精度 | A1, P1, P2 | A1 以对照数据决定去留（见 D3）；T24–T25 PASS |

阶段闸门：任何条目处于 `[~]`、`[?]` 或 `[!]` 时不得开始下一阶段。每个阶段一个提交，带插件版本 bump 与 changeset 片段（0.2.9 之后进位到 0.3.0，其后 0.3.1、0.3.2……）。条目转 `[x]` 前回答五问（主张复核、最小性、新风险、反例、可检查性）。Risk 为 medium；阶段 2（改 schema）与阶段 3（每条请求都可能附加上下文）各做一次两路 subagent 独立审查，记录存 `.devflow/codegraph-understanding-and-cost/review-<阶段>.md`。

## 需要主人裁决的点

| # | 问题 | 建议 |
|---|---|---|
| D1 | 概览的入口行要不要保留 `:行号` | **去掉**。保留它，入口文件上方每插一行就重发一次整份快照（实测一个 627 步的会话里出现 `starts at class SshError:35` 随编辑消失又出现）；`codegraph_context("<path>")` 一次调用就给出全部行号 |
| D2 | 请求预取默认开还是关 | **默认开**。严格闸只在点名了图中文件或唯一标识符时触发，长请求 45%、短消息 1%；每次 ≤1,700 字符，留环境变量开关 |
| D3 | 检索附注（A1）要不要做 | **先做成实验**：它在模型自己的 `grep` 结果后面加一句，等于改另一个工具的输出；只在图表 `current`、标识符唯一、每会话一次的前提下做，用对照数据决定是否保留 |
| D4 | schema 升级（v5）带来一次性全量重建 | **接受**。本仓库 963 文件，首轮在 20 s 量级；图谱是派生数据，旧版本打开时照样整库重建，回滚无残留 |
| D5 | 阶段顺序 | **按 1 → 2 → 3 → 4 → 5**。阶段 1 是纯收益且为后面提供基线；阶段 2 是阶段 3 的数据前提（包里的签名来自图谱）。阶段 3 的闸门上看一次采用率：`codegraph_impact` 的调用仍接近 0，就先做阶段 5 的检索附注（A1），再做阶段 4 |

## Affected behaviors

| 行为 | 类型 | 位置 |
|---|---|---|
| 运行时上下文里项目概览的文本与重发频率 | modified | `plugins/plugin-codegraph/src/prompt.ts`（`magnitude`、`renderOverviewContext`）、`src/query.ts`（`projectOverview` 的枢纽与入口排序）、`src/index.ts`（概览 provider） |
| 图谱 schema（签名、摘要、引用的收窄标记） | modified | `src/store.ts`（`SCHEMA_VERSION`、`symbols`、`edges`）、`src/parse.ts`（抽取）、`src/indexer.ts` |
| 文件大纲、检索行、同文件列表的内容与细度 | modified | `src/query.ts`（`fileOutline`、`findSymbols`、`symbolsInFile`）、`src/tool-text.ts`、`src/index.ts`（`codegraph_context` 增 `detail`） |
| 答案的预算与首行摘要 | added | `src/tool-text.ts`、`src/budget.ts` |
| 每条请求可能附带的起始包 | added | `src/index.ts`（`agent/inbox/claimed` 监听、第二个 `systemPrompt.context`）、新模块 `src/prefetch.ts` |
| `codegraph_impact` 的测试分组、置信标记与 `depth` | modified | `src/query.ts`（`referencesTo`、`relatedTo`）、`src/tool-text.ts`、`src/index.ts` |
| 模型直接发起的 `grep` 之后可能多一条附注 | added | `src/index.ts`（`tools/post-execute`）、新模块 `src/grep-note.ts` |
| 哪些文件被判为生成文件 | modified | `src/ignore.ts` |
| `/status` 的计数 | modified | `src/routes.ts`、`src/types.ts`（如需界面再动 `src/client/*`） |

## Test plan

| # | 用例 | 输入／操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (M1) | 回放脚本 | 对本机真实会话日志运行 | 只输出计数与大小；退出码 0；与「现状与证据」A、B 两节同一口径 | `node plugins/plugin-codegraph/scripts/usage-replay.mjs` | PASS（234 会话，退出码 0；`tests/replay-scripts.test.ts` 钉住字段与退出码） |
| 2 (M2) | 计数进 `/status` | 发生一次概览变化、一次工具调用、一次预取 | 对应计数各 +1；不发生时为 0 | `tests/routes.test.ts` | PASS |
| 3 (S1) | 计数在桶内变化不重发 | 文件 430 → 431、边 27,000 → 27,400、符号 7,700 → 7,750 | 概览文本逐字节相同 | `tests/prompt.test.ts` | PASS |
| 4 (S1) | 枢纽的重排不重发 | 两个枢纽引用数互换但同桶；第 K+1 个跨桶进入 | 前者文本相同；后者文本变化且只在末行 | `tests/prompt.test.ts` | PASS |
| 5 (S1) | 入口行对编辑稳定 | 入口文件上方插入一行；新增一个顶层文件 | 前者文本相同；后者新增一行、其余不动 | `tests/prompt.test.ts` | PASS |
| 6 (S1) | 最短更新间隔 | 同一会话 1 分钟内概览该变两次 | 第二次变化在 5 分钟内的装配里不出现；到点后的下一次装配出现 | 手驱动时钟的单测 | PASS（`tests/overview-state.test.ts`；接线侧 `tests/overview-wiring.test.ts` 按 `indexedAt` 等待复验） |
| 7 (S2) | 重索引不翻转 | 已有完整块 → 状态转 `indexing` → 转回 `current` | 三次返回同一文本；首次建索引仍返回状态句 | `tests/prompt.test.ts` | PASS（规则本身在 `tests/overview-state.test.ts`） |
| 8 (S1) | 真机 | 隔离 home 的开发版窗口里连续 5 次编辑 | 会话日志里概览版本数 ≤2、快照重发 ≤2 次 | 真机 CDP，一次性脚本在 `scratch/` | PASS（`scratch/codegraph-plan/live-check.mjs` 24/24：编辑后只采纳一次，`overviewChanges=1`） |
| 9 (U1) | 签名归一化 | TS 函数、箭头函数常量、类方法、接口、Python def、Go func | 签名不含体、单行、≤200 字符；多行参数表被折叠 | `tests/parse.test.ts`（每个语法族一条，跑真实语法） | PASS（含剥注释、URL、控制字符、上限含省略号） |
| 10 (U1) | 摘要抽取 | 上方有 JSDoc、`//`、`///`、`#` 注释；注释与声明之间隔空行；没有注释 | 前四者取首句（≤160）；隔空行与无注释不取 | `tests/parse.test.ts` | PASS |
| 11 (U1) | schema 升级 | 用 v4 的图谱打开 | 整库重建，`meta.project` 保留 | `tests/store.test.ts` | PASS（含缺 `generatedSkipped` 的旧 blob） |
| 12 (U2) | 大纲分级 | 20 行、45 行、80 行的文件 | 20 行带签名与摘要；45 行只签名；80 行只名字并说明降级 | `tests/tool-text.test.ts`、`tests/query.test.ts` | PASS（`tests/budget.test.ts`、`tests/answers.test.ts`） |
| 13 (U2) | 检索行 | 8 条与 12 条结果 | 8 条每行带签名；12 条不带 | `tests/tool-text.test.ts` | PASS（10/11 分界） |
| 14 (U3) | 预算 | 列表超过 4,800 字符 | 自动降一级并说明；`detail: full` 时不降但首行报 `~N/1200` | `tests/tool-text.test.ts` | PASS（显式 `detail` 是起点、只降不升） |
| 15 (U2) | 实测大小 | 本仓库重建后的 10 个最大文件 | 大纲默认 ≤1,200 token；对照：直接读这些文件的平均字符数 | 一次性探针在 `scratch/` | PASS（892 文件：>60 声明的 14 个全 names，最大 1,200；`window.ts` 1,200 对文件 56k 字符） |
| 16 (R1) | 闸 | 四类消息：点名图中文件；点名唯一标识符；只含多处声明的名字；不含代码形 token | 前两类附包；后两类不附 | `tests/prefetch.test.ts` | PASS |
| 17 (R1) | 包的上限与内容 | 一条消息点名 6 个文件与 8 个标识符 | 只取前 3 个文件、前 3 个符号；总长 ≤1,700 字符；首句为背景资料框定 | `tests/prefetch.test.ts` | PASS |
| 18 (R1) | 状态与开关 | 图表 `indexing`；`DSH_APP_CODEGRAPH_PREFETCH=0` | 都不附；已发出的包在重索引窗口里保持原文；这两种情形不计数（`prefetchSkipped` 只记「请求评估过但解析不出」） | `tests/prefetch.test.ts` | PASS（接线在 `tests/wiring.test.ts`：未建图不附也不建图、开关关不附、`prefetchSkipped`、保持旧包的用例） |
| 19 (R1) | 回放与真机 | 452 条真实消息；一条点名两个文件的消息 | 回放：严格闸 9%（长消息 45%）、包 p50 ≈1,100 字符；真机：请求之后出现带 `dsh-app:codegraph:request` 的快照 | `node plugins/plugin-codegraph/scripts/prefetch-replay.mjs`；真机 CDP | PASS（41/452，p50 1,120；真机 690 字符的包在首次模型请求前到达，同名请求不重发） |
| 20 (I1) | 测试分组 | 被两个测试文件与三个源文件引用的符号 | 多一组两个测试文件；引用行数不变 | `tests/query.test.ts`、`tests/tool-text.test.ts` | PASS |
| 21 (I1) | 置信标记 | 一条被 import 收窄的引用、一条只按名匹配的 | 前者 `✓`，后者 `~` | `tests/parse.test.ts`、`tests/tool-text.test.ts` | PASS（未收窄的行不带标记而非 `~`，图例只在出现 ✓ 时打印） |
| 22 (I2) | 多层调用方 | 三层深的调用链；带环的图；枢纽有 300 个调用方 | 缩进树到第 3 层；环处 `(see above)`；后两者在节点上限处截断并逐层说明 | `tests/query.test.ts` | PASS（含被问符号自身的自递归与 A→B→A） |
| 23 (I2) | 默认不变 | 不传 `depth` | 答案与现在逐字节相同 | `tests/tool-output.test.ts` | PASS（`tests/tool-text.test.ts` 钉住 5 组基线字面量；默认 `impact` 多一组测试文件） |
| 24 (A1) | 附注的条件 | 模型直接发起的 `grep`（唯一标识符）；`run_code` 里的子调用；多处声明的名字；图表 `stale`；同一标识符第二次 | 只有第一种附注，且只附一次 | `tests/grep-note.test.ts` | PASS，**预期已改**：子调用也附（每次外层调用 ≤5 条），见 A1 实施说明；其余不附、同一会话只附一次 |
| 25 (P1) | 按形状判生成 | 平均行长 600 的文件；单行 12,000 字符的文件；手写文件 | 前两者计入 `generated`；后者照常索引 | `tests/ignore.test.ts` | PASS（另加：跳过数进 `freshnessNote`） |

## Verification commands

```sh
cd plugins/plugin-codegraph && npx tsc --noEmit && npm test && npm run build
# 仓库根
node scripts/plugin-gates.mjs plugins/plugin-codegraph
npm run typecheck
npm test                      # 先清掉 PATH 里含 pnpm 的段
npm run check:graph && npm run check:suites:gate && npm run check:slots && npm run check:touchpoints:gate
# 回放（只输出计数）
node plugins/plugin-codegraph/scripts/usage-replay.mjs
node plugins/plugin-codegraph/scripts/prefetch-replay.mjs
```

真机点查用隔离的 `DSH_HOME` 起开发版窗口（`DSH_APP_DEV=1 DSH_HOME=<隔离 home> npm start -- --remote-debugging-port=9222`），经 CDP 读会话日志：快照重发次数、概览版本数、预取包是否出现。需要模型作答的轮次用有额度的供应商。

## Deferred

| 项 | 为什么本轮不做 | 何时该回来 |
|---|---|---|
| 语言服务器精化（定义、引用、悬停、类型层级） | 要管理子进程与各语言服务器的安装差异；本轮先把结构答案的采用率做起来 | 阶段 5 的对照数据显示 `impact` 的漏报是主要痛点时 |
| A → B 调用路径查询 | `depth` 树已能看出主干；专门的最短路径是另一个问题 | 出现「从 A 怎么走到 B」反复被问的实例 |
| 箭头函数常量按 function 记 | 本仓库只占顶层变量的 4%，收益小；改 kind 会改 id | 碰到以箭头函数风格为主的项目 |
| 快照的追加与淘汰 | 内核行为：一份快照只在整份文本变化时重发，旧快照不淘汰。稳定化之后这是剩余浪费的主要来源 | 内核提供按贡献去重或淘汰旧快照的座位 |
| `app:web-surface`、`dsh-app:task-context:current` 的变化 | 这两个贡献的变化也会带着概览重发（58 次） | 本轮稳定化之后若仍是重发主因，转给对应插件 |
| 把概览挪进系统提示段 | 段变了会让整段历史的缓存前缀失效；在缓存命中便宜、历史很长的会话里，留在快照里更划算 | 缓存价格结构或内核的快照机制改变时 |
| 预取的更宽闸门（多处声明的名字、中文任务词） | 多处声明的名字有歧义；中文词表实测语义弱 | 预取运行两周后按计数再看 |
| 路由围栏（401）的自动化用例 | 旧计划引用的 `scripts/probe-codegraph.cjs` 已不在仓库（2026-11-23 核对），围栏由 Connection carrier 施加、本插件无用例 | 下次动路由或在真机点查里补一条「无 cookie → 401」 |
| `projectLayout` 改为 SQL 分组 | 每次装配把全部路径拉进 JS 分组，O(文件数)，963 文件约 1 ms，与同一路径上的 `projectOverview` 同量级 | 装配路径成为可见的延迟时 |
| `ignore.ts` 里「已索引文件跳过形状判定」分支的用例 | 分支的理由在注释里（`projectChanged` 不得每次工具调用都打开所有源文件），删掉它没有红灯 | 下次动 `scanProject` 时补一条 |
| `relatedTo` 行的置信标记 | 规格只要求 `referencesTo`；extends/implements/type_refs 行没有 ✓ | 模型对这类行的可信度提出疑问时 |
| `names` 级别行的 `[exported]` 标记 | 顺序已是导出在前，标记每行 +11 字符 | 大纲裁到 56 行时读者分不清导出边界 |
| 附注在子调用上的实际触达率 | 真机一轮只有一次检索；两周后看 `grepNotes` 与会话数 | 两周后 |
| 开发窗口的日志写进了共享的 `%APPDATA%/DSH APP/logs/` | 隔离的是 `DSH_HOME`，不是 appData；只影响日志文件，不影响 profile | 下次给 dev 启动加 `--user-data-dir` 或等价开关 |

## Rollback

- 每个阶段一个提交，回滚即 `git revert` 该提交；阶段之间只有一条数据依赖（预取的签名来自 v5 图谱），回滚阶段 2 必须连同阶段 3。
- 图谱是派生数据：旧版本打开 v5 的库会整库重建，无残留。
- 预取与检索附注各有环境变量开关；关掉即回到此前的行为，不需要回滚代码。

## Phase log

全部五个阶段在 2026-11-23 一天内并行施工并合入（三条轨 × 两波，各在独立工作树里做，主会话接线），所以按阶段记证据，不按日期分开。

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 度量与稳态 | 2026-11-23 | 插件 805 条（787 通过 / 18 跳过 / 0 失败，`npm test` 退出码 0）；`tests/prompt.test.ts`、`overview-state.test.ts`、`overview-wiring.test.ts`、`routes.test.ts`、`replay-scripts.test.ts`；回放脚本对 234 个真实会话输出基线表（T1）；真机：会话内编辑后概览只在第一次真实变化时采纳一次（`overviewChanges=1`），间隔内第二次保持 | 完成。T1–T8 PASS |
| 2 读得懂 | 2026-11-23 | Track G 在 478 个 TS 文件上证明符号集与边集与升级前逐项相同；Track U 在本仓库 892 个文件上量出大纲：≤25 声明全落 full（p50 333 token）、26–60 一半 signatures 一半 names（p50 1,115）、>60 全 names 且无一超 1,200；`tests/answers.test.ts` 用注册后的真实 schema 校验输出；真机：包里的签名来自 v5 列 | 完成。T9–T15 PASS；两路独立审查无阻塞（记录见 `.devflow/codegraph-understanding-and-cost/review-2-5.md`） |
| 3 预取 | 2026-11-23 | `tests/prefetch.test.ts` 32 条、`tests/wiring.test.ts` 预取 4 条；回放：452 条消息，带 token 114（25%），严格闸 41（9%；长 45%、短 2%），包 p50 1,120；真机 24/24：点名文件的请求在模型首次请求前拿到 690 字符的包，同名请求的下一轮不重发，`prefetchAttached` 计数 | 完成。T16–T19 PASS |
| 4 影响面 | 2026-11-23 | `tests/query.test.ts`（`testFilesReferencing`、`callerTree` 三层/环/上限）、`tests/tool-text.test.ts`（✓ 图例、测试分组、树的缩进与截断）、`tests/tool-output.test.ts`（新字段过了 schema、未声明字段被拒）；真机：默认 `impact` 多一条 UNION 查询，无回归 | 完成。T20–T23 PASS |
| 5 采用实验与精度 | 2026-11-23 | `tests/grep-note.test.ts` 15 条、`tests/wiring.test.ts` 附注 5 条（子调用、上限 5、下一次外层调用重置、开关、非 current 不附）；`tests/ignore.test.ts`（形状规则与 `scanProject`）；真机：模型在 `run_code` 里检索唯一标识符 → 附注随外层结果到达，`grepNotes=1` | 完成。A1 作为带计数的实验合入；去留由 `grepNotes` 两周后的计数决定（D3） |

五问（每个 `[x]` 的条目都过一遍，这里只记有内容的）：

- **主张复核**：概览重发 p50 24 → ≤3 的主张在真机上只能证明「一次编辑轮次里最多采纳一次」；全量 p50 要等真实会话积累后用 `usage-replay.mjs` 重跑。预取包命中率 9% 是回放口径，发货闸略严（见 R1）。
- **最小性**：U4（路径只写一次）未做——实测每个大纲都在预算内，它只是 26–60 档掉级的次因。`relatedTo` 的行未带 ✓（规格只要求 `referencesTo`）。
- **新风险**：附注与预取包都是 user 角色消息，项目文本由此进入 higher-trust 位置——签名剥注释与控制字符、标识符按构造是裸名、kind 来自固定表；token 正则的指数回溯由安全审查发现、已修并加超时用例。附注覆盖子调用是对 D3 范围的偏离，上限 5 条。
- **反例**：手写的长行文件会被形状规则命中——工具答案现在报告跳过数，不再沉默。
- **可检查性**：接线用例（`wiring.test.ts`、`overview-wiring.test.ts`）用真实队列与真实图谱驱动 `apply`，门控条件逐条有用例；真机脚本 24 条断言全部 PASS。
