# DSH APP — brand plugin suite

The suite is seventeen dsh plugins that layer on top of upstream dsh **without
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
| `plugin-ppt` | dual | editable PPTX generation: the model authors a local PPTD project (`.pptd` manifest + `.page` YAML) against bundled layout templates via `ppt_list_templates`/`ppt_get_template_reference`/`ppt_get_template_pages`/`pptd_write_file`/`pptd_list_files`/`pptd_read_file`/`pptd_check`/`pptd_render` (read-only check locates text overflow/occlusion per file-page-elementId before export), a guiding skill installed into `$DSH_HOME/skills`, and the PPT mode capsule in the **office-suite capsule bar** — the row of format capsules injected after the composer card (container class `dshOfficeBar`, one host per format as `[data-office-format]`, container reused and hosts ordered/deduplicated by that attribute so later Word/Excel/PDF plugins join the same row; see `plugins/plugin-ppt/src/client/office-bar.ts`). The capsule toggles the mode and opens a real cover-preview template panel behind its ▾ dropdown; a pick made before any session exists is parked and applied to the session once it starts |
| `plugin-market` | dual | plugin marketplace: sidebar footer entry + drawer panel over user-configurable catalog sources, install/uninstall through the kernel CLI with registry-only validation |
| `plugin-presets` | dual | portable preset packages: settings-page export of a preset directory as a shareable `.dshpreset` archive and import with kernel-roster-aligned name/path/size fencing |
| `plugin-doc` | dual | Word documents: `doc_write`/`doc_check`/`doc_render` tools over a validated JSON document project, rendered to an editable `.docx`; Word capsule in the shared office bar |
| `plugin-sheet` | dual | Excel workbooks: `sheet_write`/`sheet_check`/`sheet_render` tools over a validated JSON workbook project, rendered to an editable `.xlsx` with formulas; Excel capsule in the shared office bar |
| `plugin-pdf` | dual | PDF mode: `pdf_read` extracts text/metadata from workspace PDFs for the agent, `pdf_write`/`pdf_check`/`pdf_render` produce a paginated, rule-checked PDF with an embedded CJK font subset; PDF capsule in the shared office bar |
| `plugin-websearch` | dual | web search manager: registers ONE `ctx.web` search provider (`dsh-app`) whose engine chain (Bing / AnySearch / SearXNG / Exa / Parallel) falls back automatically, plus a settings-page section that orders engines, stores keys and switches between the brand chain and the upstream DeepSeek provider — each side showing its own availability so the switch never silently fails. The model-facing `web_search` tool stays upstream's — only the provider behind it changes. Replaces the hand-written `dsh-free-search` + exa/parallel MCP overlay rows |

The roster lives in the places listed below that must stay in sync — `SUITE_PLUGIN_DIRS`
(src/main/brand-suite.ts), the overlay rows in `dsh-app.patch.yml`,
`SUITE_PLUGINS` in scripts/kernel-line.mjs, the pre-build loop in
`.github/workflows/release.yml`, and scripts/smoke-suite.mjs.

## Integration into the kernel runtime

The runtime artifact build (scripts/build-runtime.mjs) adds the suite via
`file:` references into the runtime profile's package.json, so a published
kernel contains dsh + the suite in one immutable directory. Once the suite is
published to npm, switch those references to version ranges.

The loader overlay (`dsh-app.patch.yml`) is copied into userData at server
start and passed to `dsh web --patch ...`; it inserts all seventeen suite entries
after every bundle layer and the profile's own patch (last write wins).
