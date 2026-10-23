# Settings rail order

The settings page is one ordered rail. A suite section declares its position
with an `order` value, and **two sections must never share one** — a duplicate
silently reorders the rail depending on load order.

Two rules, and they are the reason this file exists:

1. **Never reuse a value that is taken.** Add at the end, or in a gap, but do not
   claim a number another row owns.
2. **Update this table in the same commit as an `order` change.** A number that
   moved without the table moving is how the next person picks a collision.

## Current assignments

| order | section | owner |
|---|---|---|
| 0 | upstream row | upstream |
| 2 | 预设包 / Presets (tab of 维护设置) | this suite, declared through the section owner |
| 3 | 诊断 / Diagnostics (tab of 维护设置) | this suite, same |
| 4 | 撤回隔离区 / Quarantine (tab of 维护设置) | this suite, same |
| 10 | upstream row | upstream |
| 11 | 模型高级设置 / Advanced models | this suite |
| 12 | MCP 服务器 / MCP | this suite |
| 13 | Hooks | this suite |
| 14 | 网络搜索 / Web search | this suite |
| 15 | upstream row | upstream |
| 19 | 并行子代理 / Swarm | this suite |
| 20 | upstream row | upstream |
| 21 | 用量统计 / Usage | this suite |
| 22 | 会话记忆 / Memory | this suite |
| 23 | 会话归档 / Archives | this suite |
| 24 | 维护设置 / Maintenance | this suite |
| 25 | upstream, PINNED | upstream |
| 26 | 关于 DSH-APP / About | this suite |
| 27 | 代码图谱 / Code graph | this suite |

**维护设置 is ONE section with three tabs**, not three sections: 预设包 2,
诊断 3, 撤回隔离区 4. It is declared by the section owner through the
`settings.dsh-app-maintenance.tab` child slot. Order 1 is a vacant slot and stays
vacant.

## Adding a section

Pick the next free number above 27 unless the section belongs beside an existing
one, add the row here, and add the same number to the section's registration. A
collision is not caught by any gate — the rail just renders in an order nobody
chose.
