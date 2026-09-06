# Agent Teams（P6 · 观望）

> experimental 多代理协作域：Lead + teammates 共享一个隐式根会话，
> 有持久 mailbox（对账恢复）、任务板（`task-<n>` 单调分配）、roster 生命周期、
> 共享 checkout。比 swarm 的"批次并行"更进一步：成员之间可互发消息。

## 1. 现状（L1）

- `packages/experimental/agent-team/`：类型域（TeamId/TeamTaskId/TeamMessageSnapshot…，
  见 `docs/subsystems/agent-team.md`）；
- `tool-agent-team/`（模型工具）+ `client-ui-agent-team/`（浏览器面板）+
  `agent-team-profile/`、`agent-team-web-profile/`（装配）；
- web 测试 overlay `apps/web/tests/agent-team-panel.overlay.yml` 证明上游在真机联调。

## 2. 观望理由与转正条件

- experimental 命名空间 = API 不稳定承诺；rc.1 套件已有"上游删 API 静默坏几天"的前科
  （AGENTS.md §6），把 experimental 接进产品线风险不对称。
- 与 swarm 定位重叠：swarm 解决"独立子任务批量并行"（已发布、已验证）；
  agent-team 解决"协作型任务分解"（上游仍在演化）。

**转正条件（满足其二即重估）**：
1. 上游把 agent-team 移出 experimental（目录或包名去 experimental 化）；
2. 用户侧出现明确的多代理协作需求（试玩反馈/issue）；
3. swarm 用户反馈中出现"子任务间需要通信"的真实案例。

## 3. 届时动作

挂 `agent-team-web-profile` bundle + `tool-agent-team` + `client-ui-agent-team`，
UI 面板接 settings/conversation 插槽；swarm 与 team 的入口定位写清楚
（批量并行 vs 协作分解）。本文档届时升级为正式 SPEC。
