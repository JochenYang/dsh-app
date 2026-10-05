# 内核线升级的开发回归

> 本文是**流程**文档：跟随的内核线变动时，从静态扫描到真机回归的完整动作、判据与记录规则。
> 单次升线的调研结论与执行台账写在 `docs/kernel-<版本>-*.md`，本文不重复那些数字。
>
> **证据标记**：`[实测]` = 命令真跑过、有可复现输出；`[静态]` = 源码或配置阅读；`[待验证]` = 推断，未经执行。
> 任何条目标记为未验证时，不得据此下"已适配"的结论。

## 0 三条前提 `[静态]`

1. **只跟一条内核线。** 根 `package.json` 的 `@deepseek-ai/dsh*` 规格是唯一真源
   （`scripts/kernel-line.mjs`），16 个插件的 peer/dev 随它一起动。因此本项目**不采用**
   跨宿主世代的运行时兜底链（旧名字 → 新变体）：那会让"名字没了"这类断裂永远不报，
   把唯一真源变成两个。兼容性靠同步升级，不靠运行时分支。
2. **编译绿不等于运行绿。** 类型门看不见三类断裂：内核停止导出的具名导出（编译期是
   `undefined` 形状）、loader 组合层的行 id 漂移、以及客户端注册面在渲染时才抛。
   本项目的多数真实故障属于后两类。
3. **回归的目的不是重复编译器的工作**，而是覆盖编译器看不见的面。每加一条门禁，先问它
   能看见什么别的门禁看不见的东西；答不上来的断言不加。

---

## 1 升线前：七类接触面扫描

升线前先做一遍**只读**扫描，得到一张"这次变动可能打到我们哪里"的表。扫描不证明兼容，
它的价值是保证该问的角度都问过，而不是每次靠人重新想一遍从哪些角度问。

| # | 接触面 | 我们仓库里的对应面 | 扫描特征 |
|---:|---|---|---|
| 1 | 组合层补丁行 | `plugins/dsh-app.patch.yml`（唯一的 overlay） | `patch\.yml`、`patchedDependencies` |
| 2 | 会话事件与持久事件 | 插件 host 半的事件监听、会话投影 | `SessionEvent`、`session/event`、`ctx\.on\(`、`subscribe\(` |
| 3 | 服务探测与 Remote | `inject` 列表、`ctx.get(...)`、`ctx.remote.*` | `inject`、`ctx\.get\(`、`ctx\.remote`、`@Remote` |
| 4 | 宿主目录直读写 | profile 镜像、办公载荷、日志目录 | `DSH_HOME`、`\.dsh[/\\]`、`profiles[/\\]`、`homedir\(` |
| 5 | 客户端注册面与工具注册 | 各插件 `src/client/*`、`ctx.tools.register` | `ctx\.slots\.`、`__ModuleLoader__`、`ctx\.tools\.register` |
| 6 | 自定义 HTTP / DOM / CSS 通道 | `ctx.connection.fetch.register` 路由、注入样式 | `connection\.fetch\.register`、`createServer\(`、`MutationObserver`、`data-plugin-css` |
| 7 | 子进程与输出解析 | 插件里 spawn 的外部命令、runtime 构建 | `node:child_process`、`spawn\(`、`execFile`、`execFileSync` |

**执行方式** `[实测]`：跑 `npm run check:touchpoints`。模式表在 `scripts/touchpoint-patterns.json`，
扫描器在 `scripts/check-touchpoints.mjs`，输出按类列出命中位置，分三类优先级排序：
`plugins/` 与 `src/`（升线真正会打到的地方）在前，`scripts/` 与 `test/` 在后。当前扫 738 个
文件，七类全部有命中。

命令的两种形态：

```sh
npm run check:touchpoints         # 报告，永远 exit 0
npm run check:touchpoints:gate    # 额外断言：每一类都还有命中
```

`--check` 断言的**不是**“没命中就是好”，而是“模式表没跟代码脱节”：某一类命中为 0 时
报错，因为那说明模式失效了，而不是那个面没被用到。这是扫描器能对自己证明的**唯一**一件事，
其余判断仍然留给人 `[实测]`（清空任一类的模式即 exit 1）。

**边界**：扫描是启发式的。零命中只说明“当前特征没扫到”，不说明解耦良好；依赖与配置要另外
核对，构建、真实挂载与功能冒烟仍然必做。扫描排除 `node_modules`、`dist`、`lib`、`.test-dist`
与生成产物，也不扫 Markdown——散文里提到一个接触面不等于代码里有这个接触面。

两个已修正的假阳性源 `[实测]`，改模式表时别退回去：
- **锁文件与模式表自身不入报告。** 插件本地的 `package-lock.json` 是 gitignore 的安装残留；
  模式表会**匹配到自己**（它的条目就是要找的正则本身），不排除就会把扫描器当代码报出来。
- **YAML 的整行注释同样要剥离。** `scripts/lib/strip-comments.mjs` 只懂 JS 的 `//` 与 `/* */`；
  overlay 主要是解释行的散文，不额外处理 YAML 时实测 38 处 yml 命中里有 10 处是注释。

---

## 2 机器可查的断言

### 2.1 具名导出是否还在（已有）

`test/plugin-kernel-imports.test.mjs` 检查套件在运行期从 `@deepseek-ai/*` 导入的每个具名
导出，在**已安装的这条线**里是否真的导出。它解析仓库自己的 `node_modules`，不需要内核树、
不需要网络，属于快 CI 门。

它防的是：`import { IconX } from '…/primitives'` 类型检查通过，运行时是 `undefined`，
客户端整块渲染成 `Element type is invalid`。这是本项目**已经发生过**的故障形态。

### 2.2 注册面（已有）

**往未声明的 slot 注册会抛；往已退役的 slot 注册是静默无操作**——不报错、不渲染、没有日志。
两者都不在编译期，但**可以从已安装的这条线静态判定**：内核把座位声明在 `SlotMap` 接口里，
声明随包一起发布。

```sh
npm run check:slots
```

`scripts/check-slot-registrations.mjs` 把两边的声明取并集后逐个判定我们客户端半的每一次
`ctx.slots.inject` / `ctx.slots.register`。当前 14 次注册全部解析成功 `[实测]`。

三个设计点 `[实测]`，改这个检查器时不要丢：

- **声明必须在 `interface SlotMap { … }` 块**内才算声明。同一个 id 也会出现在
  `children: { … }` 表和若干 `ctx.slots.*(…)` 调用里；只查“文件提没提 SlotMap”会让检查
  变成不可证伪——实测删掉声明后它仍然报通过。块内匹配要数括号，不能用懒惰正则（懒惰的
  会在第一个条目的 `}` 就停）。
- **我们自己的插件声明的座位也算。** `plugin-client-ui` 在自己的 `declare module` 里声明
  `settings.dsh-app-maintenance.tab`，`plugin-presets` 注册进去；只读已安装包会把这两处
  误报为未声明。
### 2.2.1 一个真实的判定边界：声明是跨 tree 的并集

检查器把**根作用域与每个插件本地 `node_modules`** 里的 `SlotMap` 取并集。后果有两个方向，
两个都实测过 `[实测]`：

- **偏宽的一面**：插件本地可能留着另一个包的旧副本。只把根那份改掉，座位仍然被解析
  （`plugin-archives/node_modules/@deepseek-ai/dsh-client-ui-settings` 里还有一份），检查器
  会报通过——这不是假阴性，而是“那个副本还能提供服务”的**正确**结论。
- **真正退役时会报**：把**每一份**副本里的座位都改名后，检查器 exit 1 并逐处指名：
  `[slots] settings.section is registered at plugins/plugin-archives/src/client.ts:123 but no
  SlotMap … declares it`；把名字改回去即 exit 0。

因此一个座位“消失”的判据是**所有副本都不再声明它**，而不是根里没有。写回归记录时
要按这个口径写。

#### 2.2.2 “未安装”与“已退役”不能是同一个答案 `[实测]`

座位的**声明包可能只装在插件自己的 `node_modules` 里**。实测：`sidebar.footer.action`
由 `@deepseek-ai/dsh-client-ui-sidebar` 声明，而该包只存在于 `plugins/plugin-market`
本地，根作用域没有。

后果：在一棵“根依赖已装、插件本地未装”的树（正是 CI `gate` 作业在跑单测那一刻的状态）
上，声明根本不在磁盘上，检查器把该座位报成**未声明**——而那个树上什么都没坏。

所以注册方所在插件没有本地 `node_modules` 时，该注册进 **`unjudged`** 列表：检查器
既不判它通过也不判它断裂，并在人类可读输出里逐条列出、附上补齐命令。两者混为一谈会
把假阳性变成习惯，习惯之后真退役就没人看了。

这也是它必须放在 **CI 的 per-plugin 安装之后**的原因（`ci.yml` 的 `gate` 作业里紧跟
`Plugin unit tests`）——放前面就只能报一堆 `unjudged`，什么也没验。

客户端注册 id 必须等于包名，否则插件静默掉出启动图。本项目的注册 id 由
`plugins/build-lib.mjs` 的 `clientBanner(id)` 从包名注入 `__ModuleLoader__.load({ id, … })`，
结构上写不错，因此这一条不需要独立门禁——但改 `build-lib.mjs` 时它是回归面。

`plugins/plugin-sidebar/src/client/views.tsx` 用的是 `ctx.slots.inject(name, () => ctx.slots.register(...))`
惯用法，这是当前线要求的写法，改动时不要退回裸 `register`。

### 2.3 新增面是否该用（已有）

2.1 只查“我导入的名字还在吗”，看不见另一半：**这条线新增了什么是我们本该用的**。

```sh
npm run check:surface              # 全部包
npm run check:surface -- --used-only   # 只看我们耦合的包
```

`scripts/kernel-surface.mjs` 报告已安装线的导出面，并把我们与它的耦合分成**三类**——这个
区分不是修饰，是结论：

| 边 | 写法 | 升线时意味着什么 |
|---|---|---|
| RUNTIME | `import { x } from 'pkg'` | 真正的运行期依赖；名字没了就是 2.1 防的那种断裂 |
| TYPE | `import type { T } from 'pkg'` | 构建时抹除；名字没了要等到下一次类型检查 |
| AUGMENT | `import type {} from 'pkg'` | Cordis 的 `declare module` 增强惯用法；**不建立运行期边**，但包消失了增强会静默丢失 |

当前实测 `[实测]`：63 个包、861 个导出名、11 个 RUNTIME / 7 个 TYPE / 11 个 AUGMENT 耦合。

**这不是工作清单。** 未使用的导出绝大多数是**正确未使用**：内核自己的组合、以及我们不发的
部署形态（headless、SDK、SSH、各类 provider）。报告把“我们耦合的包”与“没耦合的包”分开，
判断留给人——这正是它是报告而不是门禁的原因。

两个已修正的缺陷 `[实测]`，改这个报告时别退回去：

- **只枚举根作用域会漏包。** `@deepseek-ai/dsh-client-ui-primitives`（14 个插件）与
  `@deepseek-ai/dsh-web` 只存在于**插件本地** `node_modules`，根枚举根本列不出它们。
- **`import type {}` 必须判为 AUGMENT，不是 TYPE。** 它同时满足“带 type 关键字”与“不命名
  任何成员”，先测 type 会把实测 101 处全归进 TYPE 并报出 0 个增强耦合。

---

## 3 自动门禁

**全部裸跑，不走管道**：`… | tail && git commit` 会按管道的退出码提交。

```sh
npm run typecheck
npm run build
npm test
npm run check:graph
npm run verify -- --tgz runtime-dist/dsh-runtime-<platform>-<arch>-<版本>.tgz
npm run check:plugins -- --kernel <新 runtime.tgz> --home <真实 DSH_HOME>
```

每一条**证明什么、看不见什么** `[静态]`（判定口径来自各门禁的实际断言，见 `scripts/` 与 `test/`）：

| 门禁 | 证明 | 看不见 |
|---|---|---|
| `typecheck` | 形状与签名在编译期自洽 | 运行期被删的具名导出；overlay 行是否还有目标 |
| `npm test` | 根套件与 `plugin-kernel-imports` 等静态断言 | 真实内核组合、渲染期 |
| `check:graph` | 五处套件名单一致、core 包是 peer 不是 dependency、peer 范围没漂 | 运行期行为 |
| `verify --tgz` | 真内核起得来；每个插件的设置路由 200；客户端 bundle 非空；MCP 挂载链路通 | **不驱动浏览器**：`slot entry crashed` 恰恰在路由 200 且 bundle 非空时发生 |
| `check:plugins` | 用给定内核以临时 `DSH_HOME` 短启动，扫启动输出的失败信号 | 它的失败规则收窄为 `ERR_*` / `Cannot find module` / `duplicate …` / `failed to load\|start` / 缩进堆栈行——**不含** `patch: entry … not found` 这类文案，所以它"通过"不能替代对启动日志的显式检索 |
| `check:slots` | 客户端半注册的每个座位在跟随线上仍然存在（**已在 CI 里**，见 §2.2.2） | 组件真的渲染了吗；注册方插件未安装时该注册进 `unjudged` 而不是判定 |

因此第 3 节的结论必须与第 6 节的渲染面判定合起来看，缺一条就不算覆盖。

本轮交付时这六条的实际结果 `[实测]`：`typecheck` exit 0、`check:graph` `ok — no violations`、
`npm test` 531 用例 / 530 pass / 1 skipped / 0 fail、`check:slots` exit 0；`verify --tgz` 与
`check:plugins` 需一份 runtime 产物或真实 `DSH_HOME`，本轮未跑。

---

## 4 换线专属检查

只在**换线**（major/minor 变动或预发布通道切换）时执行。下表六项均为 `[静态]`：判据来自
源码与构建脚本，本轮未换线因此**未实跑**，写回归记录时按 `[待验证]` 处理。

| 项 | 检查方式 |
|---|---|
| 私有宿主包被正确构建进 runtime | `tar -tzf <runtime>.tgz \| grep dsh-desktop-host`，应含 `lib/index.js`。该包从不发布，由 `scripts/build-runtime.mjs` 从检出构建 |
| 办公载荷随 runtime 打包 | 同上，应含 `runtime/office-skills/scripts/check_office.py`（在**内核树内**，即双层 `runtime/runtime/`） |
| 宿主传输分支未被切换 | 真机日志确认 `web transport`；出现 frames 分支说明走到了另一条协议路径 |
| 客户端存储按线清理 | 换线后 `src/main/client-state.ts` 应报 `cleared`（客户端状态属于写它的那条线） |
| overlay 行 id 是否还有目标 | 组合树里逐行确认；行 id 会在 bundle 层之间移动，override 因此可能失去目标 |
| 插件本地 `node_modules` 已随线 | 见第 8 节第 2 条——插件本地不跟着升就是版本偏斜 |

---

## 5 真机回归

升级本身要跑的是“能不能起来、机制还在不在”这几条；界面侧的逐项确认另立任务。

M1–M5 的判据是 `[静态]`（来自已完成的升线记录与构建脚本）；本轮**未跑**，因为本轮没有换线。

| 编号 | 步骤 | 预期 | 为什么这条重要 |
|---|---|---|---|
| M1 | 新 runtime 启动到主界面 | `host ready (web transport)`；无 `plugin tree failed to load` | 基本可用性 |
| M2 | 改一个设置 → 重启 | 值仍在，且仍是生效行 | 验证 `suite-layer` 在新线上仍成立 |
| M3 | 定时任务可用 | 工具在；会话头部有日程目录 | 相关行在 bundle 层之间移动过（见第 4 节） |
| M4 | 市场禁用/启用一个插件 | 块内若有内核设置行不被连带删除 | 验证 R7 修复在新线上仍成立 |
| M5 | 办公组件（诊断页或 `office_to_pdf`） | 载荷可识别；不报"未声明办公组件" | `argv[4]` 的 office 契约是最脆的跨进程契约 |

M1 用**隔离的 `DSH_HOME`** 跑；M2 用同一 home 做二次启动，确认 patch 文件字节前后一致。

---

## 6 渲染面与交互面：盲区的准确边界

第 3 节的自动门禁到“路由 200 + bundle 非空”为止，**没有一条驱动浏览器**。探针
（`scripts/probe-*.cjs|mjs`）**不在 `npm test`、也不在 `npm run verify` 里**。

### 6.1 已封闭的一半：注册面

客户端插件的渲染级故障里，**可静态判定的那一半已经进了门禁** `[实测]`——就是第 2.2 节的
`npm run check:slots`。它覆盖的两种形态（未声明的 slot 抛、已退役的 slot 静默无操作）正是
“表面静默消失”类故障的根因，而它们不需要浏览器就能判定，因为内核把座位声明在随包发布的
`SlotMap` 里。

### 6.2 仍未封闭的一半：组件真的渲染了吗

`check:slots` 能证明**注册解析得到**，不能证明**组件渲染成功**。剩下的故障面是：

- 组件引用了一个被删除的具名导出 → 已由 2.1 覆盖（名字存在性），但“名字存在却形状变了”
  仍要渲染才能发现；
- 组件自身抛错 → 内核的错误边界会卸载**整个 slot 条目**，控制台只有一行压缩记录。

要覆盖这一半必须真实浏览器。**当前开发环境里这条路径不可用** `[实测]`：在 Electron 内用
`process.execPath` 起内核子进程拿到的是 electron.exe 而不是 Node，内核根本起不来（日志只
填满 Electron 自己的 GPU 缓存错误）；本仓库的规则明确写了内核子进程必须用真正的 Node。
已有的手动探针（如 `probe-settings-nav.cjs`）靠 `pnpm dsh web` + 已构建的检出启动，需要一份
构建完成的 harness 检出。

本轮曾写过一个按此判据的探针，因上述原因无法验证，**已删除而非交付**——一个没跑过的
脚本不能当作覆盖。

因此本轮的结论是**明确降级** `[实测]`，而不是假装覆盖：

| 问题 | 判定方式 | 状态 |
|---|---|---|
| 注册的座位是否还存在 | `npm run check:slots` | 已自动化 |
| 具名导出是否还存在 | `test/plugin-kernel-imports.test.mjs` | 已自动化 |
| 客户端 bundle 是否被服务 | `npm run verify` | 已自动化 |
| 组件是否真的渲染 | 真实浏览器探针 | **未覆盖** `[待验证]`，需一份构建好的 harness 检出 |

### 6.3 判定纪律

拿到浏览器环境后，三条同时成立才算一个插件“工作”：

1. **客户端 bundle 被服务** + **样式标签存在** + **`slot entry crashed` 计数为零**。任一条
   单独成立都不算——前两条成立而第三条不成立，正是已发生过的故障形态
   （`src/main/client-state.ts:9` 记录了 `slot entry crashed in 'sidebar.workspaces'` 导致整块
   会话列表丢失；那条注释没有说明当时的门禁状态，因此这里只主张故障形态，不主张门禁当时是绿的）。
2. **交互触发的界面在静态巡检里看不见**。只有粘贴、文件操作、焦点事件之后才出现的界面，
   空闲巡检下什么都不显示；这类面必须模拟触发，或在判定里明确写“已加载，交互路径未验证”，
   **不得**写成通过。
3. **每个插件给一个判定**，不是一个总的“全绿”：`工作` / `已修` / `已加载但交互路径未验证` /
   `断裂`，并附覆盖的内核版本与证据（哪条断言在哪里通过）。

样式标签的真实机制（写探针时别猜）：内核的 `claimStyles(id)` 给每个插件物化时注入的
`<style>` 打上 `data-plugin="<包名>"`（`dsh-client-modules/lib/client.js`），`data-plugin-css`
只是可选的**文件名**标注，不是判定依据。

### 6.4 探针与自动门禁的同步要求

- `scripts/probe-drag.cjs` 镜像 `src/main/window.ts` 的 `DESKTOP_CHROME_CSS`，
  `test/desktop-chrome-css.test.mjs` 会读它；
- 探针运行在 Electron 内，**每个 `spawn` 必须传 `windowsHide: true`**，否则每起一个控制台
  子进程都会在用户桌面上弹窗。
---

## 7 记录与判定规则

### 7.1 每条记录带固定字段

升线时把每条发现写成固定字段，而不是散文：**类型**（破坏/行为/能力/修复）、**接触面**
（第 1 节七类之一）、**症状**、**修法**、**验证方式**、**来源**（tag、commit、文件:行）。
字段化的唯一价值是**可检索**：下一次升线能机器筛出"哪些条目会打到我们"，而不是重读全文。

### 7.2 负面证据要写下来

"查过了、没有"和"没查"在记录里必须可区分。未命中的接触面、确认未变动的面（会话格式版本、
`engines`、客户端 manifest 形状等）都要写进同一张表并注明判定依据。否则下一次升线会把
同样的地方重查一遍。

### 7.3 判定口径统一为四类

对每个上游条目给出且只给一个判定：**已有等价**（我们仓库里已有同样效果）、**归上游**
（随线升级到位，不需要我们写代码）、**值得移植**（上游做在外壳侧、我们没有）、**无关**。
每个判定附 `文件:行` 依据。

### 7.4 结论只在证据允许的范围内

`[实测]` 与 `[静态]` 分开标注；推断标 `[待验证]` 并给出最短验证路径。一条“通过”只覆盖它
实际跑过的面——`verify` 通过不等于渲染正常，`check:plugins` 通过不等于 overlay 行还有目标。
无标记的断言不得当作已验证。

---

## 8 常见误判

每条都在本项目真实发生过。除第 12 条（`[静态]`，源码与换行符约定）外均为 `[实测]`，遇到时
先看这里。

1. **编译绿 ≠ 运行绿。** 具名导出被删后类型检查通过、运行时 `undefined`。见 2.1。
2. **插件有自己的 `node_modules`，必须一起升。** 只改根 `package.json` 时，插件的 `tsc`
   仍报 0 error——那测的是**旧线**。验收要同时看两处：
   ```sh
   node -e "console.log(require('./node_modules/@deepseek-ai/dsh-app-boot/package.json').version)"
   node -e "console.log(require('./plugins/plugin-archives/node_modules/@deepseek-ai/dsh-client-connection/package.json').version)"
   ```
   两处都必须是新线，否则是编译期看不见的版本偏斜。
3. **`^0.1.7-alpha.2` 这类旧规格不接受新的预发布版本**（`semver.satisfies('0.2.0-rc.1', '^0.1.7-alpha.2', {includePrerelease:true})` 为 `false`），所以插件的 peer **与** dev 都要改。
4. **改 spec 保留旧 lockfile 会 ERESOLVE。** 换线必须先清根与全部插件的 `node_modules` +
   lockfile，再按"根 → 插件（`--legacy-peer-deps` 只在插件目录用）"的顺序重装。
5. **换线后第一次 `npm test` 可能红在 electron 上，不是回归。** 重装后 `electron/dist` 还没
   解出来，而 node 测试运行器**并发**跑那几个文件，多个进程各自触发 `install.js` 在同一目录
   互相踩踏（`failed to create …\electron\dist\locales\*.pak: 拒绝访问`）。补齐 `dist/` 后单独
   重跑即绿——换线后要么先手动补 `dist/`，要么不要并发起跑。
6. **行 id 会移动。** 某些行会在 bundle 层之间搬家（从一个 bundle 移入可选 bundle），
   overlay 的 override 因此失去目标、静默 no-op；这种情况下要改用 insert，并在注释里写清
   为什么不能用 override。
7. **`--dump-config` 不能证明插件仍挂载。** 它在被拒的行上仍照常打印，只有整包被拒时才
   掉出 dump。要断言启动 stderr 里没有对应的拒绝行。
8. **`patch: entry … not found` 不在 `check:plugins` 的失败规则里**，它"通过"时仍要显式检索
   启动日志。
9. **环境现象不是回归。** 代理注入、镜像延迟、`node_modules` 残留都会制造看起来像回归的
   症状。先把它们排除，再改代码。
10. **本会话的 `PATH` 里带着内核自带的 `pnpm\bin`，会让 `test/host-arg-shape.test.mjs` 红。**
    那个用例断言子进程 PATH 里不含 `\pnpm\`，而 `DshHost` 以 `{...process.env}` 起子进程，
    测试读回的环境自然带着这一段。`[实测]`：把 PATH 里含 `pnpm` 的段清掉后同一个文件
    22 pass / 0 fail，整套 515 pass——**与代码改动无关**。在开发会话里跑全量测试前先清：

    ```powershell
    $env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notmatch 'pnpm' }) -join ';'
    ```
11. **在 Electron 里用 `process.execPath` 起内核子进程会得到 electron.exe。** 日志会填满
    Electron 自己的 GPU 缓存错误，内核永远不就绪（`Unable to move the cache: 拒绝访问`）。
    内核子进程必须用真正的 Node，runtime 树自带的那份就在 `runtime/node/`。
12. **换行符是 CRLF。** 写会匹配源码的正则（变异脚本、校验器）时，基于 `\n` 的模式会静默
    不匹配。本仓库已有两个实例因此报错。

---

## 9 升线清单

清单汇总上述各节的动作；每一项的证据标记跟着它引用的那一节，本身不另标。以下 `[ ]` 是模板，
每次升线复一份到 `docs/kernel-<版本>-*.md` 并逐项填结果。

升线前：

- [ ] 第 1 节七类接触面扫描：`npm run check:touchpoints`，命中与未命中都进表
- [ ] 注册面：`npm run check:slots`
- [ ] 导出面报告：`npm run check:surface -- --used-only`，看新增面里有没有该用的
- [ ] 第 2.1 节具名导出断言在**目标线**上通过
- [ ] 目标线的组合树里，overlay 的每一行都还有目标（第 4 节）

升线中：

- [ ] 根 + 16 插件 spec 同改；清 `node_modules`/lockfile；根 → 插件顺序重装
- [ ] 两处版本解析都落到新线（第 8 节第 2 条）
- [ ] `npm run runtime:build`，产物版本与 spec 一致
- [ ] 重建后 `check:graph` 报的是新线

升线后：

- [ ] 第 3 节自动门禁裸跑全过
- [ ] 第 4 节换线专属检查逐项过
- [ ] 第 5 节 M1–M5
- [ ] 第 6 节渲染面：探针跑一遍，按三条纪律出**每插件**判定表
- [ ] 第 7 节记录成文，含负面证据
- [ ] 改动落在 `changesets/` 片段里

---

## 相关文档

| 文档 | 用途 |
|---|---|
| [`build-and-release.md`](build-and-release.md) | runtime 产物、办公载荷、bundled kernel 的构建与发布 |
| [`profile-supply-chain.md`](profile-supply-chain.md) | 换线后**用户机器上**的 profile 供应链（`profiles:audit` / `prune` / `peers`） |
| [`troubleshooting.md`](troubleshooting.md) | 超时、错误码、日志行的定位 |
| [`release-checklist.md`](release-checklist.md) | 发版清单 |
| `docs/kernel-<版本>-*.md` | 单次升线的调研结论、执行台账与实测数字 |
| 根 `AGENTS.md` §3、§5 | 命令入口与流程铁律 |
