# 桌面能力补齐（七项 + 一项可选）

- Status: active
- Plan date: 2026-10-13

## Goal

把一批已经确认**可在本仓库落地**的能力补齐，全部落在 shell（`src/main`、`scripts`、`electron-builder.yml`、`.github/workflows/ci.yml`）或套件插件里，**不改内核源码**、不需要新的内核线能力。成功标准：每项都有可执行验证（脚本或手测步骤），且不触碰既有安全不变量（不新增 preload/IPC 通道、不进页面 DOM、不把提示词写进日志）。

## Scope

- Must-have: W1–W7
- Out of scope:
  - 工作台级 UI（文件树 / 内嵌编辑器 / 看板 / 多面板布局）：不是低垂果实——它的前提是版本化的侧栏-Tab-文件查看器贡献契约 + 受控文件 + PTY + 冲突规则，跨内核线与平台 ABI，与本仓库"不 fork 内核、适配留在 shell 侧"直接冲突。可借的是 seam，不是 UI。
  - 内嵌 PTY、窗口多档模式与材质、首次设置向导、手机远控、Computer Use、原生权限服务。
  - 任何给上游包打补丁的做法（`patch:` / vendored 分叉）——本仓库硬约束。
- Out of scope（已定）: W8（Windows Portable 产物）——2026-10-13 主人决定不做：它是产品增量而非防回归，且 Portable 形态按设计不接自动更新路径，没有"自行解压即可运行"之外的独有价值。

## Work items

| # | 类目 | 内容 | 状态 |
|---|------|------|------|
| W1 | P1 | **受管终端 + CLI 兜底**：新增 `src/main/terminal.ts`（纯函数产出 `{command,args,env}`）+ 托盘项 + 两语言词条。只为该子进程前置私有 `dsh`/`pnpm`/`node` shim 并置 `DSH_HOME`/`DSH_APP_PROFILE`，不改系统 PATH。**生成的批处理必须自带 `chcp 65001`**：写盘是 UTF-8 而 cmd 按 OEM 代码页读批处理，非 ASCII 路径（中文账户名是标配）下会静默退化成系统 `node` + 全局 `dsh` 却仍报成功（审查抓到的 Blocker，修前/修后已实测）。**Windows 的开窗形状必须是 `cmd /d /c start "" <cmd> /d /k call <launcher>`**：原先直接 spawn `cmd /d /k …` 并配 `stdio:'ignore'`，子进程的 stdin 是 NUL、交互式 shell 见 EOF 立即退出——`spawn` 事件照常触发、函数报 `opened`，但**永远不会出现窗口**；PowerShell 分支同样如此。这条躲过了三轮审查（它们测的都是 argv 形状与环境送达，没有一次验证窗口是否真的出现），最后由主人在真机上点两次发现（`[terminal] opened cmd.exe` 记了两次而桌面什么都没出现），用 Electron 当父进程 + 枚举顶层窗口才定位。现在两条分支都经由 `start`（由系统把新控制台交给默认终端应用），批处理末尾按偏好交接给 PowerShell。`opened` 的语义随之收窄为"请求已发出且 wrapper 干净退出"——`start` 之后本进程观察不到那个控制台，措辞不许再夸大。失败对用户可见（一次 `promptNoticeThemed`）。理由：市场把装/卸/升级都做进 GUI，失败时却只让人"手工编辑 profiles 下的 cordis.patch.yml"，而用户没有任何途径跑 `dsh plugin --profile dsh-app add <包名>`（`--profile` 是内核 `plugin` 子命令的必填项，CLI 不读 `DSH_APP_PROFILE`）。 | [x] |
| W2 | P1 | **同步事实的漂移门禁**：新增 `scripts/check-suites-drift.mjs`（`--check` 形式）断言套件 roster 的五处取值一致（`plugins/dsh-app.patch.yml` 的 insert 行、`scripts/kernel-line.mjs` 的 `SUITE_PLUGINS`、`src/main/brand-suite.ts` 的 `SUITE_PLUGIN_DIRS`、`scripts/smoke-suite.mjs` 的 `SUITE_DIRS`、`.github/workflows/release.yml` 的预构建循环）。**读取器的形状契约是硬契约**：认不出的形状判 exit 2（红），不是"少读一条"——否则一行写成别的形状就变成"一致"。CSS/probe 那一对不在此项内：`test/desktop-chrome-css.test.mjs` 已逐行比对两侧并随 `npm test` 跑（审查实测：改一侧一条声明即失败）。理由：roster 是 AGENTS.md 明文要求"同一 commit 改全"的同步事实，此前没有执行物，漂移只靠人肉。 | [x] |
| W3 | P1 | **目录源请求的私网与重定向防护**：`plugins/plugin-market/src/catalog.ts` 在既有"必须 https、拒 URL 内凭据"之上，对 URL 字面量与解析结果判私网/回环/链路本地/云 metadata（10/8、172.16/12、192.168/16、127/8、169.254/16 等），并把同一套判定**覆盖到 npm 源的两跳**（registry metadata 与 `dist.tarball`，默认源就走这条通路）与 `Location` 跳转目标：redirect 不直接跟随，判定过的一跳才放行。判定不可得时失败关闭。**例外：`198.18.0.0/15` 是本机所在网络形态（TUN/假 IP）的段位，不得一刀切拒绝**。 | [x] |
| W4 | P2 | **安装的一次性意图令牌**：`plugin-market` 的 Host 侧把"事实 + 条目 + 当前 profile + 过期时间"绑成一次性 token，渲染进程只提交 token；`market_install_plugin` 的模型面走同一队列与同一校验；`/allow-build` 只接受宿主自己记录过、pnpm 报告过被拦的安装尝试里的包名（审查抓到的 Blocker：此前它能被渲染进程用来命名任意未安装的包并写进 profile 白名单）。**收窄后的准确主张**：被移除的是"精确版本钉选"与"任意 git 目标"两项权限；目录源列表仍可由渲染进程修改，这一层不在本轮范围（见 Open decisions）。弹窗停留超过令牌有效期时确认会自动重签一次同一目录条目，而不是像首次实现那样直接失败（审查抓到的可见行为回归）。 | [x] |
| W5 | P2 | **目录源的公开契约**：把 `catalog.ts` 现有的三套 schema 嗅探整理成可发布的 JSON Schema + 一份 adapter 说明（放 `plugins/plugin-market/docs/`），外部源作者不再需要猜形状。**首版被独立审查判为"保护的是三处文本长得一样，而不是 schema 与解析一致"**（三条反证：插件自己的默认源 4527 行有 2179 行过不了它、真源有一行被判非法而解析器照收、schema 判合规的文档能被解析成 0 条而全部用例仍绿）。重做后：校验器改成**静态全量**关键字审计（未实现的关键字在任何实例之前就抛）、字段漂移守卫改成**基于 TypeScript AST 的溯源扫描**（覆盖 `record.x`/`?.`/`['x']`/解构/`in`/`Object.keys`/跨函数传参，扫整个 `src/`）、真实源的**节选 fixture** 入库、`installCommand` 的 pattern 由解析器自己的规则导出、文档表格的 Type/Required 两列也纳入比对、`docs/` 加进插件 `files` 并把 `$id` 换成可解析的形态。 | [x] |
| W6 | P2 | **结构化开发者日志**：在既有 `src/main/log-file.ts`（约 1 MiB 轮转、留一代）之外，新增按天/按大小轮转的 jsonl sink，记录启动/进程/序号/耗时与关联 id；**默认不落提示词、工具参数与结果、HTTP 正文、认证头**（沿用 `src/main/redact.ts` 的约束）。独立审查**无 Blocker**（裁剪不误删同目录其它文件、上界成立、真机文件逐行可解析且无凭据命中），但抓到两条真实缺口：`redact()` 没有 URL userinfo 规则（带凭据的镜像 URL 会逐字落盘）与 `host.start.failed` 会把子进程 stderr 尾巴（≤2 KB 任意文本）写进这个"鼓励外发"的文件。两条都已修：`redact()` 增加 userinfo 规则、镜像来源改记标签、异常路径只记派生字段；另外把"渲染失败不抛"补成真的（渲染也在 `try` 内）、轮转按 mtime 钳位、裁剪逐条容错、截断计数修正。 | [x] |
| W7 | P2 | **配置级检查点 + 恢复入口**：每次健康启动写轮转检查点（激活 profile 的 `package.json`/`cordis.patch.yml`/`pnpm-lock.yaml` 与 home 层 `$DSH_HOME/cordis.patch.yml`），在既有失败对话框之外提供"恢复上一次可用配置"的入口。不改内核目录的原子切换与回滚（已在 `docs/ARCHITECTURE.md:220-236`）。实现：一代一个目录（`manifest.json` 最后落盘，半份就是"不是检查点"），单文件 1 MB / 一代 2 MB / 留 3 代（本机实测一代 63350 B）；健康判据 = 宿主 `ready` + 窗口已交接到真实界面 + 非安全模式 + 同进程只写一次；恢复**先全部预检再写**、目标不是普通文件就整体拒绝、被覆盖的四个文件各留一份 `*.bak-before-restore-<时间戳>`、恢复后强制重启。**永不自动恢复**。 | [x] |
| W8 | OPT | **Windows Portable 产物**：`electron-builder.yml` 增加 `portable` target + 一个 `dist:win-portable` 脚本 + release job。**本轮不做（已定，2026-10-13 主人决定）**：它是产品增量而非防回归，且 Portable 形态按设计不接自动更新路径，得先确定更新器对"无安装记录"的表现；在自行解压即可运行之外没有它独有的价值。 | [–] 本轮不做（理由见左） |

## Phases

| 阶段 | 包含条目 | Gate | 状态 |
|------|----------|------|------|
| 1 | W2, W3 | 漂移门禁对当前仓库报"无漂移"（并能在故意植入一处不一致时报出路径）；私网校验的单测覆盖 127/10/169.254/198.18 四类；`npm test`、`npm run check:graph` 全绿 | [x] |
| 2 | W1, W4 | Windows 与 macOS 各手测一次：终端能起、`dsh --version` 指向当前内核、`DSH_HOME`/`DSH_APP_PROFILE` 正确；市场面板装/卸/升级行为不变且走 token | [x] Windows 手测通过（Test 6，含非 ASCII 路径的修前/修后对照）；面板实机安装通过（Test 8，主人装 `@openviking/dsh-memory-plugin@0.5.24` 成功）；macOS 无设备，Test 7 记 `[–]`（不被本轮 Gate 计数） |
| 3 | W5, W6, W7 | schema 与示例通过校验；jsonl 出现且断言不含提示词/正文；检查点恢复一次成功 | [x] 三条都达成且各自过审（W5 首版被审查推翻后重做；W6 无 Blocker、两条泄漏已修；W7 真机恢复闭环）。W8 已定不做（`[–]`），不计入本 Gate |

阶段闸门：任何条目处于 `[~]` 或 `[?]` 时不得开始下一阶段。条目从 `[~]` 转 `[x]` 前必须回答四问——主张复核、最小性、新风险、反例。

## Affected behaviors

- W1：`src/main/tray.ts:51-70` 菜单多一项；`src/shared/locale.ts` 新词条；**不新增 preload 或 IPC 通道**。
- W3：用户手填 `https://127.0.0.1/…` 或内网域名的目录源会被拒（此前会被请求）；npm 源的 registry metadata 与 `dist.tarball` 也要过判定，302 不再直接跟随（判定过的一跳放行，第二跳终止）；镜像源（如 `registry.npmmirror.com` 的 tarball 会 302 到 `cdn.npmmirror.com`）在判定后仍可用。失败时的面板文案改为固定句，不再回显上游响应体。
- W4：`plugins/plugin-market` 的 `POST /install` 请求体形态变化；面板可见行为不变。
- W6：日志目录新增文件（体量上限需写明）；诊断导出需决定是否纳入。已定：`<logs>/dsh-events.jsonl` 单文件 2 MB、留 4 代、全家族上限 10 MB（`EVENT_LOG_MAX_BYTES` / `EVENT_LOG_KEEP_ROTATIONS` / `EVENT_LOG_MAX_TOTAL_BYTES`，依据写在 `src/main/event-log.ts` 模块头）；诊断导出本轮**不纳入**（见 Open decisions 第 14 条）。
- W8：若发布，`latest.yml` 与 Portable 产物并存，更新器对 Portable 的行为需确认——Portable 形态按设计不接自动更新路径。
- W2/W5/W7：新增文件与入口，不改既有行为。

## Test plan

| # | 用例 | 输入/操作 | 预期 | 验证方式 | 结果 |
|---|------|-----------|------|----------|------|
| 1 (W2) | 当前仓库无漂移 | 直接跑门禁 | 退出码 0，报告五处一致 | `node scripts/check-suites-drift.mjs --check` | PASS — exit 0，五处各 18 条，`no drift` |
| 2 (W2) | 植入一处漂移能报出 | 临时在 overlay 删一行 insert；另植入**形状不同**的一行（`- name: '@dsh-app/plugin-extra'`、数组项改双引号） | 退出码非 0，指名漂移的那一处与路径；形状不同者判 exit 2 而不是静默一致 | 同上（改完复原） | PASS — 删行 → exit 1 指名；`- name:` 行 → exit 2 指名 `line 108`；双引号数组项 → exit 2 指名 `line 90`。两处植入均已复原（`git diff` 为空） |
| 3 (W2) | CSS/probe 两份一致 | 直接跑既有测试 | 不一致即失败 | `node --test test/desktop-chrome-css.test.mjs` | PASS — 6/6；审查另做反证（改一侧一条声明 → 失败，仅重排缩进 → 仍过）。该对比早于本轮存在，未重复实现 |
| 4 (W3) | 私网与回环被拒 | 单测 + 真 HTTP 探针：`127.0.0.1`/`10.0.0.1`/`169.254.1.1`、IPv6 回环、十进制/八进制/十六进制写法、IPv4-mapped | 拒绝，理由为 HostText code；请求不发出 | `cd plugins/plugin-market && npm test` | PASS — 315/315；探针复跑：字面量回环、tarball 302 到回环、registry metadata 302 到回环三例目标**零命中**；对照例（302 到允许地址）仍正常跟随一跳 |
| 5 (W3) | 假 IP 段不被误拒 | 单测：`https://198.18.0.57/x` | **放行** | 同上 | PASS — 放行。**但"与 proxy-detect 探测结论配合"这一半没有实现**（见 Open decisions 第 4 条），当前是无条件放行 |
| 6 (W1) | 终端可用且环境正确 | Windows 手测：托盘 → 打开终端；`dsh --version`；`echo $env:DSH_HOME` | 版本指向当前内核目录；`DSH_HOME` 为真实 home | 手工步骤（记录输出） | **先是假 PASS，已更正为真 PASS。** 第一版我写了"用户桌面已真实弹出一次窗口"并只凭 `status: opened` 作证——**那是错的**：`opened` 只说明 `spawn` 事件发生。主人在真机上点两次、日志记了两次 `[terminal] opened cmd.exe` 而桌面什么都没出现，才暴露真因（`stdio:'ignore'` 把 stdin 接到 NUL → `cmd /k` 见 EOF 立即退出；PowerShell 分支同样）。修后以 Electron 为父进程 + 枚举顶层窗口复核：**调用后窗口存量 +3**，含 `WindowsTerminal\|CASCADIA_HOSTING_WINDOW_CLASS\|cmd.exe` 与 `cmd\|PseudoConsoleWindow`，**修前为 0**。环境正确性仍成立：在那份 launcher 环境里 `node --version` → `v22.23.3`（运行时 node）、`dsh --version` → `0.2.0-rc.2`（应用自己的内核）、`pnpm --version` → `11.24.0`、`where dsh` 首条为 shim、`DSH_HOME`/`DSH_APP_PROFILE` 正确；含中文的 shim 目录与 CLI 路径下也复现过 `chcp 65001` 那条 Blocker（去掉后 `node` 落到系统 Node、`dsh` 落到全局 npm 版本）。**仍未被自动化覆盖**：窗口真的出现这件事只能靠 `scratch/window-probe/` 手工验（单测只能钉 argv 形状与退出码判据） |
| 7 (W1) | macOS 同上 | 手测 | 同上 | 手工步骤 | `[–]` 本轮不做 — 无 macOS 设备。`planDarwin`（`open -a Terminal` + `open.sh` + `exec $SHELL -l`）只有静态审读，未真机验证 |
| 8 (W4) | 安装走令牌且行为不变 | 面板装一个包；再看 `POST /install` 的请求体 | 请求体只含 token；安装与既有确认流程一致 | 手工 + 路由单测 | **PASS** — 自动证据：364/364 插件测试；客户端断言 `/install` 只提交 `{token}`、签发只提交 `{entryId, force?}`；探针显示合法 blocked-builds 重试仍可用（502 → `allow-build` 200 → 白名单写入 → 安装执行一次），未尝试过的包名被 400 拒且不写白名单、不调执行器。**实机**（2026-10-13 主人操作）：面板装 `@openviking/dsh-memory-plugin@0.5.24` 成功，确认弹窗照常出现，安装日志为宿主自己跑出来的一轮 pnpm（`Packages: +1`），面板提示与改前一致 |
| 9 (W6) | 日志不含正文 | 跑一次真实会话后检查 jsonl | 无提示词、无工具参数/结果、无认证头 | `node -e` 扫描新 jsonl 的关键字段 | **PASS** — 真机 `npm start` 三次（后两次为最终代码）：13 行事件，`run` 恒定、`seq` 1→13 单调；手工 kill 内核子进程后记到 `host.exit`（code 1、uptimeMs 15359）→ `host.down`（attempt 1）→ 重启一轮 `host.start.*`。写失败路径同样真机验证：把 `dsh-events.jsonl` 置只读后 kill 子进程 → 应用照常重启，`dsh-kernel.log` 多出**恰一行** `[events] the structured event log could not be written: EPERM…`（同一次故障里的后续 5 个事件不再重复上报）；恢复可写后再 kill → 事件以 seq 8 续写（丢弃的行不占序号）；再置只读并 kill → 第 2 行上报，共 2 条。单测 `test/event-log.test.mjs` 12/12：一行一个合法 JSON、token/sk- 键/Set-Cookie/JWT 均不落盘且被 `[redacted]`、超长值截到 `MAX_LOG_LINE`、换行注入不产生第二行、轮转后有界且只删自己命名的文件、失败只上报一次且不抛。反证：摘掉 `redact` → 该用例红（JWT 原样落盘，且 10000 字符的值不再被截）；停掉保留策略 → 生成 6 代而非 4，用例红。**第二轮审查（独立）**：无 Blocker；反证 9 条全部在修前复现（镜像 URL 的 userinfo 逐字落盘、`log()` 从渲染处抛到调用方、`host.start.failed` 把子进程 stderr 尾巴写进文件、13 键只报 1 个截断、调用方 `truncated` 键原样通过、循环引用落 `[object Object]`、时钟回拨删掉最新一代、同名目录让裁剪中止等）。**修复后我的独立复核**：`redact('https://alice:s3cr3t-pw@ghproxy.example/…')` → `https://[redacted]@ghproxy.example/…`，而普通 URL 与带端口的本地 URL 逐字不变（`?token=` 仍被替换）；`log-redaction` 36/36、`event-log` 18/18；根 `npm test` 603/602 pass/0 fail |
| 10 (W7) | 检查点可恢复 | 改坏 profile patch 后启动 → 走恢复入口 | 回到上一次可用配置，失败对话框仍在 | 手工步骤 | **PASS（真机，用主人自己的 profile）** — 健康启动写下检查点（日志 `captured checkpoint-20261013T053509Z-01: 4 file(s), 63350 bytes`，清单里的四个 sha256 与动手前的备份逐字节一致）→ 把 profile 的 `cordis.patch.yml` 追加坏 YAML → 重新启动失败（`failed to parse overlay … end of the stream or a document separator is expected`）→ 失败卡上读出 `buttons=["重试","恢复上一次可用配置","打开日志目录","退出"]` → 点它（`[config-checkpoint] restored …: 4 file(s) written, 4 backup(s); the app must relaunch`）→ 重启后健康并写下第二代检查点 → 四个文件与动手前 `cmp` **IDENTICAL**、备份已移出 profile。单测 16/16（含四条反证：跳过备份 / 多删一个文件 / 损坏检查点也照恢复 / 丢掉预检）。**未真机点击的**：托盘那一行（原生托盘菜单无法用 CDP 展开） |
| 11 (W8) | Portable 可启动 | 解压 → 运行 → 打开窗口 | 窗口正常、数据写在既有 userData | 手工步骤 | `[–]` 本轮不做（默认不发布 Portable 形态；需先确定更新器对"无安装记录"的表现） |
| 12 (W5) | 契约与解析一致 | 真实源的节选 fixture + 注入各种字段读法 | 真实源通过 schema；任何未被 schema 声明的字段读取都让套件变红 | `cd plugins/plugin-market && npm test` | **PASS** — 386/386。真实源 fixture（从默认源的原始文档裁 3+2 行、从第二个源裁 2 行）通过；`installCommand` 的 pattern 由解析器规则导出并断言字符串相等。**我的独立反证**：往 `aggregatedEntriesOf` 注入一处 `record?.deprecated`（旧守卫静默放过的那种可选链读法）→ `catalog-contract` 的 2 条用例立刻变红（`every field the parser reads is declared by the schema`、`the scan covers the whole src/ tree…`），复原后 386/386 绿、`git diff` 无该行 |

## Verification commands

- `npm run typecheck`
- `npm test`
- `npm run check:graph`
- `npm run check:slots`
- `npm run check:touchpoints`
- `npm run verify`
- `node scripts/check-suites-drift.mjs --check`（W2 新增）
- `cd plugins/plugin-market && npm run typecheck && npm test && npm run build`（W3/W4/W5）
- `cd plugins/plugin-client-ui && npm run typecheck && npm test`（若 W1 的入口落在客户端）

## Rollback

- W1/W6/W7：新增模块与入口；回滚 = 删除新增文件、撤掉托盘项与词条、撤掉日志 sink 的挂载。检查点与日志写在 `<userData>` 下，删除不影响启动。
- W2：回滚 = 从 `ci.yml` 移除该 step（脚本可留）。
- W3/W4/W5：回滚 = 逐个 revert `plugins/plugin-market/src/**` 的对应提交；目录源的安全收紧属行为变化，回滚前确认没有用户源是内网地址。
- W8：回滚 = 从 `electron-builder.yml` 与 release job 移除 target；已发布产物需在 release 里删附件。

## Phase log

| 阶段 | 日期 | 证据 | 结论 |
|------|------|------|------|
| 1 | 2026-10-13 | `node scripts/check-suites-drift.mjs --check` → exit 0（五处各 18）；`node --test test/suites-drift.test.mjs` → 20/20；`npm run typecheck` 0；`npm test` 553/552 pass/0 fail/1 skip；`npm run check:graph` 0；`npm run check:slots` 0；`npm run check:touchpoints` 0；插件内 `npm run typecheck` 0、`npm test` 315/315、`npm run build` 0；真 HTTP 探针 `scratch/market-npm-hop-guard.bundle.mjs` 三例拦截 + 一例对照 | **四问**：①主张复核——独立审查先证伪了三条主张（W2"读不到永远是红"对"部分读不到"不成立；W3"防护覆盖目录源"对 npm 源两跳不成立；`redirect:'error'` 无测试），两处均为 Blocker，已修并各自留下反证。②最小性——W2 只加形状完备性断言与一个 CLI 入口；W3 只加一次地址判定与 redirect 立场，未动 UI 与既有错误码语义。③新风险——W3 的重定向立场会拒绝会转向的 tarball 主机，故取 `manual` + 判定后放行一跳（实测镜像与官方源均正常）；W2 的形状契约会把上游行的异形写法也判红（方向为多读）。④反例——W2 反例见 Test 2；W3 反例见 Test 4。**结论：阶段 1 通过** |
| 2 | 2026-10-13 | `npm run typecheck` 0；`npm test` 583/582 pass/0 fail/1 skip；`node --test test/terminal.test.mjs` 29/29；`node --test test/recursive-delete-guard.test.mjs` 3/3；`npm run check:graph`/`check:slots`/`check:touchpoints` 全 0；插件内 `npm run typecheck` 0、`npm test` 364/364、`npm run build` 0 | **四问**：①主张复核——第一轮独立审查抓出 W1 的 Blocker（非 ASCII 路径下 cmd 按 OEM 代码页读 UTF-8 批处理 → 静默退化成系统 `node` + 全局 `dsh` 却报成功）与 W4 的 Blocker（`/allow-build` 仍能让渲染进程命名任意未安装的包并写进 profile 白名单）；另有两条 Major（`dsh plugin` 缺必填 `--profile` 的文案、失败对用户完全静默）与一条可见行为回归（令牌过期后确认硬失败）。全部已修，且每条都有修前/修后实测 + 反证实验。②最小性——W1 只加一行 `chcp`、一次错误提示、一处引号处理；W4 只加一张宿主自有的"被拦安装尝试"台账与一次客户端重签，未改目录源模型。③新风险——`chcp 65001` 会改变用户那个终端的代码页（随终端消失，且正是 CLI 的 UTF-8 输出所需要的）；`/allow-build` 改成锚在宿主记录后，"包名未出现在 pnpm 报的被拦名单里"的场景仍按原样放行（否则最常见的原生依赖重试会被判死）；令牌重签只对两个明确的失效 code 生效，其他拒绝照旧上报。④反例——W1：去掉 `chcp` 行 → 新用例红，`where node` 落到系统 Node；W4：去掉守卫 → 3 条用例红，审查者原探针的 `totally-arbitrary-pkg` 被 400 拒且白名单文件不被创建。**结论：阶段 2 的条目已 [x]，但阶段闸门的两个手测（macOS、面板实机点击）仍未完成，阶段 2 记 `[~]`** |
| 3 | 2026-10-13 | `npm run typecheck` 0；`npm test` **620/619 pass/0 fail/1 skip**；插件内 `npm test` **386/386** + build 0；`node --test test/event-log.test.mjs` 18/18、`test/log-redaction.test.mjs` 36/36、`test/config-checkpoint.test.mjs` 16/16；`check:graph`/`check:slots`/`check:touchpoints`/`check:suites:gate` 全 0；Electron 真机探针（`scratch/window-probe/`）证明终端窗口从 0 → +3；W7 真机恢复链闭环 | **四问**：①主张复核——**W5 首版被独立审查整体推翻**（"保护的是三处文本长得一样"，三条反证含"插件自己的默认源 4527 行有 2179 行过不了它"与"注入五种字段读法后 schema 判合规、解析器产 0 条、12 个用例全绿"），已重做为 AST 溯源守卫 + 真实源 fixture；W6 无 Blocker 但 `redact()` 缺 URL userinfo 规则、异常路径会把子进程 stderr 尾巴写进"鼓励外发"的文件，两条已修；**W1 的 Windows 开窗形状三轮审查都没抓到**（都只测 argv 与环境送达），最终由主人在真机上发现——`cmd /k` 配 `stdio:'ignore'` 会因 stdin 为 NUL 立即退出，函数却报 `opened`。②最小性——每条修复都只动出问题的那个点（一行 `chcp`、一条 redact 规则、一张宿主台账、一次重签、`start` 包一层）；W5 的重做是唯一较大的改动，因为它原本的守卫机制本身不成立。③新风险——W1 改为经 `start` 后由系统把控制台交给默认终端应用（本机表现为 Windows Terminal 的新标签页，而不是独立窗口），且本进程再也观察不到那个控制台，`opened` 的语义已相应收窄；W5 的契约现在会**拒绝**那些解析器也取不出安装目标的真实行（388/4527），已作为文档化属性写明。④反例——W5：注入 `record?.deprecated` → 2 条用例红；W6：`redact` 的 userinfo 用例、`host-arg-shape` 的真子进程用例；W7：四条反证（跳过备份 / 多删文件 / 损坏也恢复 / 丢掉预检）各自红；W1：去掉 `start` → 8 条 argv 用例红 + 窗口存量 0。**结论：阶段 3 通过**（W8 已定不做） |

## Open decisions（需人拍板，未擅自实现）

1. **W3 · `198.18.0.0/15` 例外的生效条件**：当前无条件放行（`plugins/plugin-market/src/source-address.ts`）。计划原文要求"与 `src/main/proxy-detect.ts` 的探测结论配合"，但插件侧读不到 shell 的探测结论，且真按探测收紧会让 TUN 机上**所有**目录源被拒。二选一：接受"本机解析层为空转"，或给目录源加 DoH 重解析（新网络依赖）。
2. **W3 · 新增依赖 `ipaddr.js@2.5.0`**（已与套件 fetch 侧同版本、构建时内联，无运行时解析成本）。不做的话要用 `net.BlockList` 自己铺前缀表，且丢掉 range 名字（诊断用）。
3. **W3 · 相邻缺口**：npm 的 metadata 与 tarball 仍是**无字节上限**读取（既有行为，非本次引入）。是否本轮补上限。
4. **W2 · 顺序不一致只报告不致命**：overlay 的行序确实决定挂载顺序，其余四处的顺序无消费者。当前实现保留该取舍。
5. **W2 · `plugins/README.md` 的 18 行表**是第六处 roster（文档），不在门禁内。要不要一起纳入。
6. **W3 · 待裁决的同类盲点**：`[::127.0.0.1]` 的 IPv4-compatible 写法被 WHATWG URL 归一成 `[::7f00:1]` 后放行（本平台连不到回环，且套件 fetch 侧有同一盲点，非本次引入）。
7. **W6 的保留上限/轮换策略**（已定，2026-10-13）：单文件 2 MB、按大小与跨 UTC 天轮转、保留 4 代、全家族上限 10 MB——依据是"结构性事件每次启动约 10 余行、单行远小于 2 KB"，即 2 MB 覆盖上千次启动。**W8 是否做 Portable 形态**仍未定（阶段 3 前定）。
8. **W1 · 是否做一个自动补 `--profile dsh-app` 的包装**（例如 `dsh-app-plugin` 别名），让用户不必每次手写 `dsh plugin --profile dsh-app add …`。改 CLI 语义属于产品决定，本轮只在文案里写对形状。
9. **W1 · 无活跃内核时托盘项是否该置灰**（已定，本轮回填）：**置灰**——没有可用内核时该项 `enabled: false`，不再"点了才弹一句本机还没有可用的内核"。判据 `kernelCliUsable()` 与点击路径的 plan 同一处，菜单在重建时现算。
10. **W1 · 失败提示里的 `{detail}` 是英文诊断**（与 `kernelUpdate.checkFailed` 等既有做法一致）。要不要为每个失败 code 各配一条本地化建议（多 3–4 个词条）。
11. **W4 · 目录源列表仍可由渲染进程修改**：因此"渲染进程不再能命名包"只能收窄表述为"精确版本钉选与任意 git 目标两项权限被移除"。要不要把"添加目录源"改成需要用户显式确认的特权操作（那会让残余一起合上）。
12. **W4 · `/install-intent` 无限流**，且待处理上限 64 条时后签发的会把最旧的挤掉；墙钟 TTL 也会被系统时间回拨延长。建议：加一个按 profile 的令牌桶；TTL 换成基于 `process.hrtime.bigint()` 的单调偏移。
13. **W4 · 模型面被拦的安装尝试不进台账**（改前那条路也没有重试入口，非回归）。要不要一起补。
14. **W6 · 诊断导出是否纳入 `dsh-events.jsonl`**（本轮默认不纳入）：既有导出在 `plugin-brand` / `plugin-client-ui`（`plugin-brand/tests/diagnostics-export.test.ts`）。纳入会把事件流（含本机路径、内核版本、镜像来源、错误消息）带进用户**分享出去的**归档，属产品判断；不纳入则支持包只能看 `dsh-kernel.log`。本轮不做，等拍板。
15. **W5 · 契约仍然"比解析器更严"的残留**：388/4527（默认源）与 28/100（第二个源）的真实行被 schema 拒绝，原因是那些行的 `install` 命令里没有解析器能取出的安装目标（解析器也装不了它们）——已作为文档化属性写进 `docs/catalog-source.md` §7，但"一个源里有一行这样就让整份文档不合规"这一点是否可接受，需要拍板。另有一处更小的差异：`GitHub:owner/repo` 这类大小写写法 schema 拒、解析器收（JSON Schema 的 `pattern` 没有 `i` 标志）。
16. **W5 · 插件其余测试文件的存量类型错误**：`plugins/plugin-market/tsconfig.json` 的 `include` 本轮只放进了新契约套件；另外四个测试文件（`client.test.ts` 32 处、`installed-projection.test.ts` 9 处、`catalog-cache.test.ts` 5 处、`catalog.test.ts` 4 处，多为 `hostMessage` mock 参数个数过时）合计 50 处类型错误，纳入会是一次独立的清理。要不要单独开一轮。
17. **W6 · `app.boot.failed` 仍写 `error.message`**：已核对当前不可达（`server.start()` 全仓只有一处在 try 内调用，stderr 尾巴那条 Error 到不了这个 catch），但将来若新增调用点，这会重新变成泄漏口。要不要顺手改成派生字段。
18. **W6 · 丢失事件的可见性**：写失败不占 `seq`，所以事件文件永远连号——分享出去时看不出丢过事件（本机 `dsh-kernel.log` 里已有 2 行 `[events] … EPERM`）。要不要在故障周期结束后的第一条事件里带一个 `gap`。
