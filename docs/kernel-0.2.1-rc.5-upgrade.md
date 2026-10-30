# 内核线 0.2.1-rc.5：只换依赖，无源码适配

> 执行 2026-10-30。上一轮记录在 [`kernel-0.2.1-rc.4-upgrade.md`](kernel-0.2.1-rc.4-upgrade.md)，
> 流程判据在 [`agents/kernel-line-regression.md`](agents/kernel-line-regression.md)。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或包内容；`[待验证]` = 推断。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh → { latest: 0.2.1-rc.5, next: 0.2.1-rc.5, alpha: 0.2.2-alpha.2 }
我们的 spec：根 23 处 + 18 插件合计 380 处 ^0.2.1-rc.4 → ^0.2.1-rc.5
kernel-line 解析：{ spec: '^0.2.1-rc.5', channel: 'beta', tag: 'next', suiteVersion: '0809f4cc' }
```

rc.5 与 rc.1–rc.4 的不同点：它同时挂在 `latest` 与 `next` 上，是 0.2.1 线第一次进入 `latest`。
channel 仍是 `beta`、tag 仍是 `next` —— 决定 channel 的是版本本身是预发布，不是它挂了几个 tag。

## 1 这一轮改了什么：逐包比对 `[实测]`

38 个 `@deepseek-ai/dsh-*` 包各下 rc.4 与 rc.5 两个 tarball，解包后按文件算 sha256
（`package.json` 排除）：

- **35 个包逐字节相同**；
- **3 个包有改动**：

| 包 | 改动 | 打到我们吗 |
|---|---|---|
| `dsh-client-ui-chat` | `lib/client.js`、`ReasoningContent.d.ts`、`ReasoningRow.d.ts`、`contract/slots.d.ts`，新增 `reasoning-text.d.ts` | 否。思考内容展示重构：`ReasoningBodyOwnerProps` 新增 `rawText`，`text` 语义改为「已准备展示」，`ReasoningContentInput` 不再继承它。我们既不注册 `conversation.chat.reasoning.body` 槽，也不引用这两个类型 |
| `dsh-client-modules` | `lib/index.js` | 否。只有一行 git commit 戳（`ec17a2c` → `d4db512`） |
| `dsh-client-ui-sidebar` | `lib/client.js` | 否。只有版本戳（`0.2.1-rc.4-ec17a2c` → `0.2.1-rc.5-d4db512`） |

导出面复核：我们 import 的 **369 个符号，0 个声明发生变化**，0 个不可达。

**结论：只改 peer，不改一行源码。**

## 2 执行动作 `[实测]`

| 动作 | 结果 |
|---|---|
| 根与 18 个插件的 `package.json` 换线 | 19 个文件、380 处规格 |
| 清根 `node_modules`/`package-lock.json` 后重装 | `added 420 packages in 2m`（首次尝试被 `npm error network aborted` 中断 —— 当时 npmjs 单个 tarball 要 300 秒；重试带 `--prefer-offline` 通过） |
| 清 18 个插件的 `node_modules`/锁，用 `--legacy-peer-deps --prefer-offline` 重装 | 18/18 成功 |

## 3 门禁结果 `[实测]`

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run check:graph` | 18 插件，跟线 `^0.2.1-rc.5`，无违规 |
| `npm run check:suites:gate` | 5 份 roster 一致，18 个名字 |
| `npm run check:slots` | 全部 OK（插件树装完后重跑；装之前它对缺 `node_modules` 的插件报「未判定」） |
| `npm run check:touchpoints` | 七类接触面全部有命中 |
| 18 个插件 `npm run build` | 18/18 通过 |
| 18 个插件 `npm test` | 18/18 套件通过，合计 2220 条（与 rc.4 同数，无新增/丢失） |
| 根 `npm test` | 729 条：727 通过 / 2 跳过 / 0 失败 |

## 4 运行时产物 `[实测]`

| 项 | 结果 |
|---|---|
| `npm run runtime:build` | `dsh-runtime-win32-x64-0.2.1-rc.5.tgz`，111.7 MB / 20304 文件；`office-payload-win32-x64-0.2.1-rc.5.tgz`，70.5 MB（office payload 0.1.2，engine win32-x64） |
| `check:plugins --kernel <新的 runtime.tgz> --home ~/.dsh` | **通过**：真实 profile 下内核 7.1s 就绪，未命中失败信号 |

这一轮构建被网络卡了三次，都是环境问题，不是代码问题：Node 二进制从 nodejs.org 下到 14.8 MB 断流
（改用 `NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node`，校验仍对官方 `SHASUMS256.txt`）；
内核包从 npmjs 只有 1–2 KiB/s（改用 `npm_config_registry=https://registry.npmmirror.com`，
pnpm 仍做 integrity 校验）；中间一次被中止的构建留下 `runtime-dist/work/assemble` 目录锁
（`EBUSY`），锁释放后重试通过。**提交的 `package-lock.json` 未受影响**，仍然全部指向
`registry.npmjs.org`。
