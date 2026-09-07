# Schedule 会话内定时提醒（P3）

> 目标：agent 会话内可定时提醒/定时续跑；桌面壳补上上游没有的**系统通知**。

## 1. 背景与内核契约（L1，`docs/user/guide/schedule.md` + overlay 示例）

- 会话级持久提醒：模型经 `schedule_create` / `schedule_list` / `schedule_delete` 管理；
  支持 `after_seconds`、绝对 `at`（RFC 3339）、固定间隔 `every_seconds`（≥300s）。
  到期 = 在**同一会话**排队一条普通 follow-up 消息（agent 空闲时投递）。
- 记录随会话日志持久：重启后重开会话继续生效；不跨会话、无邮件/推送
  （上游明确"没有外部通知"——桌面壳的差异化空间）。
- 官方开启方式就是一个 3 行 overlay（`apps/cli/config/examples/schedule/cordis.yml`）：

  ```yaml
  - insert:
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
      - id: schedule
        name: '@deepseek-ai/dsh-schedule'

  - id: ui-schedule
    disabled: false      # base/web bundle 里此行 disabled: true，这里翻开
  ```

  启用后 web UI 自动获得：会话头部的只读提醒目录 + 侧栏行的闹钟标记（上游已有渲染，
  我们零 UI 工作）。

## 2. 方案设计

### 2.1 挂载（直接照抄）

`dsh-app.patch.yml` 加上述 3 行。无用户配置面（上游定位：模型经工具管理、用户在
UI 只读查看），本期不做设置页。

### 2.2 桌面增值：到期系统通知（依赖 plugin-brand desktop bridge）

- 现状缺口：提醒投递 = 会话内一条消息；用户不在会话页就无感。
- 方案：plugin-brand 的 desktop bridge（desktop-shell-experience.md §1）提供
  `notify(title, body)`；套件侧监听提醒投递事件（投递会话 id + 摘要）→ 触发
  Windows/OS 通知，点击通知 → shell 聚焦窗口并打开对应会话。
- 监听点：提醒投递在会话 log 里有 durable dispatch 记录（上游文档），套件插件经
  `session/event` 火线过滤即可（plugin-usage 已有同款监听模式）。
- V2 再做点击跳会话（需要 shell ↔ web 的会话路由协议，先只做通知本身）。

## 3. MVP / 验收

**MVP**：3 行 overlay 启用 + 验证三类计时（after/at/every）在真实会话投递。
**V2**：系统通知桥（前置：plugin-brand desktop bridge）。
**验收**：
1. "10 分钟后提醒我提交" → 10 分钟后会话出现 follow-up 消息，头部目录显示该提醒；
2. 重启 dsh server 后重开会话，未到期提醒仍生效（持久性）；
3. 不启用 overlay 的回滚内核：boot 正常（overlay 行按名缺失时优雅跳过——套件纪律，
   需在探针确认 loader 对缺失包的行为是 warn 不是 crash，并入 mcp-manager V1 验证清单）。

风险：低。上游有完整用户指南 + 示例 overlay，工作量 ≈ 半天 + 验证。

## 4. 落地记录（2026-09-07）

- overlay 3 行已加入 `dsh-app.patch.yml`（time-context + schedule insert，
  ui-schedule 翻开）。两个包均在 `apps/cli` dependencies 内（L1），并用
  packaged `bin.js` 实测整树启动成功（不再只信 dev pnpm 闭包——tool-session-query
  白屏教训）。`--dump-config` 确认三行在 composed tree 内生效。
- 未做：系统通知桥（V2，依赖 plugin-brand desktop bridge）、端到端投递验证
  （需真实模型调用，交用户实测）。
