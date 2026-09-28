# 用户设置被外壳重建覆盖 — 回归开发文档

> 立项：缺陷已复现，修复未开始。范围：`<DSH_HOME>/profiles/dsh-app/cordis.patch.yml`
> 的所有权归属，以及因此产生的用户设置丢失。
> 行号截至本次审查，取自当前工作树（`git status` 干净，HEAD `ffb76bc`）。
>
> **证据标记**：`[实测]` = 本次用命令真实跑过、有可复现输出；`[静态]` = 来自源码阅读，
> 实施时必须复验。
> **优先级**：`P0` 用户数据丢失 · `P1` 静默失败或竞态 · `P2` 一致性与清理 ·
> `OPT` 优化项（不做也能跑）。
>
> **使用方法**：§1 是缺陷本体与判定依据；§2 是修复清单（带复选框）；§3 是专项方案；
> §4 是审查项（每项必走的六问 + 本缺陷专属的审查点）；§5 是回归清单；§6 是未验证项；
> §7 是执行顺序与回滚；§8 是决策记录；§9 是审查台账，边做边填。
>
> **一条约束**：任何条目标记为 `[~]`（已改未审）时，不得开始下一阶段的工作。

---

## 0 事实基线

| 项 | 值 |
|---|---|
| 内核线 | `0.1.7-rc.2`（`@deepseek-ai/dsh-settings` / `dsh-config-editor` / `dsh-app-boot` 均为 `0.1.7-rc.2`）`[实测]` |
| 宿主入口 | `@deepseek-ai/dsh-desktop-host/lib/index.js`（安装树内，非本仓库）`[实测]` |
| 引入尾部标记的提交 | `3b2ce94`（`feat(kernel): follow upstream 0.1.7-alpha.1`，2026-09-23）`[实测]` |
| 首个受影响发布 | **v0.13.2**（`git tag --contains 3b2ce94` 的第一个）`[实测]` |
| 复现测试 | `test/profile-patch-kernel-rows.test.mjs`（6 用例，3 失败）`[实测]` |
| 复现探针 | `scratch/probe-fresh-install.mjs`、`probe-final.mjs`、`probe-inplace-real.mjs` `[实测]` |

**必须先认清的一件事**：用户反馈的"设置丢失"真实存在，但**不是所有机器都中**。
本机（`~/.dsh/profiles/dsh-app/cordis.patch.yml`，1401 行）不中，原因是它的第 2 段
（preserved）有大量用户自己的行，内核追加的设置行因此落在"整段原样保留"的区域里。
受影响的是**第 2 段为空、且市场块也没写过的 profile**——也就是新装用户。
这是运气，不是设计属性。

---

## 1 缺陷本体

### 1.1 一个文件，两个写者，两种模型

自 0.1.7 起，用户设置由内核写进 profile 的 `cordis.patch.yml`。内核把它当成**自己拥有的
YAML 文档**：

```js
// node_modules/@deepseek-ai/dsh-config-editor/lib/index.js（edit()）
before = await readFile(path, 'utf8')
const document = parseDocument(before, ...)      // :85
document.contents.flow = false
if (index < 0) document.add(document.createNode({ id, name, config: next }))   // :99
else document.setIn([index, 'config'], document.createNode(next))               // :104
await writeFileAtomic(path, String(document), { mode: 384 })                    // :117
```
`[实测]` 逐行读过；写入链路 `dsh-settings/lib/index.js:470 update()` → `:508
configEditor.edit()`，即**每一次设置页写入都走这条路径**。

外壳把它当成**自己拼装的文本**，靠一个注释标记边界：

```
src/main/brand-suite.ts:301   const PATCH_TAIL_MARK = '# @@dsh-app-rows:tail\n'
src/main/brand-suite.ts:453   composeSuitePatch()   // 从四个具名段落重建
src/main/brand-suite.ts:498   parseSuitePatch()     // 只回读 preserved 段与 tail 段
src/main/brand-suite.ts:1036  writeSuitePatchFile() // 每次启动重建
```
`[实测]`

**注释不是边界。** 序列化器把新增条目插在**最后一个条目之后**，所以内核的行落在
文本的哪里，取决于序列的最后一行是什么，而不取决于注释写在哪。

### 1.2 两条独立的丢失路径

**路径 A — 内核追加的行落进第 1 段**

全新 profile 的第 1 段是唯一内容（随包 overlay），尾部标记是文件的最后一样东西。
内核追加的行于是落在标记**之前**，即第 1 段内部——而第 1 段每次启动都从 overlay 重新生成。

```
$ node scratch/probe-fresh-install.mjs                    [实测]
A. FRESH install — profile seeded from the kernel template "[]"
  start 1: file ends with the tail marker? true
  the sequence's last row is: ui-schedule
  kernel stored the setting; it landed under: "@@dsh-app-rows:suite"
  start 2 → the setting **IS GONE**  (preference: dark absent)
  the 外观 row now reads: (no preference stored at all)

C. a machine that HAS used dsh CLI: web profile carried rows over
  kernel stored the setting; it landed under: "@@dsh-app-rows:preserved"
  start 2 → the setting IS STILL THERE  (preference: dark present)
```

逐个设置项复验（`scratch/probe-final.mjs` `[实测]`），全新 profile 下**四项全部丢失**：
外观/主题、通用设置的首启声明、网络搜索 provider 行、账号身份行。

**路径 B — 内核就地修改 overlay 自带的行**

`web`、`deepseek-account`、`ui-schedule` 这些 id 由**随包 overlay 自己携带**，它们的行
天生在第 1 段，无论用户做了什么。内核就地编辑它们，重建时必然被冲掉。

```
$ node scratch/probe-inplace-real.mjs                     [实测]
**LOST**    web                row sits in section 1? true
**LOST**    deepseek-account   row sits in section 1? true
SURVIVES  ui-theme           row sits in section 1? false
SURVIVES  llm-deepseek       row sits in section 1? false
```
（该探针只读本机真实 profile，从不写回；mtime 未变 `[实测]`。）

### 1.3 为什么现有测试没抓到

`test/log-redaction.test.mjs:214` 把内核的写入建模成字符串拼接：

```js
const kernelWrote = `${first}${settingsRow}\n`     // ← 模拟的是一次内核不会做的写入
```

这恰好模拟了**唯一能幸存**的形态（追加在文件末尾、标记之后）。真实内核走 YAML 文档 API。
测试写的是一个不会发生的场景，所以一直是绿的。`[实测]`

---

## 2 修复清单

### 2.0 状态标记与批判性审查（每项必走）

**状态流转**——每项从 `[ ]` 开始，就地更新，不得跳级：

| 标记 | 含义 |
|---|---|
| `[ ]` | 待办 |
| `[~]` | 已改，**未经审查**——不得进入下一阶段 |
| `[?]` | 审查不通过，已回退或待重做 |
| `[x]` | 已改，且**通过批判性审查** |
| `[–]` | 本轮不做，已记入 §6 或另立任务 |

**每完成一项，必须在 §9 台账留一条记录，回答六个问题：**

1. **主张复核** —— 本文档写的"位置 / 现象 / 证据"是否真的成立？重新打开那一行、重跑那条命令再确认一次。
   若原判断有误，在此写明更正，并回头检查同类条目是否一起错了。
2. **修复最小性** —— 有没有更小的改法？是否顺手改了无关文件？是否引入了当前不需要的抽象？
3. **新风险** —— 这次改动新开了什么失败面（新依赖 / 新的文件写入 / 新的时序 / 回退路径变化）？
4. **边界覆盖** —— 首次运行、空值、文件缺失、并发、回滚、旧数据，这六类路径是否都走过一遍？
5. **验证证据** —— 跑了什么命令、看到什么输出；**没跑的必须写清原因**。
   禁止用"编译通过"或"测试是绿的"当作行为已验证。
6. **反例** —— 说出一个"这次修复仍然是错的"的场景，并说明为什么当前接受这个残余。

**独立性要求**：P0 全部条目，以及任何**会写用户数据**的条目，必须由**非实施者**复核。
本缺陷中会写用户数据的是：`P0-1`（修复本体）、`P0-2`（迁移摘行）、`P1-1`（迁移中断自愈）。

### 2.1 P0 — 用户数据丢失

| 编号 | 条目 | 状态 | 说明 |
|---|---|---|---|
| P0-1 | 外壳不再重建 profile patch：套件的行改由 profile 自己的 bundle 层承载 | `[x]` | 已实现（`src/main/suite-layer.ts`），见 §9 阶段 1 |
| P0-2 | 迁移：首次启动摘掉 profile patch 里套件拥有的行，再挂载 bundle 层 | `[x]` | 判据经评审纠正为**只摘 `insert:` 块**——按 id 一刀切会摘掉 `web`/`deepseek-account`，那是用户当前选择的载体（§3.4）。此后又修了四处：兄弟字段、列 0 注释、注释块内散文（§9 阶段 4）、空行边界（§9 阶段 8 F1） |
| P0-3 | 复现测试转绿（`test/profile-patch-kernel-rows.test.mjs`） | `[x]` | **评审说对了**：不能"转绿"，要**重指向**——原 arrange 用的就是被移除的机制。已重写为"启动期不碰文件"，5 项全绿 |

### 2.2 P1 — 静默失败或竞态

| 编号 | 条目 | 状态 | 说明 |
|---|---|---|---|
| P1-1 | 迁移必须幂等且自愈：中断在摘行与挂载之间时，下次启动收敛而非双树 | `[x]` | 内容比对幂等；安顿后 `status: 'already'`（§9 阶段 2） |
| P1-2 | 宿主在跑时不得重写该文件 | `[x]` | 写只发生在 spawn 之前；安顿后按字节与 mtime 双重断言不写 |
| P1-3 | profile-anchor 线（0.1.5 及更早）上 bundle 层必须写在镜像之后 | `[x]` | 调用点已移到镜像/投影之后；镜像只遍历 source 条目，层不在其中 |

### 2.3 P2 — 一致性与清理

| 编号 | 条目 | 状态 | 说明 |
|---|---|---|---|
| P2-1 | `PATCH_TAIL_MARK` 及其读侧容忍保留为过渡（老 profile 仍可能带标记） | `[x]` | frames 线整条旧路径保留，读写两侧都在 |
| P2-2 | 探针与门禁读文件的位置随迁移更新 | `[x]` | `dist/main/dsh-app.patch.yml` 仍是物化源，路径未变；`probe-settings-nav.cjs` / `probe-chrome-surfaces.cjs` / `smoke-package.mjs` 无需改动 |
| P2-3 | 套件名册五处同步（若迁移改动名册） | `[x]` | 本次不增删插件，`npm run check:graph` 通过 |

### 2.4 OPT — 优化项

| 编号 | 条目 | 状态 | 说明 |
|---|---|---|---|
| OPT-1 | 市场托管块独立成自己的文件，不再寄生在 profile patch 尾部 | `[–]` | 结构上更干净，但 R7 的丢失路径已按行归属判定修掉（§4 R7），不再是风险；本项纯属整理，本轮不做 |
| OPT-2 | 让 `dist/main/dsh-app.patch.yml` 保持"可读的完整合成结果"，探针无需改动 | `[ ]` | 见 §4 R5 |
| OPT-3 | 给 `writeSuitePatchFile` 一族补"内核写者"契约测试，防回归 | `[ ]` | 已由 P0-3 部分覆盖 |

---

## 3 专项：外壳不再重建 profile patch

### 3.1 现状为什么必须重建

因为桌面宿主持不到别的通道：`@deepseek-ai/dsh-desktop-host/lib/index.js:221`
`loadProfileDirectory("dsh", projectDir, installAnchor)` 只读三样东西——profile 的清单、
它的 bundle 层、以及 `<profile>/cordis.patch.yml`。`[实测]`

两种 transport 的 argv 都不传补丁参数：
`src/main/desktop-host.ts:615 webShapeArgs()` 与 `:569 shapeArgs()`，均无 `--patch`。`[实测]`

所以今天套件的行**只有**写进那个文件这一条路。而那个文件现在是内核的。

### 3.2 目标形态

把套件的行移进**profile 自己拥有的 bundle 层**。内核本来就为每个声明的 bundle 加载一个
补丁文件（`dsh.bundle.patch`），而 profile 的 bundle 列表就在它的 `package.json` 里。
外壳此后不再写 `cordis.patch.yml`，内核成为唯一写者。

```
$DSH_HOME/profiles/dsh-app/
  package.json          bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app,
                                 @dsh-app/suite-layer]
  cordis.patch.yml      内核的文件 —— 外壳不再写
  node_modules/@dsh-app/suite-layer/
    package.json         { dsh: { bundle: { patch: './cordis.patch.yml' } } }
    cordis.patch.yml     随包 overlay（今天第 1 段承载的那些行）
```

物化按内容比对、走既有的原子 rename，所以无事可做的启动不碰任何文件——与
`writeSuitePatchFile` 今天的行为纪律一致。

**新层的补丁文件必须是顶层 YAML 数组**，这一条是硬约束 `[实测]`：

```
$ node scratch/probe-bundle-parse.mjs
抛错  套件插件今天自带的 {} → dsh: overlay … must be a top-level YAML array of loader patch entries
OK    空数组 []            → 0 条 patch
OK    真实 overlay（数组）  → 1 条 patch
```

顺带记一个**现存隐患**（与本次修复无关，但是同族错误）：15 个套件插件自带的
`cordis.patch.yml` 内容都是 `{}`，而内核要求数组。今天它们不会被读到（包名不在
`dsh.profile.bundles` 里，所以 `loadProfileDirectory` 从不加载它们），属于死文件；
但一旦有人把某个套件插件列进 bundles，就会立刻抛错。方案落地时不要复用这些文件，
也不要把插件本身列成 bundle——**新层的补丁文件写数组**。

**可行性已用内核自己的 loader 验证（非推演）** `[实测]`：

| 验证点 | 结果 | 探针 |
|---|---|---|
| 本地 bundle 层能解析、加载并进入组合 | 能，6 行 | `scratch/probe-bundle-layer-feasibility.mjs` |
| 后列 bundle 能覆盖先列 bundle 插入的行（`web`/`deepseek-account` 依赖此条） | 能 | `scratch/probe-layer-precedence.mjs` |
| profile 自己的行仍压过套件（按**索引**验，不是按计数） | 是 | 同上 |
| 内核能否把设置存到套件拥有的行上 | 能，且压过层 | `scratch/probe-overlay-owned-row.mjs` |

### 3.3 各段落的去处

| 今天 | 之后 |
|---|---|
| 第 1 段：随包 overlay | 进 bundle 层的补丁文件 |
| 第 2 段：profile 已携带的行 | **原地不动**——那已经是内核的文件 |
| 第 3 段：home 层副本（仅 frames 线） | 保留为副本；frames 宿主不组 home 层，副本必须存在于宿主会读的地方。**首次缺失时写一次，之后永不重建** |
| 市场托管块 | 不变；它本来就追加在所有内容之后并能幸存 |
| 尾部标记 | 随重建一起消失；读侧容忍保留到过渡结束（P2-1） |

### 3.4 迁移（风险最大的一步）

老 profile 里还留着套件的行，加上新层就是**同 id 两条**。**先更正一处原判**——
本文档初版写的是"不做迁移就是 `duplicate loader entry id`"，那是错的：

```
$ grep -rl "duplicate loader entry" <解压后的 0.1.7-rc.2 内核全树>       [实测]
(空 —— 该错误串在当前内核线里不存在)

$ node scratch/probe-dup-outcome.mjs                                     [实测]
组合出的条目数: 2  (同 id 两条并存)
顺序: ["NEW-from-layer","STALE-from-profile"]
生效的是列表末尾那个 → profile patch 的 STALE 副本
```

当前线（0.1.7-rc.2）的 loader 是这样处理同 id 的（`cordis-plugin-loader/lib/index.js`）
`[实测]`：

- `applyEntryPatches`（`dsh-app-boot/lib/index.js:61`）：`insert` 走 `data.push(...insert)`，
  **纯追加，不看是否已有同 id**；只有非 insert 的普通行才走 `entryMap.get(id)` 做覆盖。
- `Loader.update()`（`cordis-plugin-loader:78`）：`Object.fromEntries(config.map(o => [o.id, o]))`
  —— **同 id 后者胜**。
- `create()`（`:59`）：`this.tree.store[id] ??= new Entry(...)` —— 同 id 复用同一个 Entry 对象。

而组合顺序是 bundle 层在前、profile patch 在后
（`readProfilePatches`，`dsh-app-boot/lib/index.js:1024-1028`）。所以**留下套件行不会崩，
而是静默遮蔽**：profile patch 里那份旧副本压住层里更新过的 config。这比崩溃更难发现——
套件升级后改的行不生效，且没有任何报错。

`CHANGELOG.md:468` 与 `docs/kernel-0.1.7-alpha.1-regression.md:3364` 里记的
`duplicate loader entry id` 是**旧内核线**的行为，不是当前线。所以：

**第一次改判：不按 id 清单匹配** `[实测]`

```
$ node scratch/probe-strip-by-section.mjs
preserved 段里的根级条目数: 9        ← 用户的 9 条
tail 段里的根级条目数:      1        ← 市场的 1 条

一个 "- insert:" 块：其首个嵌套 id = brand
  → 按 id 匹配只能靠这个"首个嵌套 id"代表整块，判据本身就是脆的
一个 "- insert:" 块：其首个嵌套 id = schedule
```

第 1 段里有两个 `- insert:` 块（16 个套件插件 + `schedule`），它们的子条目形如
`    - id: x`（缩进两级），**不是根级行**。若按"根级 `- id:` 是否在清单内"匹配，
这两个块会被漏掉（它们的根级行是 `- insert:`，不是 `- id:`），而块内成员要靠缩进
解析才能知道——所以判定必须**按条目**做，不能只看根级行。

**第二次改判：不整段丢弃** `[实测]`

一度想改成"丢掉第 1 段整段"。那条判据会**连用户设置一起丢掉**：

```
$ node scratch/probe-strip-hazard.mjs
suite 标记 at 867
内核的行   at 14511
preserved 标记 at 16347
内核的行落在第 1 段的文本范围内？ true

判据 X（丢掉第 1 段）后，设置还在吗？ false
  → 会连用户设置一起丢掉：内核的行就落在第 1 段的文本里
```

原因正是本缺陷本身：**内核追加的行落在第 1 段的文本范围内**（路径 A）。所以"第 1 段
整段是外壳的"这个前提，在**已经跑过 0.1.7 的 profile 上不成立**——第 1 段里可能混着
内核写的设置行。

**第三次改判（评审纠正）：只摘 insert 块，非 insert 行一律保留** `[静态]`

按 id 一刀切还有一个**会丢用户数据**的错误：`web` 与 `deepseek-account` 在 overlay 里是
**非 insert 的 config 覆盖行**（`plugins/dsh-app.patch.yml:199,215`），它们不创建条目、
不产生重复，而正是**内核就地编辑、承载用户当前选择**的行——用户的搜索 provider 选择与
账号身份行就存在那里。按 id 摘掉它们，等于把用户的选择恢复成 overlay 默认值。

最终判据：

| 形态 | 处理 | 依据 |
|---|---|---|
| `- insert:` 块（内部 id 全在 overlay 名单内） | **摘除** | insert 是纯追加（`applyEntryPatches`），重复的唯一来源 |
| 非 insert 行（含 `web` / `deepseek-account` / `session-query-sqlite`） | **保留** | 后组成的非 insert 行压过先行的层行（`probe-layer-precedence.mjs`），且 profile patch 组成在最后；内核此后就地编辑它们，稳态成立；回滚线上 override 对不存在的行是 no-op（`plugins/dsh-app.patch.yml:240-268` 自己的注释），无启动风险 |

> 2026-09-28 更正：`ui-schedule` 从上面第二行移到**成立**的行——它现在随套件 insert
> （`plugins/dsh-app.patch.yml:269`），不再是改写上游禁用行的 override。原因是 0.2.0 的
> web bundle 不再携带该行（改由 `@deepseek-ai/dsh-experimental-schedule-bundle` 提供，本
> profile 不列它），override 于是没有目标：每次启动两条 `patch: entry "ui-schedule" not
> found`，日程页静默缺失。实测两条线：0.2.0 上警告归零且行回到组合树；0.1.7-rc.2 上组合树
> 多出一行同 id，生效的仍是最后那行（enabled），与改写上游行等价。
>
> 2026-09-28 又一条（当天稍晚）：老 profile 里那份非 insert 行**也不再保留**，改由
> `stripSuiteRows` 按 `isSpentFlipRow` 摘除——它没有 config（内核的编辑器每写一个设置都会带
> config，写完再清空会把整行删掉），只声明一个 id，且那个 id 是当前 overlay **以 insert 声明**
> 的，`disabled` 状态又与层里那行一致。三个条件缺一不可：只摘「与层里那行同状态的残留」，
> 带 config 的行（用户的设置）与 `disabled: true` 这种用户决定一律保留。原因是**安全模式**：
> 那条路径写的层是空的，残留在那里重新打出 `patch: entry "ui-schedule" not found`。
> 实证：真实 profile 的副本上迁移只摘了 `ui-schedule` 一个 id、留了 `.pre-suite-layer-*` 备份、
> 组合树不变；副本切到安全模式（空层）后 dump 的 stderr 为空。

摘除单位是**块**不是行：`plugins/dsh-app.patch.yml:87-183` 是一整块携带 16 个条目，
`:269` 是携带 `schedule` 与 `ui-schedule` 的另一块。既有的 `PATCH_ROW_LINE` 分块机制
（`src/main/brand-suite.ts:652-669`）可直接用。内核编辑器**从不写 insert 行**
（`config-editor:92` 的 `findLastIndex` 只匹配无 `insert` 的行），所以 patch 里的 insert
块只能来自外壳旧的第 1 段，不会误伤用户手写的第三方 insert 块（其 id 不在名单内）。

**保留哪些、丢弃哪些，一句话**：`insert` 块且内部 id 全在 overlay 名单内 → 丢掉；
**其余一切原样保留**（含非 insert 的 overlay 行、内核设置行、用户手写行、市场块）。


**摘除步骤**：

1. 读 profile patch，按上表判定：**`insert` 块（内部 id 全在 overlay 名单内）整块摘除**；
   其余一切原样保留。落在第 1 段里的非套件行要**挪进 preserved 段**，不能随段落丢弃。
2. 对 preserved 段跑**最后一次** `filterUnresolvableRows`（含 `restoreCommentedRows` 的
   解除注释判定），然后外壳永不再碰这个文件。理由：改造后没有任何东西再解除
   `NOT LOADED` 注释（`src/main/brand-suite.ts:933`），而这是旧判据留下的错注释唯一的
   恢复时机。这一步之后 `filterUnresolvableRows` 只保留 home 层审计的用法
   （`unloadableRows` → 失败卡，`src/main/index.ts:1005-1009`）。
3. 结果先落一份 `.pre-suite-layer-<时间戳>` 副本，再经 `writePatchAtomically` 写入
   （既有 tmp+rename），与 `keepUnlocatableTailAside`（`src/main/brand-suite.ts:1181`）
   对无法复现的文件所做的处置一致。
4. 只有在摘除落盘之后，才把 bundle 条目加进 profile 清单。

顺序不能颠倒，但理由与初版不同：不是"避免崩溃"，而是**避免静默遮蔽**。中间失败时先摘行
再挂层 → 少一组行（可恢复，下次启动补上）；先挂层再摘行 → 两份 config 并存，层里那份被
profile patch 的旧副本压住且无任何报错。**宁可少一行，不可多一行。**

**迁移的触发谓词必须是自己的**：`isSuiteProfileReady` / `hasSuiteProfileManifest` 的
already 短路（`src/main/suite-profile.ts:371`、`:457`）意味着一个老 profile **永远等不到
种子流程**。判据用"manifest 里缺 suite-layer 条目"，不要挂在既有的 ready 检查上。


### 3.5 必须保留的回退

读 profile 为**已安装树**的内核线（0.1.5 及更早，`host.profileAnchor === 'profile'`）从
profile 自己的 `node_modules` 解析 bundle，而那些包由镜像提供。因此：

- bundle 层必须写在**镜像之后**；
- 套件层缺失时 profile 仍要能启动，而不是启动失败——那时行只是缺席（即今天的 vanilla UI
  降级），不是新的失败形态。

### 3.6 物化时机与清单形态（不可颠倒）

启动顺序（`src/main/index.ts`）`[实测]`：

```
:966  ensureSuiteProfile()
:973  healProfileBeforeStart(profile.dir)      ← 会跑 dsh plugin --profile dsh-app install（pnpm）
:989  prepareBrandSuite(...)                   ← 写补丁层 / 链接套件插件
:1029 mirrorRuntimeIntoProfile(...)            ← 仅 profile-anchor 线
:1033 dropRuntimeMirror(...)                   ← 仅 runtime-anchor 线
:1054 dropForeignProjection(...)
```

两条约束由此确定：

1. **套件层必须物化在 heal 之后**——heal 驱动的 `pnpm install` 会剪掉不认识的条目
   （`src/main/brand-suite.ts:40-46` 已记录这一行为，这也是套件插件每启动重链的原因）。
2. **套件层不能进 `dependencies`，只作模板条目。** 内核的 `readProfilePlugins`
   （`dsh-app-boot/lib/index.js:1061`）把 `dependencies` 里声明了 `dsh.bundle.patch` 的包算成
   bundle；而 `reconcileProfilePlugins`（`:1105`）会按 `dependencies` × 主题保留规则重写
   `dsh.profile.bundles`。一个既有依赖条目、又不在主题清单里的包会被丢弃。套件层因此与
   `@deepseek-ai/dsh-base` / `dsh-web-app` 同类：**只出现在 `bundles` 列表里，不出现在
   `dependencies` 里**（`src/shared/constants.ts:30` 的 `SUITE_PROFILE_BUNDLES` 就是这两条）。

  这一条是本次审查新发现的约束，进 §9 台账（阶段 0）。

### 3.7 安全模式与其它开关的对应改造

安全模式今天的机制是 `suite: !safeModeActive`（`src/main/index.ts:993`）传给
`prepareBrandSuite`，由它决定是否把随包 overlay 写进第 1 段。方案下第 1 段不再存在，
所以这个开关的含义变为：**是否把套件层挂进 `dsh.profile.bundles`**。

- 进入安全模式：从 bundles 列表里**摘掉**套件层（行随之整体缺席），profile patch 与
  home 层照常加载；
- 退出安全模式：把套件层挂回去。

这条改造必须在同一提交里完成，否则安全模式会失效——而安全模式正是"套件坏了"时的唯一
逃生口（`src/main/safe-mode.ts` 的模块注释写明它由启动失败对话框与托盘菜单共同写入）。
对应审查项 R9。

同理需要跟着改的还有 `homeRowsInProfilePatch`（`src/main/brand-suite.ts:350`）：它今天
决定第 3 段是写副本还是写占位说明。方案下第 3 段只剩 frames 线需要（§3.3），判据本身不变，
但它的调用点要跟着 §3.6 的顺序调整。

---

## 4 审查项

> 除 §2.0 的六问之外，本缺陷还有下列专属审查点。每条都要给出**可证伪的判据**，不接受
> "看起来没问题"。

| 编号 | 审查点 | 判据 | 状态 |
|---|---|---|---|
| R1 | 迁移是否只摘套件拥有的行 | 构造一个含用户手写行 + 套件行 + 内核设置行的文件，迁移后用户行与内核行逐字节不变 | `[x]` |
| R2 | 迁移中断是否自愈 | 在步骤 1 与 3 之间强杀，下次启动后每个 id 恰好一条，且层里的 config 生效（不是被 profile patch 的旧副本压住） | `[x]` |
| R3 | overlay 拥有的行（`web`/`deepseek-account`）在改造后仍可被内核编辑 | 改设置 → 重启 → 值仍在，且等于用户所选而非层里的值 | `[x]` |
| R4 | frames 线的 home 副本不回到"每次重建" | 该线下连续两次启动，第二次不写文件（mtime 不变） | `[x]` |
| R5 | 探针与门禁仍能拿到它们要读的东西 | `scripts/probe-settings-nav.cjs:29`、`probe-chrome-surfaces.cjs:26`、`smoke-package.mjs:25` 全绿 | `[x]` |
| R6 | profile-anchor 线上层与镜像的先后 | 镜像先、层后；层缺失时不启动失败 | `[x]` |
| R7 | 市场托管块不再吞内核行 | 块内与内核设置行同 id 时，启用不连带删设置行、禁用不静默失效 | `[x]` 本轮已修，机制见下（与初版描述不同） |
| R8 | 套件名册五处一致 | `npm run check:graph` 两行预期输出 | `[x]` |
| R9 | 安全模式仍能只丢套件行 | 进入安全模式启动，用户行与内核行都在，套件行缺席 | `[x]` |
| R10 | 幂等：无事可做的启动不写文件 | 连续两次启动，第二次该文件 mtime 不变 | `[x]` |

**各条的实测证据**（对应上面的状态）`[实测]`：

| 编号 | 证据 |
|---|---|
| R1 | `test/suite-layer.test.mjs`「a start-up pass never drops a row it does not own」：第三方 insert、用户行、内核设置行三类都不动 |
| R2 | 「the migration is idempotent」+「does not modify the profile patch once it has settled」；中断后下次收敛由内容比对保证 |
| R3 | `test/profile-patch-kernel-rows.test.mjs`「a setting stored on a row the SHIPPED OVERLAY itself carries survives」：`web` 与 `deepseek-account` 的存储值都还在 |
| R4 | frames 线保留旧写入器（`layer` 选项为 false），home 副本行为未变——冻结风险不存在 |
| R5 | `dist/main/dsh-app.patch.yml` 仍是物化源；`npm run verify -- --tgz runtime-dist/…0.1.7-rc.2.tgz` 输出 `smoke: all checks passed` |
| R6 | `installSuiteLayer` 调用点已移到镜像/投影之后；`scratch/probe-mirror-vs-layer.mjs` 证镜像只遍历 source 条目、层不在其中，`dropRuntimeMirror` 另有 `PLUGIN_SCOPE` 显式跳过；`scratch/probe-gate.mjs` 证"声明了但解析不到的 bundle"是跳过降级、不拒启动（真实宿主 `dsh-desktop-host:221-223` 只打印 `reportSkippedBundles` 后继续） |
| R8 | `npm run check:graph` → `plugin graph: 16 plugins, followed line ^0.1.7-rc.2` / `ok — no violations`（本次不增删插件） |
| R9 | 安全模式写**空层**而保留 bundle 声明（`overlay: ''` → 层内 `[]`），清单不随切换churn；采纳评审的解法 |
| R10 | 「does not modify the profile patch once it has settled」：连续两次启动，第二次 `status: 'already'` 且 mtime 不变 |

**R7 已修（2026-09-28，本轮）——机制与本文档原先的描述不同** `[实测]`

本文档原先写的是"市场切换时替换整段 span，块内的内核行会被一起吃掉"。**穷举探针否掉了这个
说法**：把"内核行在块内的四种位置 × 四种切换动作"两两组合（20 组），内核行**零丢失**
（`scratch/probe-r7-exhaustive.mjs`）。原来的描述是推断，不是实测。

真实机制是**按 id 过滤**，只在一种组合下发生，而那种组合四步全在面板里可达：

```
① 用户禁用第三方插件 P     → 市场写块：- id: P / disabled: true
② 用户改 P 的设置           → 内核追加一行；块在文件尾，于是落进块内
                             → 块内出现**两条 id=P 的行**
③ 用户重新启用 P            → 市场 kept = rows.filter(row => row.id !== entryId)
                             → 两条一起删 → 用户的设置没了（实测 theme: dark 消失）
```

还有**反向的第二个缺陷**：块内只有内核的 config 行时，`target = rows.find(row => row.id === entryId)`
命中那条 config 行 → 直接 `return patchText` → **禁用静默不生效**（面板以为写了，实际没写）。

**修法**（`plugins/plugin-market/src/patchfile.ts`）：给行加归属判定 `own` —— 只有
**裸 disable 行**（`- id: x` 下只有 `disabled: true`）才是市场自己的；带 `config:` / `name:`
的是别的写者的行，一律不动。两处判定改用它：

- `const target = rows.find(row => row.id === entryId && row.own)`
- `const kept = rows.filter(row => row !== target)`（按**行**而非按 id）

**反证**（测试不是空转）：把这两行改回原样，插件市场测试 **4 项失败**；改回修复后 **209/209 通过**。
新增 4 条测试（`plugins/plugin-market/tests/toggle.test.ts` 的 "the kernel's rows inside the block"）。

顺带修好的一条**用户可见**问题：块内夹着用户自己的注释时，原先启用会连注释一起丢——现在保留。


**修复前记录的对照事实**：market 块是文件末尾时，内核的行会落进该块内部。当时能幸存（市场的
但设置行被当成托管条目携带本身是脆弱的：

```
$ node scratch/probe-market-block.mjs
# ── plugin-market managed disables ──
- id: some-third-party
  disabled: true
- id: ui-theme
  name: "@deepseek-ai/dsh-ui-theme"
  config:
    preference: dark
# ── end managed ──
```

---

## 5 回归清单

### 5.1 自动门禁（**裸跑，不走管道**）

```sh
npm run typecheck
npm run build
npm test                                               # 含新回归文件，期望 443 → 全绿
npm run check:graph                                    # 期望：plugin graph: 16 plugins … / ok — no violations
npm run verify
npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-*.tgz
npm run check:plugins -- --kernel <runtime.tgz> --home <真实 DSH_HOME>
```

**新回归文件的契约**（`test/profile-patch-kernel-rows.test.mjs`）：

- 用**内核自己的文档 API** 驱动写入（`parseDocument` → `document.add` → `String(document)`），
  不用字符串拼接——这正是旧测试失效的原因；
- 断言只断言**结果**（值还在），不断言**机制**（必须落在某区段）。修法若是取消重建，
  这些测试同样应该通过；断言机制会给未来的正确解设障；
- 断言走**结构化读文档**，不用 `includes()`。反例：随包 overlay 的注释里就写着
  `deepseek-official`，字符串匹配会假通过（本次已实测踩到）；
- `yaml` 从**内核包锚点**解析（`createRequire('@deepseek-ai/dsh-config-editor/package.json')`），
  不用根目录那份；内核包缺失时 `skip` 而非报错。

### 5.2 实机回归

**状态列收尾时填**：`[x]` = 有可查证据；`[~]` = 只有一半；`[ ]` = 没做，要人眼；
`[!]` = 待用户决定；`[–]` = 改了归属。

| 编号 | 步骤 | 预期 | 状态 |
|---|---|---|---|
| M1 | `DSH_APP_DEV_KERNEL=<runtime> npm run dev` 到主界面 | host ready；无 `plugin tree failed to load` | `[ ]` |
| M2 | 设置 → 通用 → 外观 → 深色 → 退出 → 再启动 | **设置仍在**，界面从启动起就是深色 | `[ ]` |
| M3 | 改任一套件设置（并行子代理的起始并发 / 网络搜索 provider）→ 重启 | 值仍在 | `[ ]` |
| M4 | 老 profile（含套件行的）首次启动 | 每个 id 恰好一条；层里的 config 未被 profile patch 的旧副本压住 | `[ ]` |
| M5 | 迁移中途强杀 → 再启动 | 收敛，无双树、无启动失败 | `[ ]` |
| M6 | 进入安全模式启动 → 退出 | 用户行与内核行都在，套件行缺席 | `[ ]` |
| M7 | 连续两次启动，比对 profile patch 的 mtime | 第二次不变 | `[ ]` |

### 5.3 明确不在本轮范围

- 内核自身把设置存进 profile patch 这一设计（上游决定，不 fork）。
- 第三方插件把自己的偏好写进窗口 localStorage（与内核线绑定，`src/main/client-state.ts`
  在换线时清空）——另立任务。
- `$DSH_HOME/settings.yaml` → profile 行的一次性导入（内核行为，已正确）。

---

## 6 未验证项与残余风险

| 项 | 状态 / 原因 | 影响 |
|---|---|---|
| 未在真实 Electron 应用里端到端验证 | **已做 M1/M2**（隔离 `DSH_HOME` + 真 runtime，见 §9 阶段 5）；**M3–M7 仍未做** | 界面侧（改主题后重启是否仍深色、安全模式是否只丢套件行）仍待人眼 |
| 迁移的摘行算法 | **已实现并测试**（`stripSuiteRows` + 22 项用例） | — |
| 名册收缩（`plugin-fff` 那类） | **已修**：归因加 `@dsh-app/` scope 兜底。实测含 `fff` 的旧 17 条块现在能整块摘除；第三方块不受影响（§9 阶段 8，F3） | — |
| 旧版从未过滤过的 legacy 携带行 | **语义变更，已记录**：`restoreCommentedRows` 的自动恢复仍在（迁移时跑一次），但外壳**不再**为不可解析的行加注释兜底。今后这类坏行会以宿主失败卡 + 修复流程呈现，与 home 层同语义 | 用户看到的是失败卡而不是"静默少一行"；这是刻意的：兜底要跑全文档过滤，而它实测会摘内核设置行（§9 阶段 6） |
| frames 线是否仍是目标 | **本轮不做**：该线保留旧写入器，行为未变 | 该线若退役，可直接删掉 `writeSuitePatchFile` 一族 |
| 市场托管块（R7） | **本轮已修** | 真实机制是"按 id 过滤"（不是原先推断的"整段替换"）：块内出现与市场行同 id 的内核设置行时，启用会连带删掉设置行、禁用会静默失效。已按行归属判定修复，插件市场 209/209 通过（含 4 条新回归，反证：改回原样则 4 项失败） |
| `profile-heal` 驱动 pnpm 时是否会改写清单 | **已验**：`reconcileProfilePlugins` 的保留规则对不在 `dependencies` 里的名字返回 true——模板条目受显式保护（`scratch/probe-gate.mjs`） | 仍保留评审的缓解：每次启动读 manifest，缺条目就补并打日志 |
| 循环导入的求值顺序 | **已捕获并由测试兜住**：`suite-layer` 与 `brand-suite` 互相 import，模块级常量跨环求值得 `undefined`（实测名字变成 `undefined/suite-layer`）。已改为字面量，`test/suite-layer.test.mjs` 钉住两种加载顺序 | — |
| `filterUnresolvableRows` 的"最后一次"用法 | **发现并避免了一个数据丢失**：把它跑在整个文档上会摘掉内核写的设置行（实测：`dsh-agent-preset-registry`——记录所选预设的行——与 `dsh-client-ui-settings-account`，只因换了一个解析闭包）。已改为**只恢复外壳自己注释过的块**，绝不注释任何行 | — |
| `npm run verify`（裸跑，无参数） | **本机环境缺口，与本次改动无关**：它默认探 `../deepseek-harness` 检出，该检出有 9+ 个 client 包未构建（缺 `lib/client.js`）。以 `git stash` 移开全部改动后复跑，失败完全一致 | 用 `--tgz runtime-dist/dsh-runtime-win32-x64-0.1.7-rc.2.tgz` 替代，输出 `smoke: all checks passed` |

---

## 7 执行顺序与回滚

**顺序**（`src/**` 的改动带 `changesets/suite-layer-owns-the-rows.md` 片段）：

| 步 | 内容 | 状态 |
|---|---|---|
| 1 | 复现测试落地（3 项失败）——**先有会失败的测试，再改代码** | `[x]` |
| 2 | 迁移的读侧：摘行函数 + 单元测试（纯函数，不碰启动路径） | `[x]` |
| 3 | bundle 层物化模块（`suite-layer.ts`） | `[x]` |
| 4 | 接线：web 线挂层 + 迁移；frames 线保留旧写入器 | `[x]` |
| 5 | 自动门禁：typecheck / build / test / check:graph / changeset / verify --tgz | `[x]` 全绿（tests 450 pass / 0 fail） |
| 6 | 实机回归 M1–M7 | `[ ]` **待做**——这是交付前唯一剩下的验证 |
| 7 | 清理：frames 线退役后移除 `writeSuitePatchFile` 一族 | `[ ]` 待该线退役 |

**回滚**：步骤 2–4 各自独立可回滚。步骤 4 之后若要回退，需把套件行写回 profile patch
（迁移留有 `.pre-suite-layer-<时间戳>` 副本可依据），因此**副本的写入先于摘除落盘**——
这条顺序本身是回滚能力的前提，实施时不得为了少写一个文件而省略。已实现。

另有两条**必须记住的顺序约束**，它们是本次实施中冒出来的：

1. **层必须物化在镜像/投影之后**（评审提的 P1-3）。镜像写 profile 自己的 `node_modules`，
   层要落在它们已经安顿的树上。调用点已按此排列。
2. **套件层不能进 `dependencies`，只作 `bundles` 里的模板条目**（§3.6）。进了 `dependencies`
   就会被 pnpm 与 `reconcileProfilePlugins` 当成市场装的包，可能在协调时被丢。

---

## 8 决策记录

| 编号 | 决策 | 理由 | 日期 |
|---|---|---|---|
| D1 | 根因修法是**取消重建**，不是再修一次标记 | 补标记只能再买一轮：下一个内核字段、下一个写者都会重新触发。一个文件两个写者，边界不可能靠注释维持。评审补充了第二条更硬的理由：**竞态是重建模型的固有属性**——只要外壳"读→组装→写回"，内核或市场就可能在读与写之间落笔，外壳把陈旧快照写回就是丢失；单写者才整类消除 | 本次 |
| D2 | 迁移顺序：**先摘行、后挂层** | 中间失败时：先挂层 → 两份 config 并存，层里那份被 profile patch 的旧副本静默压住且无报错；先摘行 → 少一组行（可恢复）。理由见 §3.4 的更正 | 本次 |
| D3 | 复现测试**重指向**，不是"转绿" | **评审纠正**：我原写"取消重建则这 6 例同样通过"——不成立。它们的 arrange 就是被移除的机制（`composeSuitePatch`/`parseSuitePatch`），照原样只会继续测一条死路径、或被当成"已通过"删掉。已重写为 steady-state（内核写入后启动期不碰文件）+ 迁移形状（R1/R2） | 本次 |
| D4 | 市场托管块（R7）**本轮已修** | 原计划不做，后决定一并修掉。**机制与原判不同**：不是"整段替换吃掉内核行"（穷举 20 组零丢失，那是推断），而是**按 id 过滤**——块内出现与市场行同 id 的内核设置行时，启用连带删设置行、禁用静默失效。修法是给行加归属判定（只有裸 disable 行才是市场自己的），并按行而非按 id 过滤 | 本次 |
| D5 | 迁移只摘 `insert:` 块，非 insert 行一律保留 | **评审纠正**：`web`/`deepseek-account` 是 overlay 的**非 insert** 覆盖行，不创建条目、不重复，而正是内核就地编辑、承载用户当前选择的行。按 id 一刀切会把用户的搜索 provider 与账号身份复原成默认值 | 本次 |
| D6 | 不做"最后一次 `filterUnresolvableRows`" | 评审建议对第 2 段跑一遍以恢复旧注释。**实测否掉了半条**：把该函数跑在整个文档上会摘掉内核写的设置行（`agent-preset-registry` 记录所选预设、`ui-settings-account`），只因换了一个解析闭包。改为只**恢复**外壳自己注释过的块（`rowsToRestore`/`uncommentRows`），绝不注释任何行 | 本次 |

---

## 9 批判性审查台账

> 边做边填。每条格式：条目编号 · 六问回答 · 用到的命令与输出 · 结论。

### 阶段 0 — 开工前的主张复核

| 主张 | 复核结果 |
|---|---|
| "设置丢失存在" | **成立**。`probe-fresh-install.mjs` 全新 profile 下四项设置全丢 `[实测]` |
| "本机不受影响" | **成立**，但原因是运气：第 2 段有用户行。不是设计属性 `[实测]` |
| "标记机制本身是错的" | **成立**。内核用 YAML 文档 API，注释不构成边界 `[实测]` |
| "现有测试覆盖了这条路径" | **不成立**。`log-redaction.test.mjs:214` 建模的是内核不会做的写入 `[实测]` |
| "迁移不做就是 `duplicate loader entry id`（整树拒绝加载）" | **不成立，已改**。当前内核线全树搜不到该错误串；loader 对同 id 的语义是**后者覆盖**（`applyEntryPatches` 的 insert 是纯追加，`Loader.update()` 用 `Object.fromEntries` 建表取末条），而 profile patch 排在 bundle 层之后。故真实后果是**静默遮蔽**——层里的 config 被旧副本压住且无报错。摘行的理由随之改写，但"必须摘"的结论不变。见 §3.4 `[实测]` |
| "改标记就能修" | **不成立**（D1）。一个文件两个写者，边界不可能靠注释维持；下一个内核字段会重新触发。这是本文件推翻的第一个方案 |
| "套件层可以像普通依赖那样进 `dependencies`" | **不成立**。启动顺序 `heal(973)` 在 `prepareBrandSuite(989)` 之前，且 `reconcileProfilePlugins` 会按 `dependencies` 重写 `bundles`——套件层只能作模板条目、且必须物化在 heal 之后。见 §3.6 `[实测]` |
| "套件插件自带的 `dsh.bundle.patch` 可以直接拿来当新层" | **不成立**。15 个插件的 `cordis.patch.yml` 内容都是 `{}`，内核要求顶层是数组，直接列进 bundles 会抛错。新层必须自写数组形态的补丁文件（§3.2）`[实测]` |
| "迁移摘行应按 id 清单匹配" | **不成立，已改（评审纠正）**。两个理由：① 第 1 段的 `- insert:` 块成员是缩进两级的子行，只看根级行会漏掉整块；② 更严重——`web`/`deepseek-account` 是**非 insert 的 config 覆盖行**，不创建条目、不会重复，正是内核就地编辑、承载**用户当前选择**的行。按 id 一刀切会把用户的搜索 provider 选择与账号身份行一次性抹掉。改为**只摘 insert 块**（§3.4）`[静态]` |
| "迁移 = 丢掉第 1 段整段" | **不成立，已改**。内核追加的设置行**就落在第 1 段的文本范围内**（路径 A），整段丢弃会连用户设置一起丢（`probe-strip-hazard.mjs`：丢弃后 `preference: dark` 消失）。改为"逐条判定 + 把非套件行挪进 preserved 段"（`probe-strip-safe.mjs`：两条设置行都被救回）`[实测]` |
| "手加的 bundle 条目会被内核 CLI 协调丢掉" | **不成立**（评审提出的门槛，已验）。`reconcileProfilePlugins` 的保留规则对**不在 `dependencies` 里**的名字返回 true——模板条目受显式保护。`probe-gate.mjs` 实测 `@dsh-app/suite-layer` 幸存。仍采纳评审的缓解：每启动读 manifest、缺条目就补 + 打日志 `[实测]` |
| "声明了但解析不到的 bundle 会让宿主拒绝启动" | **不成立**（评审提出的门槛，已验）。真实宿主 `dsh-desktop-host/lib/index.js:221-223` 调 `reportSkippedBundles`（只往 stderr 写一行、不 throw）后继续 `runProfile`；`loadProfileDirectory` 的 per-bundle `try/catch` 把 `resolveBundleDir` 的抛错收进 `skippedBundles`（`probe-gate.mjs`：layers 0 / skippedBundles 1 / 不抛错）。故套件层缺失是**静默降级为 vanilla**——但无声，外壳必须自己补一行日志 `[实测]` |

### 阶段 1 — P0 批（P0-1 … P0-3）

| 编号 | 状态 | 审查回答 |
|---|---|---|
| P0-1 | `[x]` | **主张复核**：成立——外壳确实不再写 profile patch（`installSuiteLayer` 只在迁移那一次写，之后 `start()` 返回 `already`）。**最小性**：新增 `src/main/suite-layer.ts` 一个模块，`brand-suite.ts` 加 `layer` 选项，`index.ts` 加一次调用；未重构无关代码。**新风险**：新引入 bundle 依赖，见 P1-1。**边界**：空 overlay（安全模式）、CRLF、无 insert 块的老文件、循环导入两种加载顺序，都有测试。**证据**：`test/suite-layer.test.mjs` 9 项全绿；`scratch/probe-real-runtime.mjs` 用真实 runtime 闭包组合出 199 条目、16/16 套件插件、`web` 恰好一次。**反例**：若内核将来改变 bundle 层与 profile patch 的**组合顺序**（现为层在前、profile 在后），套件对 `web` 的覆盖会失去效果——当前由 `readProfilePatches` 的数组顺序保证，内核升级时需复验。 |
| P0-2 | `[x]` | **主张复核**：评审纠正成立——按 id 一刀切会摘掉 `web`/`deepseek-account` 两条**非 insert** 行，那是用户当前选择的载体。已改为只摘 `insert:` 块。**最小性**：复用既有 `contentIndent` / `PATCH_ROW_LINE` 的分块思路，未引入 YAML 解析器。**新风险**：归因判据含"名单"与"scope 兜底"两条；名单从 overlay 动态读（`overlayOwnedIds`），scope 兜底覆盖名册收缩（§9 阶段 8 F3）。**边界**：第三方块、混合块、CRLF、幂等、空行边界、散文块、兄弟字段，均有测试。**证据**：`scratch/probe-strip-real.mjs` 对本机真实 profile 摘 17 条、用户行与内核设置行零丢失；`scratch/backup-kernel-0.1.7-20260922` 里含 `fff` 的 18 条旧块也能整块摘除。**反例**：用户若手写了一个 id 恰好与 overlay 相同、或 name 全指向 `@dsh-app/` 的 insert 块，它会被当套件的摘掉——但那些 id 本来就该由层提供，实为纠正而非损失。 |
| P0-3 | `[x]` | **主张复核**：**评审说对了**——我原以为"取消重建则这 6 例同样通过"不成立。原测试的 arrange 就是被移除的机制（`composeSuitePatch`/`parseSuitePatch`），已按 R1/R2 形状重写为"内核写入后启动期不碰文件"。**最小性**：只重写这一个文件。**新风险**：无。**边界**：全新 profile / 已跑过 0.1.7 的 profile / 连续两次写入 / 自有行不丢，四类。**证据**：`test/profile-patch-kernel-rows.test.mjs` 5 项全绿（此前 3 项失败）。**反例**：测试不再覆盖"行落在文件哪个区段"——那已不是契约；若将来有人重新引入重建，这些测试会在"启动期不碰文件"那条上失败。 |

### 阶段 2 — P1 批（P1-1 … P1-3）

| 编号 | 状态 | 审查回答 |
|---|---|---|
| P1-1 | `[x]` | **主张复核**：迁移顺序（层→摘行→清单）已实现，且**副本先于摘除落盘**。**新风险**：中途失败留下"层已写但清单没挂"→ 套件行缺席、界面 vanilla，下次启动修复；这个方向是刻意的（宁可少一行，不可多一行，因为层与 profile patch 并存时后者静默胜出）。**边界**：内容比对幂等，第二次启动 `status: 'already'` 且 mtime 不变（有测试）。**证据**：`test/suite-layer.test.mjs`「the migration is idempotent」+「start-up pass does not modify the profile patch once it has settled」。**反例**：若 `writePatchAtomically` 与随后的清单写入之间进程被杀，且用户此后**手动**改 profile patch，下一次迁移仍会收敛（摘除是按内容判定的），无残留风险。 |
| P1-2 | `[x]` | **主张复核**：成立——写只发生在启动期、spawn 之前，且安顿后不再写（mtime 测试为证）。**证据**：「does not modify the profile patch once it has settled」按字节与 mtime 双重断言。**反例**：极端情况下市场插件在宿主运行时改**同一个** profile patch 的尾部（它自己的托管块），那是市场与内核之间的事，外壳已退出该文件。 |
| P1-3 | `[x]` | **主张复核**：评审要求的"物化在镜像之后"已落实——`installSuiteLayer` 调用点移到 `mirrorRuntimeIntoProfile`/`dropRuntimeMirror`/`dropForeignProjection` 之后。**证据**：`scratch/probe-mirror-vs-layer.mjs` 证明镜像只遍历 source（runtime 树）的条目，层不在其中；`dropRuntimeMirror` 另有 `PLUGIN_SCOPE` 显式跳过（`suite-profile.ts:979-999`）。**反例**：若将来镜像改为"先清空 target 再灌"，层会被清掉——届时需要把层重新物化到镜像之后（当前顺序已保证）。 |

### 阶段 3 — 审查项（R1 … R10）

**状态与证据记在 §4 的审查项表**（不在此处重复：两份都写状态的清单迟早互相矛盾，而"以为某条被审过"正是最贵的错）。本节只记结论：R1–R10 全部通过并附证据；R7 在本轮一并修掉，其真实机制与原判不同（见 §4 R7）。

### 阶段 4 — 自打边界抓到的三个缺陷（实施中修复）

按评审角度自打时撞到的，都在实施过程中修掉并加了测试：

| 缺陷 | 触发 | 后果 | 修法 |
|---|---|---|---|
| 注释块里的散文被恢复成代码 | 被注释的块内夹着用户列 0 注释 | 恢复后**非法 YAML** → 内核拒绝启动（比原缺陷更坏） | 补 `rowShaped()` 守卫（原 `brand-suite.ts:1009-1011` 有，我重写时漏了），两个函数共用 |
| 同缩进的兄弟字段被当子行丢掉 | `- insert:` … `  extra: 1`（同一元素的两个字段） | 丢用户写的键；或留下悬空键 → 非法 YAML | 用既有的 `contentIndent`（把 `- ` 计作两列）判定内容列；有兄弟字段则整块保留 |
| 列 0 注释被误判为兄弟字段 | 随包 overlay 在 insert 块后放了整段列 0 注释 | **真实 profile 的摘除量从 17 条打回 1 条** | 注释不算兄弟；且随块摘除后**原样保留**（否则每次启动擦掉 overlay 自带的说明） |

三条都有对应测试（`test/suite-layer.test.mjs` 现 13 项）。最终判据三条：

1. 块内**非注释**且内容列 ≤ 块首列 → 兄弟字段 → **整块保留**（代价是重复条目，loader 折叠；
   另一方向是丢用户数据或起不来）
2. 块内**注释**（含列 0）→ 属于文件，摘块后**原样保留**
3. 其余（列表子项）→ 随块摘除

**畸形输入 10 种全部安全** `[实测]`：不抛异常、不产出新的非法 YAML；唯一被判"非法"的那例
（`- insert:` 后跟列 0 的非列表行）输入本身内核就会拒绝，实现原样不动、不会更坏。

### 阶段 5 — 真机启动（M1/M2）

**已做**（隔离 `DSH_HOME` + `DSH_APP_DEV_KERNEL` 指向解出的真 runtime，未碰用户 profile）`[实测]`：

```
[suite-profile] "dsh-app" profile created; …
[suite-layer] wrote the suite layer at …\profiles\dsh-app\node_modules\@dsh-app\suite-layer
[suite-layer] the profile's bundle list now names @dsh-app/suite-layer
[host] dsh host: web transport (host package 0.1.7-rc.2)
[host] dsh host ready (web transport)
```

产出的真实 profile：

```
bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","@dsh-app/suite-layer"]
```

在该真机产出的 profile 上模拟内核写设置 → 再跑一次启动期处理 → `ui-theme` 的
`preference: dark` 存活（`scratch/simulate-settings-write.mjs`）。

**M3–M7 仍未做**：需要人眼看着界面（改主题后重启是否仍深色、安全模式是否只丢套件行等）。

### 阶段 6 — 评审的两处更正（一条采纳、一条部分驳回）

**采纳**：`profile-heal.ts:5-6` 的 docstring 因果搞反了。实测（`scratch/probe-heal-causality.mjs`）：

```
bundle 名根本解析不到 → layers=1 skipped=1（放行，不拒绝）
只列一个不存在的       → layers=0 skipped=1（放行）
```

真正的拒绝路径是 `auditStartupEntries`（`dsh-app-boot:4008-4021`）：**必需条目**
（`agent-loop` / `webserver` / `modules` / `connection` …）未激活才抛 `StartupError`。
docstring 已按这个准确的因果改写。

**部分驳回**：评审建议"把最后一次 `filterUnresolvableRows` 折进迁移"。实测**否掉半条**——
把它跑在整个文档上会摘掉内核写的设置行：

```
旧实现（全文档过滤）会摘掉： @deepseek-ai/dsh-agent-preset-registry,
                            @deepseek-ai/dsh-client-ui-settings-account
```

原因是内核写的行命名的包**不是 profile 的依赖**，只在特定闭包里解析成功；换一个闭包就
把用户的设置（含记录所选预设的那一行）注释掉。于是只保留其**恢复**意图
（`rowsToRestore` / `uncommentRows`），**绝不注释任何行**。

### 阶段 7 — 常驻清理（评审的推论，已实测确认）

评审指出"摘行若只做一次，套件升级后 profile patch 里残留的旧代行会**永久压住**层里的新代，
且无报错"。实测确认（`scratch/probe-upgrade-masking.mjs`）：

```
swarm 条目数: 2   配置: [{"maxItems":64},{"maxItems":8}]
  → loader 折叠后生效的是列表末尾那个 = profile patch 里的旧代
```

实现上摘行**本来就在每次启动跑**（`installSuiteLayer` 每次 spawn 前调用，无 first-time 闸门），
所以形态已是常驻清理。三次启动、中间人为塞回整套 insert 块的实测（`scratch/probe-resident.mjs`）：

```
第 1 次: 摘除=0  设置行还在=false 还有 insert 块=false
第 2 次启动前：人为塞回整套 insert 块 + 一条设置行
第 2 次: 摘除=17 设置行还在=true  还有 insert 块=false   ← 常驻清理生效
第 3 次: status=already 摘除=0
```

### 阶段 8 — 评审的三个必修项（已修）

| 编号 | 缺陷 | 触发 | 后果 | 修法 |
|---|---|---|---|---|
| F1 | 注释块的**空行边界**把块劈成两半 | 被注释的行内部有空行（旧写入器对空行原样保留） | `id:`/`config:` 恢复而值仍注释 → `config: null` → patch 语义整对象替换 → **静默清空用户设置**（不是解析错误，更隐蔽） | 块边界改为"空行继续、止于下一个 marker / 段标记 / 第一个非空非 `#` 行"；`rowsToRestore` 与 `uncommentRows` 共用 |
| F2 | **安全模式在未迁移 profile 上不生效** | 安全模式传 `overlay=''` → 名单为空 → 摘行被跳过，但清单照样挂条目 | 组合 = base + 空层 + patch 里的旧套件行 → **套件仍然激活**，安全模式名存实亡（链接失败路径同理） | 名单**永远从真实 overlay 读**（与 `suite` 无关），`overlay=''` 只决定层文件内容。三条路（安全模式 / 链接失败 / 正常）共用同一迁移 |
| F3 | **名册收缩后整块永久残留**（最大的真实人群） | 旧 overlay 的 insert 块含 `plugin-fff`，该插件已从名册移除（`git show 3b2ce94~1:plugins/dsh-app.patch.yml:153`） | `ids.every(owned.has)` 永假 → 整块 17 条残留：16 个现役 id 与层重复（rc.2 上遮蔽、回滚线上拒绝）、残留块组成在后**永久压住**层、死 `fff` 行每启动告警、幂等被卡死 | 归因加 scope 兜底：全部 id 都指向 `@dsh-app/` 包也算套件自有。实测本机备份里含 `fff` 的 18 条块现在整块摘除；第三方块与混合块不受影响 |

**F3 的证据** `[实测]`：

```
$ git show 3b2ce94~1:plugins/dsh-app.patch.yml | grep -n fff
153:    - id: fff
154:      name: '@dsh-app/plugin-fff'

$ node -e "…stripSuiteRows(备份, owned)…"        # 修复前：摘 1 条（只剩 schedule）
摘除: 18 条 | 含 fff ? true                      # 修复后：整块摘除
```

**F1 的复验**（评审的探针 `scratch/probe-review-f1-f2.mjs`）`[实测]`：

```
修复前: rowsToRestore wants: ["web"] → 解析得 {"id":"web","config":null}   ← 静默清空
修复后: rowsToRestore wants: []      → 整块保持注释，文件仍合法
```

**F2 的复验**（同一探针）`[实测]`：

```
修复前: removed: []  → suite insert rows still in the patch: true  → 安全模式仍激活套件
修复后: removed: ["brand", … , "schedule"] → still in the patch: false
```

新增测试 4 条（现 `test/suite-layer.test.mjs` 17 项、`profile-patch-kernel-rows.test.mjs` 5 项，合计 22 项）。

### 阶段 9 — 安全模式的空层形态（评审提醒，实测无需改动）

评审提醒"空层必须是注释 + `[]`，空串/`{}` 会砸在 `dsh-app-boot:3565`"。实测
（`scratch/probe-empty-layer.mjs`）：

```
OK    '[]\n'      → 0 条      ← 本实现写的就是这个
抛错  空字符串     → must be a top-level YAML array
OK    '注释 + []'  → 0 条
抛错  '{}'        → must be a top-level YAML array
抛错  纯注释       → must be a top-level YAML array
```

本实现写 `[]\n`，已在通过之列，无需改动。


