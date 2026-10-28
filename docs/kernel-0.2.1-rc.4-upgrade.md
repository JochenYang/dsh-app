# 内核线 0.2.1-rc.4：只换依赖，无源码适配

> 执行 2026-10-28。上一轮记录在 [`kernel-0.2.1-rc.3-upgrade.md`](kernel-0.2.1-rc.3-upgrade.md)，
> 流程判据在 [`agents/kernel-line-regression.md`](agents/kernel-line-regression.md)。
> 本文只写这一轮新增的判断。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或包内容；`[待验证]` = 推断。
>
> 下一站（0.2.2-alpha.2，另一条线）的预适配结论在
> [`kernel-0.2.2-alpha.2-preflight.md`](kernel-0.2.2-alpha.2-preflight.md)，那份文档不进版本库，
> 只在正式版发布前查阅。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh → { alpha: 0.2.2-alpha.2, latest: 0.2.1-rc.2, next: 0.2.1-rc.4 }
我们的 spec：根 23 处 + 18 插件合计 380 处 ^0.2.1-rc.3 → ^0.2.1-rc.4
kernel-line 解析：{ spec: '^0.2.1-rc.4', channel: 'beta', tag: 'next', suiteVersion: '0809f4cc' }
cordis 4.0.5 / schemastery 3.18.5（rc.4 声明的 ~4.0.5 与 ~3.18.5 与我们的 ^4.0.4 / ^3.18.4 相容，未动）
```

rc.4 挂在 `next` 上，与 rc.1–rc.3 一样。它与 `0.2.2-alpha.2` 相差一分钟发布（rc.4 02:49:58Z，
alpha.2 02:50:54Z），是 0.2.1 线的收尾；alpha.2 是另一条线的开头，属跨线，见预适配文档。

## 1 这一轮改了什么：逐包比对 `[实测]`

沿用上一轮的方法：38 个 `@deepseek-ai/dsh-*` 包各下 rc.3 与 rc.4 两个 tarball，解包后按文件算
sha256，`package.json` 单独排除（它的版本与依赖指针本来就该变）。

- **35 个包逐字节相同**。
- **3 个包有改动**，且都只在客户端半：

| 包 | 改动 | 打到我们吗 |
|---|---|---|
| `dsh-client-modules` | `lib/index.js` | 否。我们只用它装载模块，接口未变 |
| `dsh-client-ui-conversation` | `lib/client.js`、`lib/types/client/locales.d.ts`、README | 否。我们没有替换它的渲染器；`conversation` 的插槽注册面未变 |
| `dsh-client-ui-sidebar` | `lib/client.js` | 否。`sidebar.panellist` 行的注册面未变（`check:slots` 实测通过） |

这三处正是 rc.4 那条修复（ACP 模式下诊断输出混入 stdout）落地的位置，即客户端模块装配与两处
UI 客户端代码。**结论：只换依赖，不改一行源码。**

## 2 执行动作 `[实测]`

| 动作 | 结果 |
|---|---|
| 根 `package.json` 与 18 个插件的 `package.json` 换线 | 19 个文件、380 处规格 |
| 删除根 `node_modules` 与 `package-lock.json` 后重装 | `added 420 packages in 3m`，exit 0 |
| 删除 18 个插件各自的 `node_modules` 与锁，用 `--legacy-peer-deps` 重装 | 18/18 成功 |

装完核对：`dsh-agent` / `dsh-tools` / `dsh-session` / `dsh-session-projection` 均为 `0.2.1-rc.4`，
cordis 为 `4.0.5`、schemastery 为 `3.18.5`，与目标线声明一致。

## 3 门禁结果 `[实测]`

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run check:graph` | 18 插件，跟线 `^0.2.1-rc.4`，无违规 |
| `npm run check:suites:gate` | 5 份 roster 一致，18 个名字 |
| `npm run check:slots` | 全部 OK |
| `npm run check:touchpoints` | 七类接触面全部有命中（738 个文件） |
| 18 个插件 `npm run build` | 18/18 通过 |
| 18 个插件 `npm test` | 18/18 套件通过，合计 2220 条；`plugin-rewind` 首轮红了，原因不在内核（见 §4） |
| 根 `npm test` | 729 条：727 通过 / 2 跳过 / 0 失败 |
| `node scripts/check-changeset.mjs --base v0.17.8` | 每个提交都带着声明 |

## 4 附带修掉的一处既有缺陷：`plugin-rewind` 的两条测试 `[实测]`

首次跑 18 个插件套件时 `plugin-rewind` 红了，两条断言都读 `src` 源码做文本判断：

- `the stylesheet carries no backtick inside its template literal` —— 报 "cssText is not closed"；
- `a manifest entry recorded as unreadable is not treated as created either` —— 跨行正则不匹配。

**不是内核引起的**，证据三条：

1. 这两条读的文件相对 HEAD 未修改（`git status` 干净），内核换线不改变 `readFileSync` 的结果；
2. git 里存的是 LF，`core.autocrlf=true`（仓库没有 `.gitattributes`）让工作区变成 CRLF；
3. 同一段判定逻辑：CRLF 下 `lines.lastIndexOf('`') === -1`（失败），把 `\r\n` 归一成 `\n` 后通过。

即：**任何 Windows 捡出上这两条必红，而 CI 的 LF 捡出一直是绿的**，所以之前的记录里看不到它。
修法是在读取处把 `\r\n` 归一（断言本来就是关于字面量内容与代码形状，不是行尾），
`plugin-rewind` 修后 190/190 通过。生产代码与断言语义未动。

## 5 运行时产物 `[实测]`

| 项 | 结果 |
|---|---|
| `npm run runtime:build` | `dsh-runtime-win32-x64-0.2.1-rc.4.tgz`，111.8 MB / 20323 文件；`office-payload-win32-x64-0.2.1-rc.4.tgz`，70.5 MB（office payload 0.1.2，engine win32-x64） |
| `check:plugins --kernel <新的 runtime.tgz> --home ~/.dsh` | **通过**：真实 profile 下内核 9.9s 就绪，未命中任何失败信号 |

`check:plugins` 不带 `--home` 时用临时 DSH_HOME，而临时 home 里没有 `dsh-app` profile，内核会以
`profile "dsh-app" does not exist` 退出 —— 这是该工具的用法，不是本轮回归：指向真实 home
（`~/.dsh`，其中 `profiles/dsh-app` 存在）后即通过。发布前要跑这一条，记得带 `--home`。
