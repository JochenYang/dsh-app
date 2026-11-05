# 内核线 0.2.2-rc.1：一次 peer 换线、一处源码适配、一处测试字面量

> 执行 2026-11-04。上一轮记录在 [`kernel-0.2.1-rc.5-upgrade.md`](kernel-0.2.1-rc.5-upgrade.md)，
> 预适配结论在 [`../plans/kernel-0.2.2-alpha.2-preflight.md`](../../plans/kernel-0.2.2-alpha.2-preflight.md)，
> 流程判据在 [`../agents/kernel-line-regression.md`](../../agents/kernel-line-regression.md)。
>
> **证据标记**：`[实测]` = 命令真跑过、有输出；`[静态]` = 读源码或包内容；`[待验证]` = 推断，须补测。
>
> 复现材料（gitignore）：`scratch/kernel-0.2.2/` —— `resolved.json`（rc.1 逐包解析）、
> `diff-rc1.txt`（逐包载荷比对）、`rc1-compat.mjs`（我们 import 的符号在两条线上的声明比对）、
> `plugin-install-rc1.log`（19 个插件的安装与构建）、`verify-rc1.log`（全部套件与门禁）。

---

## 0 事实基线 `[实测]`

```
npm dist-tags @deepseek-ai/dsh → { alpha: 0.2.2-alpha.3, latest: 0.2.1-rc.5, next: 0.2.2-rc.1 }
0.2.2-rc.1 engines: node >= 24.9.0
0.2.2-rc.1 的 vendor 化：cordis ~4.1.0、schemastery ~3.19.0、loader ~1.1.0、timer ~1.2.0（全部稳定版）
我们的 spec（换线前）：根 + 19 插件合计 404 处 ^0.2.1-rc.5；
  cordis 20×「^4.0.4」+ 19×「4.0.4」，schemastery 11×「^3.18.4」+ 11×「3.18.4」
换线后 kernel-line 解析：{ spec: '^0.2.2-rc.1', channel: 'beta', tag: 'next' } `[实测]`
```

alpha.2 到 rc.1 之间上游有 **466 个提交** `[实测]`，但发布提交（`2f97f604`）只改版本号，
vendor 转正在 `60d811de`（cordis 4.1.0 / cosmokit 1.9.0 / schemastery 3.19.0 / timer 1.2.0）。
本仓上一次换线（rc.5）之后，这是我们第一次跨到 0.2.2 线。

## 1 逐包载荷比对：rc.5 → rc.1 `[实测]`

40 个 `@deepseek-ai/dsh-*` 包各下两个 tarball，解包后按文件算 sha256（`package.json` 排除）：

- **34 个有改动，4 个逐字节相同**，2 个不在该线（cordis / schemastery 各有独立版本线，
  它们的版本从 `dsh@0.2.2-rc.1` 的依赖里读，不能用内核版本号去解析）。
- 改动面的大头是**六个新语种 locale**（de / es / fr / ja / pt / ru）与 README，每个包都带；
  动到 `lib/` 的只有 25 个包。

## 2 导出面：我们 import 的 23 个包 / 0 丢失 / 15 变化 `[实测]`

| 变动 | 打到我们吗 |
|---|---|
| **`ProjectionDefinition<K extends string, S>`**（两个泛型、无默认值），`SessionProjectionStateMap` 已删 | **是**，见 §3.3 |
| 8 个 icon 组件的返回类型写法 `import("react").JSX.Element` → `React.JSX.Element` | 否，纯声明写法 |
| `Menu` 新增 `contextual` / `exiting` / `returnFocus`；`MenuItemButton` 新增 `disabledReason`；`Tooltip` 新增 `onlyWhenClipped`；`ImageLightbox` 新增 `contextMenuProps` | 否，全是可选增项；`disabledReason` 是质量机会 |
| `WebSearchSource.summary?` | 否，可选；不补就比内核自带 provider 弱一档（见 §5） |
| `AgentOptions.reasoningEffort?: … | undefined` | 否，只是加了 `| undefined` |

`dsh-tools` 是 `lib/` 改动最大者（8 改 / 18 增 / 12 删），但我们用到的 `defineTool`、
`ToolRuntime`、`ToolsService.register` 声明逐字未变。

## 3 必改项

### 3.1 换线：404 处 spec `[实测]`

`^0.2.1-rc.5` 不接受 `0.2.2-rc.1`（caret 的预发布 tuple 规则），根 + 19 个插件的
peer/dev 一起改成 `^0.2.2-rc.1`。

### 3.2 vendor 生态：`^` 可以，但要对齐上游 floor `[实测]`

alpha.2 时代 cordis / schemastery 是**预发布**，只能写 `~4.0.6-alpha.1` 这类字面量；
rc.1 它们转成稳定 minor（4.1.0 / 3.19.0），实测 `^4.0.4` 与 `^3.18.4` 本来就接受这两个版本。
仍然改成 `^4.1.0` / `^3.19.0`：让声明表达「我们被测过的组合」，而不是「碰巧也能装到」。

### 3.3 唯一一处源码适配：会话投影契约（两个 API，同一处文件）`[实测]`

`plugins/plugin-rewind`：

1. **定义**（`src/projection.ts`）：`satisfies ProjectionDefinition<'rewindAnchors'>` →
   `< 'rewindAnchors', RewindState >`（折状态类型现在是第二个泛型参数，不再从
   `SessionProjectionStateMap` 查表）；删掉对 `SessionProjectionStateMap` 的模块增强（该接口已删除），
   保留对 `SessionProjectionMap` 的增强（客户端可见的 wire 类型仍要登记）。
2. **注册**（`src/index.ts`）：`ctx.sessionProjections.register` 现在返回
   `Promise<ProjectionHandle<S>>`，而 `ProjectionHandle` **不是** disposer（它有 `stateOf` /
   `readerFor` / `dispose()`）。`ctx.effect` 要求同步返回 disposer 或 `Effect`，直接把那个 promise
   交出去会两个 overload 都不匹配。改成在 effect 体内 `register`，返回 `() => registering.then(h => h.dispose())`。

**这一条是怎么被发现的**：19 个插件的 `npm run build` 全绿——因为 build 是 esbuild，**不做类型检查**。
是 `plugin-gates` 的 type gate（`tsc --noEmit`）报出 `index.ts:519` 的 overload 不匹配。换线后必须跑
type gate，否则这类错误会以「运行期 throw」的形式出现在用户那里。

### 3.3a 构建期阻塞：`kernel-line.mjs` 把嵌套的 vendored 包读成第二个内核版本 `[实测]`

`npm run runtime:build` 直接拒绝：`package-lock.json resolved 3 different @deepseek-ai/dsh* versions
(0.2.2-rc.1, 1.9.0, 3.19.0)`。根因是 `lockfileKernelVersion()` 用**路径前缀**匹配锁文件键
（`^node_modules/@deepseek-ai/dsh(?:-|$)`），而 npm 这次把 vendored 包嵌套安装在某个内核包下面
（`…/dsh-<pkg>/node_modules/@deepseek-ai/cosmokit@1.9.0`），前缀相同、版本不同，于是被当成第二个内核版本。

修法：只看 `node_modules/` 之后的那一段**包名**。同一时间 `test/runtime-kernel-pin.test.mjs`
里也有同一份规则的第二拷贝（同样的 bug），已改成直接 import 这个共享 resolver——一条规则一个地方，
否则两份会各自漂移。这条 bug 在换线前不会出现：那时锁文件里没有嵌套的内核包树。

### 3.4 内核包开始把兄弟包声明为 **peer**，`--legacy-peer-deps` 一个都不装 `[实测]`

rc.1 里 `dsh-session` / `dsh-tools` 的运行时代码 `import "@deepseek-ai/dsh-scope"`，
`dsh-subagent` 还 import `dsh-attachment` / `dsh-util-time`；这些包在各自 manifest 里是
**peerDependencies**。本仓的安装约定是 `npm install --legacy-peer-deps`（**不装 peer**），
于是：

- 插件测试把内核包一起 esbuild 打包（harness 没有 `external` 列表）→ `Could not resolve "@deepseek-ai/dsh-scope"`，
  **9 个插件的套件在建包阶段就失败**；
- 另几个插件在运行期 `ERR_MODULE_NOT_FOUND`（`plugin-pdf` 的 e2e 六条全红）。

处置：在这些插件自己的 `devDependencies` 里显式声明 `@deepseek-ai/dsh-scope`（12 个插件 + 根），
`plugin-swarm` 另加 `dsh-attachment` / `dsh-util-time`。这与本套件既有约定一致——「测试期要能解析的
内核 peer，也要在 devDependencies 里出现」。

### 3.5 一处测试字面量钉在旧线上 `[实测]`

`plugins/plugin-workbench/tests/create-entry.test.ts` 把 primitives 的 peer/dev spec 写成
`'^0.2.1-rc.5'` 直接比较。改成**从根 manifest 读当前跟随的线**（`@deepseek-ai/dsh-session` 的 spec），
断言「等于这条线」——换线不再是测试失败，而真正的偏差仍会红。

### 3.6 CI 的 Node 必须提到 ≥ 24.9 `[实测]`

`engines.node >= 24.9.0`，而 `scripts/build-runtime.mjs` 用**运行时的** `process.version` 决定
打进产物的是哪个 node。`.github/workflows/ci.yml`（2 处）与 `release.yml`（3 处）的
`node-version: 22` 全部改成 `'24.9'`：不是提 major，而是钉在 floor 上，避免 24.0 的 runner 漏过。

## 4 执行动作 `[实测]`

| 动作 | 结果 |
|---|---|
| 404 处 dsh spec + cordis/schemastery 换线（根 + 19 插件） | 20 个 manifest |
| 根重装 | `dsh-session` / `dsh-tools` = 0.2.2-rc.1，cordis 4.1.0 |
| 19 个插件 `npm install --legacy-peer-deps` + `npm run build` | **19/19 成功** |
| 12 个插件 + 根补 `@deepseek-ai/dsh-scope`，swarm 另补两个 peer | 重装后套件恢复 |
| `plugin-rewind` 两处源码、`plugin-workbench` 一处测试 | 版本 0.1.9 → 0.2.0（单位数规则，9 进位到 minor） |
| CI 五处 `node-version` | `'24.9'` |

## 5 门禁结果 `[实测]`

| 门禁 | 结果 |
|---|---|
| 19 个插件套件 | 见 `verify-rc1.log`：逐插件 PASS |
| 根 `npm test` | 见 `verify-rc1.log` |
| `plugin-gates`（19 个插件的 import / type / presence / freshness） | 见同文件 |
| `check:graph` / `check:suites` | PASS |

## 6 未验证项与风险

- **真内核验过，真窗口没验**：构出的 0.2.2-rc.1 runtime 解到 `scratch/kernel-0.2.2-rc.1/runtime` 后，
  `npm run verify -- --runtime <该树>` 报 `smoke: all checks passed`——19 个套件插件在真内核里全部激活，
  路由与打包资源都应答。但没有跑过 `npm run dev` 的窗口，所以**客户端渲染面**仍未验：
  `dsh-client-ui-primitives` 有 45 个文件改动，rc.1 新增 `settings.section.icon` 导航图标槽位，
  与我们 `plugin-client-ui` 自己注入图标的方式是否冲突，只能真机看设置页。`[待验证]`
- **office 载荷**（LibreOffice 引擎）只比了类型，没比运行时行为；本轮构出
  `office-payload-win32-x64-0.2.2-rc.1.tgz`（引擎 0.1.2）但没在应用里装过。
- **peer 清单还会继续长**：rc.1 把内核内部的兄弟依赖改成 peer，我们的安装约定不装 peer，
  所以每次换线都可能再冒出一两个（本轮是 scope / attachment / util-time）。根治办法见 §7。

## 6a dev 的跑法 `[实测]`

`npm run dev` 会拒绝一条不匹配的线（「installed kernel is dsh 0.2.1-rc.5, but this repository
follows ^0.2.2-rc.1」）。换上本条线：

```sh
npm run runtime:build -- win32 x64                                   # 构出 runtime-dist/*.tgz
mkdir -p scratch/kernel-0.2.2-rc.1
tar -xzf runtime-dist/dsh-runtime-win32-x64-0.2.2-rc.1.tgz -C scratch/kernel-0.2.2-rc.1
npm run dev                                                          # 自动选中 scratch/<name>/runtime
```

构包会**退役其它版本的产物**（本轮清掉 rc.5 的 tgz 与 office 载荷，腾出 182 MB），所以
`runtime-dist/` 里只剩当前线的两个 tarball；已装的旧内核在 `%APPDATA%\DSH APP\kernel\` 里，不受影响。

## 7 下一轮需要注意

1. **换线时先跑一遍「内核包 peer 是否齐全」**：拿目标线里我们 devDepend 的内核包，读它们的
   `peerDependencies`，和插件树里实际存在的包求差集。差集非空就是本轮这种失败，且它在**建包/运行期**
   才出现，类型检查看不见。
2. **测试不要写死内核线**：`plugin-workbench` 那条是本轮唯一一处；以后凡是要断言「跟的是哪条线」，
   都从根 manifest 读。
3. 预适配文档里的 `[待验证]` 项（客户端 props、office 运行时）在正式版之前仍要补。
