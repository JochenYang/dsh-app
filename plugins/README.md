# DSH APP — brand plugin suite

The suite is ten dsh plugins that layer on top of upstream dsh **without
forking it**. This is what keeps the desktop app updateable: when upstream dsh
releases a new version, the shell swaps the kernel and these plugins keep
working.

## Packages

| Package | Side | Role |
|---|---|---|
| `plugin-brand` | host | **scaffold** — settings namespace, app-info service and desktop bridge are declared but not wired yet; the shell injects desktop chrome directly |
| `plugin-client-ui` | client | brand theme, brand Models settings section |
| `plugin-sidebar` | dual | Git panel as a native conversation-view tab (the file tree was retired: upstream ships file management natively) |
| `plugin-swarm` | host | batch parallel subagent orchestration (`swarm` tool + `/swarm` command), adaptive concurrency, per-item retry |
| `plugin-usage` | dual | usage capture over session logs + settings-page balance card, heatmap, daily trend chart |
| `plugin-archives` | dual | session archive manager (list/delete routes + settings-page section grouped by project) |
| `plugin-memory` | dual | cross-session memory (global/project files injected per prompt, memory_save/recall/forget tools, background distiller + curator, settings page with per-entry pin/delete) |
| `plugin-fff` | host | native fast file search, exposed to agents as a tool |
| `plugin-mcp` | dual | external MCP server manager: settings-page CRUD, dynamic mount, tools registered as native `mcp__<server>__<tool>` |
| `plugin-hooks` | dual | external hooks bridge: settings-page CRUD over Claude Code / Codex `hooks.json`, mounted as live hook instances |

The roster lives in five places that must stay in sync — `SUITE_PLUGIN_DIRS`
(src/main/brand-suite.ts), the overlay rows in `dsh-app.patch.yml`,
`SUITE_PLUGINS` in scripts/kernel-line.mjs, the pre-build loop in
`.github/workflows/release.yml`, and scripts/smoke-suite.mjs.

## Integration into the kernel runtime

The runtime artifact build (scripts/build-runtime.mjs) adds the suite via
`file:` references into the runtime profile's package.json, so a published
kernel contains dsh + the suite in one immutable directory. Once the suite is
published to npm, switch those references to version ranges.

The loader overlay (`dsh-app.patch.yml`) is copied into userData at server
start and passed to `dsh web --patch ...`; it inserts all ten suite entries
after every bundle layer and the profile's own patch (last write wins).
