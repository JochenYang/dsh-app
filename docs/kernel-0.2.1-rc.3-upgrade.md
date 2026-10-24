# 内核线 0.2.1-rc.3：只换依赖，无源码适配

> 执行 2026-10-24。上一轮记录在 [`kernel-0.2.1-rc.1-upgrade.md`](kernel-0.2.1-rc.1-upgrade.md)
> （rc.1 → rc.2 是同文件的补充），流程判据在 [`agents/kernel-line-regression.md`](agents/kernel-line-regression.md)。
> 本文只写这一轮新增的判断。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或包内容；`[待验证]` = 推断。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh  → { alpha: 0.2.1-alpha.5, latest: 0.2.1-rc.2, next: 0.2.1-rc.3 }
我们的 spec：根 23 处 + 18 插件 peer/dev 合计 380 处 ^0.2.1-rc.2 → ^0.2.1-rc.3
kernel-line 解析：{ spec: '^0.2.1-rc.3', channel: 'beta', tag: 'next', suiteVersion: '1c3251ad' }
```

rc.3 挂在 `next` 上而不是 `latest`。仓库既有的三条线（rc.1、rc.2）都是这样升上来的，跟的是 `next`。

## 1 这一轮改了什么：逐包比对 `[实测]`

不靠读 changelog 猜。把 rc.2 与 rc.3 的 tarball 逐个下载、解包、按文件算 sha256，
`package.json` 单独排除（它的 `version` 与依赖声明本来就该变）：

- 比对 **70 个包**，每个包的文件数与逐文件哈希；
- 结果：**65 个包的载荷完全相同**，差异只有 `package.json` 里的版本号与内部依赖指针；
- **5 个包有真实改动**。

| 包 | 改动 | 打到我们吗 |
|---|---|---|
| `dsh-web-app` | `cordis.patch.yml` 新增 `entry-customization` 一行 | 否。overlay 里没有这个行 id，我们也没注册相关 slot |
| `dsh-client-ui-agent-preset` | `AgentPresetSeatController.select()` 与 `apply()` 返回值由 `Promise<string \| undefined>` 改为 `Promise<AgentPresetApplyOutcome>`；新增 `analytics.d.ts` | **否。零插件依赖此包，无人调用这两个方法** |
| `dsh-tool-cordis` | API 目录新增 `AnalyticsPreset` 类型；`ProductEventMap.send_button_click` 增加 `is_new_session` 与 `agent_preset` 字段 | 否。我们不做遥测 |
| `dsh-cordis-client-runner` | 三处工具描述文案；`DraftInitializationOptions` 新增可选 `whenDraftExists` | 否。未使用该接口 |
| `dsh-agent-preset` | 技能参考文档新增一行 | 否。纯文档 |

唯一有破坏潜力的是一处**返回值类型变更**，但它只影响调用方，而本仓 18 个插件没有一个引用该包。
逐项核对方式：`grep` `AgentPresetSeatController` / `DraftInitializationOptions` / `ProductEventMap` /
`entry-customization` 在 `plugins/` 与 `src/` 下的全部出现，结果为零。

**结论：只换依赖，不改一行源码。**

## 2 执行动作 `[实测]`

| 动作 | 结果 |
|---|---|
| 根 `package.json` 与 18 个插件的 `package.json` 换线 | 19 个文件、380 处规格 |
| 删除根 `node_modules` 与 `package-lock.json` 后重装 | 不加这一步会 ERESOLVE：旧锁里的 peer 仍指向 rc.2 |
| 删除 18 个插件各自的 `node_modules` 与锁，用 `--legacy-peer-deps` 重装 | 18/18 成功 |
| `bundled-kernel/kernel.tgz` | 需要重建，见 §4 |

装完核对：`dsh-agent` / `dsh-tools` / `dsh-session` / `dsh-subagent` / `dsh-system-prompt` 均为 `0.2.1-rc.3`，
`cordis` 为 `4.0.5`（与 rc.3 声明的 `~4.0.5` 一致；我们的 devDependency 写 `^4.0.4`，本来就覆盖）。

## 3 门禁结果 `[实测]`

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run check:graph` | 18 插件，跟线 `^0.2.1-rc.3`，无违规 |
| `npm run check:suites:gate` | 5 份 roster 一致，18 个名字 |
| 18 个插件 `npm run build` | 18/18 通过 |
| 18 个插件 `npm test` | 合计 2122 条，0 失败 |
| 根 `npm test` | 715 通过 / 2 跳过 / 0 失败 |

编译绿不等于运行绿：`typecheck` 通过只说明 rc.3 的类型面与我们一致，而 rc.3 的五个真实改动里有四个
根本不出现在我们编译单元中，所以这一步的绿灯并不覆盖它们。真正的运行验证是 §5 的 `verify`。

## 4 运行时产物 `[实测]`

`bundled-kernel/manifest.json` 的 `dshVersion` 原本仍是 `0.2.1-rc.2`，必须由 `npm run runtime:build` 重新生成，
不能手改——那份 manifest 的 `integrity` 是构件的哈希，手改版本号会让它与 tarball 对不上。

```
Runtime artifact ready: runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz
runtime size: 111.7 MB (20277 files, 386.8 MB unpacked)
manifest: { dshVersion: '0.2.1-rc.3', suiteVersion: '1c3251ad', channel: 'beta' }
```

**这一步之前 `check:plugins` 是红的，而红得正确。** 当时它拿旧的 rc.2 tarball 去装，而 18 个插件此刻声明的
peer 已是 `^0.2.1-rc.3`，内核的兼容检查逐条拒绝并列出差异：

```
dsh: disabling profile plugin row "codegraph": Plugin @dsh-app/plugin-codegraph@0.2.2 is incompatible
with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-agent":"^0.2.1-rc.3", ...}
```

这不是故障，是换线期间**插件与内核版本必须同时移动**的直接证据。产物重建后这条断言才成立。

## 5 运行验证 `[实测]`

`npm run verify -- --tgz runtime-dist/dsh-runtime-win32-x64-0.2.1-rc.3.tgz` 在真实内核上做冒烟，
覆盖编译期看不见的三类断裂：具名导出消失、loader 组合层行 id 漂移、客户端注册面在渲染时抛。
rc.3 改了 `dsh-web-app` 的 patch（新增 `entry-customization` 一行），正是第二类要看的。


