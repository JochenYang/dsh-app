# 内核线 0.2.2-rc.3 → 0.2.2-rc.4：一次补丁跟随

- Status: done
- Plan date: 2026-11-18
- 流程判据：[`../agents/kernel-line-regression.md`](../agents/kernel-line-regression.md)

> **预检**：`npm run check:preflight -- --npm 0.2.2-rc.4` → **0 blocker / 0 ADAPT / 10 note**；
> 19 个插件树重装后 `--line-policy=exact` 也是 0 blocker。

## 1 上游这一版动了什么 `[实测]`

`npm view @deepseek-ai/dsh dist-tags` → `next = 0.2.2-rc.4`（`latest` 仍是 0.2.2-rc.1）。
预检的 payload 只报两个包变化：`dsh-llm`（4 个文件）、`dsh-client-ui-sidebar`（1 个文件）。
声明比较 0 处变化，`slots` 82 条不变，`overlay` 198 行未动，技能名单仍 4 项，无新增 peer，
`engines` 仍是 `node >=24.9.0`。

## 2 适配动作

| 动作 | 结果 |
|---|---|
| 422 处 spec（根 25 + 19 个插件 397）`^0.2.2-rc.3` → `^0.2.2-rc.4` | `[实测]` 20 个 manifest |
| 根 `node_modules` 删除后 `npm install` | `[实测]` 旧 peer 树导致 ERESOLVE，`--force` 收尾；`npm ci` 复核通过 |
| 锁定版本 | `[实测]` `kernel-line --resolve` → `0.2.2-rc.4`；锁内内核包只有一个版本 |
| 19 个插件树 `npm install --legacy-peer-deps` | `[实测]` 19/19 ok |
| 预检（exact） | `[实测]` 0 blocker |

## 3 门禁

`npm run typecheck`、`npm test`（765 项）、19 个插件的 `build` 与单测、
`check:graph`、`check:slots`、`check:suites:gate`、`check:touchpoints`、`check:preflight --line-policy=exact`
全部通过。

## 4 采纳决定

无。两个变化的包没有新增座位、服务或具名导出（预检 `exports` / `slots` / `services` 均为空 diff），
`dsh-client-ui-sidebar` 的 1 个文件改动不涉及我们使用的页签注册面。下一轮重新评估。
