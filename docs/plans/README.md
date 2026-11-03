# Plan index

`plans/` holds the plans that are open or freshly finished. **A plan's status lives only in its own
`- Status:` header** — this table is an index, kept one line per plan; the status vocabulary is in
[`../README.md`](../README.md).

| Plan | Status | Subject |
|---|---|---|
| [archive-delete-hardening.md](archive-delete-hardening.md) | active | 归档删除：可撤销、无残留、Windows 可靠 |
| [codegraph-development-freshness.md](codegraph-development-freshness.md) | done | CodeGraph 开发期新鲜度与模型输出的真实性 |
| [kernel-0.2.1-pre-adaptation.md](kernel-0.2.1-pre-adaptation.md) | superseded | 0.2.1 预适配映射；由 rc.1–rc.5 的执行记录取代（`../archive/kernel-line/`） |
| [kernel-0.2.2-alpha.2-preflight.md](kernel-0.2.2-alpha.2-preflight.md) | active | 0.2.2-alpha.2 预适配结论：正式版发布那一轮照此执行 |
| [office-slash-entry.md](office-slash-entry.md) | done | Office 套件的 `/` 入口 |
| [plugin-codegraph.md](plugin-codegraph.md) | active | plugin-codegraph：图谱、三个阶段与三个模型工具 |
| [plugin-market-boundary.md](plugin-market-boundary.md) | active | 插件市场与上游 Discover 的边界与退役判据（决策记录） |
| [rewind-undo-parity.md](rewind-undo-parity.md) | active | rewind 撤回语义：压缩边界、availability、参与者注册表 |
| [startup-visual-refinement.md](startup-visual-refinement.md) | done | 启动页视觉打磨 |
| [suite-review-backlog.md](suite-review-backlog.md) | active | 套件审查 backlog（19 插件），按伤害程度排序 |
| [workbench-creator-entry.md](workbench-creator-entry.md) | active | 工作台的创造模式入口 |
| [workbench-hub.md](workbench-hub.md) | active | 工作台容器与它的两个座位 |
| [workbench-todo-upgrade.md](workbench-todo-upgrade.md) | active | 待办板升级：截止时间、清单、子任务、智能视图 |

A finished plan is not deleted: it records why the current shape was chosen. What the code does now is
`../ARCHITECTURE.md` and the domain document under `../agents/`.
