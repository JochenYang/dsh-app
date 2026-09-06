# 开发过程工具链（CI 门 / 冒烟探针 / 版本对齐 / 单测 / 通道看板）

> 目标：让"我们自己"变快变稳。优先级建议**先于 P0-P3 功能落地**——
> 套件冒烟探针是后续每个新插件（mcp/hooks/…）的运行时验证手段。

## 1. PR CI 门（`ci.yml`）

现状：`.github/workflows/` 只有 release.yml，`on` 仅 tag push / workflow_dispatch——
typecheck、8 个插件 tsc、memory/swarm 测试平时全靠手跑（L1）。

**方案**：push + pull_request 触发，单 ubuntu job：
```sh
npm ci
npm run typecheck
node plugins/plugin-<name>/build.mjs   # 8 个循环（brand 走 tsc build）
(cd plugins/plugin-memory && npm test)
(cd plugins/plugin-swarm && npm test)
```
windows job 可后加（suite 代码有平台分支时再扩）。耗时预估 <10 min。
**验收**：PR 上红绿可用；main push 同样触发。

## 2. 套件冒烟探针（治"compile-green ≠ runtime-green"旧伤）

背景：alpha.4 删 `Session.events` 后，套件 typecheck/test 全绿、运行时静默坏了几天
（AGENTS.md §6 明文教训）。rc 线 API 漂移是常态，每次内核 bump 都在裸奔。

**方案**：`scripts/smoke-suite.mjs`（dev/prod 两态可跑）：
1. 以 dev 模式起 `dsh web`（或对 bundled kernel 起进程），挂全套件 overlay；
2. 等健康检查通过后，逐插件打其 API routes 断言 200 + 关键字段
   （usage/status、archives/list、memory/status、swarm/status、mcp/status…）；
3. 挂载面断言：loader 日志无套件相关 error；`/plugins/.../client.js` 可取
   （client 半 bundle 完整性）；
4. 退出码汇总，供 CI 与本地 `npm run verify`（package.json 新 script）使用。

接入：ci.yml 追加 job（ubuntu 起真实内核）；内核 bump SOP（AGENTS.md §4 step 4）
追加"跑 smoke-suite"步骤。

**验收**：人为在 patch.yml 指向一个不存在的插件行 → 探针红；正常套件 → 绿。
对 rc.1→新版 bump 的回归演练一次。

## 3. 内核版本对齐脚本（消灭手工易错步骤）

现状：内核 bump 要手改根 `package.json` + 8 个 `plugins/*/package.json` 的
`@deepseek-ai/*` devDeps 到同一行（AGENTS.md §4 step 2），漏一个就 dual-instance
dsh-llm、typecheck 爆炸。

**方案**：`scripts/bump-kernel-deps.mjs <version|--dist-tag <tag>>`：
- 解析 dist-tag（复用 `sources/registry.ts` 的解析规则）；
- 改根 + 遍历插件 package.json 匹配 `@deepseek-ai/*` devDeps 统一改写；
- 打印 diff 摘要；不改 lockfile（提示随后手动 `npm install` / 插件内
  `--legacy-peer-deps`，遵循 §4 的两个不同 install 纪律）。
**验收**：对当前树 dry-run 输出的目标版本与手工计算一致。

## 4. shell/kernel 首批单测（node:test，与插件同风格）

范围（纯逻辑优先，不碰 Electron）：
- `src/kernel/manifest.ts`：current.json 原子写（tmp+rename）、损坏文件容错；
- `src/kernel/sources/registry.ts`：dist-tag 解析、registry 链 fallback、
  prerelease 跟随最高版本的规则；
- `src/kernel/manager.ts` 的可提纯决策函数：更新建议（版本比较 + artifact 存在与否）、
  回滚触发条件（两次健康失败→回滚一次）；
- `src/main/server.ts` 的日志 redact 规则与 settled-URL 解析。

**验收**：`npm run test`（根 package.json 新增）全绿；CI 门接入。
估计覆盖 kernel 决策面 60%+ 行数、零 mock Electron。

## 5. 内核通道看板（小工具）

现状：npm dist-tag 先上线、`runtime-<v>` artifacts 后齐（§4 时差窗口），
窗口内检查报"安装包尚未发布"，曾差点误诊为用户网络问题（AGENTS.md §4 gotcha）。

**方案**：`scripts/probe-channel.mjs`：取 dist-tags 全表 → 对每个比 active 新的版本
查 `runtime-<v>` release 的 6 cell 资产齐套性（`gh api` / GitHub API）→ 输出矩阵
（版本 × cell × 就绪）。CI 定时（或手动）跑，发版后盯齐套。
**验收**：对 rc.1 输出全绿矩阵；人为找一个缺 cell 的历史 release 验证告警。

## 实施顺序

1（ci.yml，静态）→ 2（冒烟探针，价值最大）→ 4（单测）→ 3（对齐脚本）→ 5（看板）。
其中 2 完成后，capability-roadmap 各新插件的验收标准全部可以引用它做回归。
