# DSH APP — brand plugin suite

The suite is seven dsh plugins that layer on top of upstream dsh **without
forking it**. This is what keeps the desktop app updateable: when upstream dsh
releases a new version, the shell swaps the kernel and these plugins keep
working.

## Packages

| Package | Side | Role |
|---|---|---|
| `plugin-brand` | host | brand settings namespace, app info service, desktop bridge (git info, native dialogs) |
| `plugin-client-ui` | client | brand theme, brand Models settings section |
| `plugin-sidebar` | dual | workspace file tree + preview and the Git panel as native conversation-view tabs |
| `plugin-swarm` | host | batch parallel subagent orchestration (`swarm` tool + `/swarm` command), adaptive concurrency, per-item retry |
| `plugin-usage` | dual | usage capture over session logs + settings-page balance card, heatmap, daily trend chart |
| `plugin-archives` | dual | session archive manager (list/delete routes + settings-page section grouped by project) |
| `plugin-memory` | dual | cross-session memory (global/project files injected per prompt, memory_save/recall/forget tools, background distiller + curator, settings page with per-entry pin/delete) |

## Integration into the kernel runtime

The runtime artifact build (scripts/build-runtime.mjs) adds the suite via
`file:` references into the runtime profile's package.json, so a published
kernel contains dsh + the suite in one immutable directory. Once the suite is
published to npm, switch those references to version ranges.

The loader overlay (`dsh-app.patch.yml`) is copied into userData at server
start and passed to `dsh web --patch ...`; it inserts all seven suite entries
after every bundle layer and the profile's own patch (last write wins).
