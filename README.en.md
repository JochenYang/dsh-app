<p align="center">
  <img src="resources/icon.png" alt="DSH APP" width="128">
</p>

<h1 align="center">DSH APP</h1>

<p align="center">
  A community-maintained branded desktop client for
  <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> (`dsh`).<br>
  Windows / macOS / Linux, targeting public release.
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

The shell bundles a versioned dsh runtime (self-managed updates and rollback)
and renders the official dsh web UI in a sandboxed window; all branding is
delivered as a dsh plugin suite — upstream is never forked. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layered design, kernel
runtime layout, update & rollback mechanism, and packaging.

## Branded client features

DSH APP is a **self-contained, no-fork** branded client: the kernel is
self-hosted (`userData/kernel/`, atomic activation + rollback) and every
feature is a dsh plugin suite (`plugins/`) layered on the upstream kernel, so
an upstream release is just an ordinary kernel update. Current plugin
capabilities:

| Feature | Plugin | Implementation |
|---|---|---|
| Conversation sidebar (native views): **Files** — workspace tree (lazy-loaded, root auto-expanded), text/image/Markdown preview (independent column scrolling); **Git** — change list grouped by directory, unified diff with dual line numbers, stage/restore/commit, tracked-file list, graph modal (click a commit for its title/body/file stat) | `@dsh-app/plugin-sidebar` (host + client dual-face) | `plugins/plugin-sidebar/src/client/{file-tree,git-tab}.tsx` |
| Conversation minimap: a slim rail on the right, one tick per message; hover for a content preview, click to jump; rendered only on the 对话 view; pitch compresses on long chats | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/minimap.tsx` |
| Advanced models settings page: model-level editors and whole-list management for llm-pi-ai models (reasoning effort, input modalities, compat switches); declaring a reasoning level auto-fills the compat switches (`supportsDeveloperRole` false + `maxTokensField`), additive-only and never overwriting explicit values; companion-route migration for off-catalog models; models.dev prefill with gh-proxy mirror fallback | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/models-advanced/` |
| Brand theme and fully localized Chinese UI: `--dsw-alias-*` token overrides | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client.ts:58` |
| Brand whale background: static frame at idle, hover-only pointer scatter (the render loop parks when the pointer leaves — no scroll jank); theme-aware contrast (light boost for legibility, dark low-alpha watermark); hovers above the composer, active phase enlarges and centers on the conversation column | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/whale-background.ts` |
| Cross-session memory: `memory_save`/`memory_recall`/`memory_forget` tools + system-prompt injection (newest first under budgets), global vs per-project memory files routed by session cwd; settings-page toggles; a background distiller backfills quiet sessions after 5 minutes through a read-only subagent (progress traces, shutdown-safe timers) | `@dsh-app/plugin-memory` | `plugins/plugin-memory/src/{tools,routes,distiller}.ts` |
| Batch subagent orchestration: independent subtasks fan out to parallel continuable children with an adaptive concurrency gate (shrinks on failure, grows on clean streaks), per-item auto-retry on preserved sessions, resume by child id; `swarm` tool + `/swarm` command | `@dsh-app/plugin-swarm` | `plugins/plugin-swarm/src/orchestrator.ts` |
| Usage statistics: balance card (official deepseek providers, CNY idle/peak dual-tier pricing, key never leaves the host), daily heatmap and trend chart; 5-minute TTL balance cache (single-flight, silent refresh on mount, forced re-query on card click) | `@dsh-app/plugin-usage` | `plugins/plugin-usage/src/client/usage-section.tsx` |
| Session archive manager: grouped by project cwd (collapsible, keyboard support), two-step delete confirm, stale archive pruning; the delete fence admits only archived sessions with no open turn; tolerates persistence backends whose locate() returns undefined | `@dsh-app/plugin-archives` | `plugins/plugin-archives/src/client/archives-section.tsx` |

Suite wiring (performed at every server start, `src/main/brand-suite.ts`):

1. **Module resolution**: the seven suite plugins are linked into
   `$DSH_HOME/profiles/node_modules/@dsh-app/` (junction on Windows); dev uses
   this repo's `plugins/*`, production the active kernel's
   `app/node_modules/@dsh-app/*`.
2. **Loader overlay**: `plugins/dsh-app.patch.yml` is copied into userData and
   injected via `dsh web --patch` — seven suite plugin entries applied after
   the official bundle layers (last write wins, no upstream profile template
   changes).

Both seams **degrade gracefully**: a kernel without the suite plugins (e.g. a
rollback target) boots vanilla, never blocked by brand wiring.

## Quick start (development)

Requires Node.js 22+ and pnpm. In dev mode the kernel is the local
deepseek-harness checkout.

One-time prerequisites:

```powershell
# 1. A sibling deepseek-harness checkout (../deepseek-harness),
#    with dependencies installed and the web frontend built:
cd ../deepseek-harness
pnpm install
pnpm run build:web

# 2. Install the shell dependencies
cd ../dsh-app
npm install
```

Launch (**note: Windows PowerShell does not support `VAR=1 cmd` syntax**):

```powershell
# PowerShell
$env:DSH_APP_DEV="1"; npm start
```

```bat
:: cmd
set DSH_APP_DEV=1 && npm start
```

In dev mode the shell spawns `pnpm dsh web` inside the local checkout (random
free port) — no downloads, no kernel artifacts. Dev startup is much slower than
production: pnpm + tsx on-the-fly transpilation of all TypeScript sources is the
main cost; production spawns the pre-compiled `lib/bin.js` and is ready in
seconds.

### Point at another checkout

```powershell
$env:DSH_APP_DEV="1"; $env:DSH_APP_DEV_RUNTIME="D:/codes/DSH-APP/deepseek-harness"; npm start
```

### Known dev/prod differences

| Item | Dev mode | Production |
|---|---|---|
| Kernel source | local checkout (`pnpm dsh web`, tsx on the fly) | preinstalled runtime under `userData/kernel/` (direct node binary) |
| Startup time | slow (order of 10 s) | fast (order of 2 s) |
| Update checks | skipped (pinned to checkout) | every 6 h auto + manual via tray |

## Kernel update system

The app ships a versioned kernel under `userData/kernel/` and never depends on a
system-installed dsh. Update pipeline: resolve the version from npm registry
dist-tags → download the runtime artifact from GitHub Releases → verify against
the attached sha512 → activate atomically (previous version kept as
`previous`) → automatically roll back after two consecutive startup failures.
See [ARCHITECTURE.md §4–5](docs/ARCHITECTURE.md) for the runtime layout and the
full update flow.

**Bundled-runtime drift detection**: on an upgrade, if the bundled runtime
content differs from the same-named kernel dir on disk (e.g. the suite gained a
plugin), boot detects it (sha512 comparison + version guard) and re-activates
the bundle — stale content can never silently lose plugins; a newer kernel
installed online is never downgrade-overwritten.

### Shell (app) updates

Windows uses a custom in-app flow; macOS / Linux use `electron-updater`.

1. Detect: `github.com/<owner>/<repo>/releases/latest/download/latest.yml`
   (mirror fallback)
2. Download: arch-matched installer, official URL first with
   ghfast.top / gh-proxy.com fallback chain
3. Verify: sha512 against latest.yml — a mirror can never substitute content
4. Install: **visible install wizard** — "install now" quits the app and opens
   the same NSIS wizard as a first-time install (progress fully visible); the
   app relaunches on completion and the installer file is deleted afterwards
   (also on cancel)

### Mainland China network adaptation (updates work without a VPN)

Both update paths have fallback chains and work out of the box:

| Path | Official | Fallback | Override |
|---|---|---|---|
| Version resolution | `registry.npmjs.org` | `registry.npmmirror.com` | `DSH_APP_NPM_REGISTRIES` (comma-separated) or `NPM_CONFIG_REGISTRY` |
| Artifact download | `github.com` Release | `ghfast.top`, `gh-proxy.com` (tried in order) | `DSH_APP_GITHUB_MIRRORS` (comma-separated prefixes; empty = mirrors off) |

Security model: **sha512 metadata is fetched from the official GitHub first**;
mirrors only take part in the large-file download stage, and every candidate
(official + each mirror) is verified against the same trusted sha512 — a
hijacked mirror cannot substitute content.

Connectivity self-check (run once in the target network environment):

```powershell
node scripts/probe-mirror.mjs
```

## Desktop adaptation

The shell injects desktop niceties into the web UI at runtime with zero changes
to harness source: window dragging, native window-button clearance, real-time
title-bar color sync, and a fully localized Chinese UI. Brand functionality
(sidebar, minimap, models page, …) is equally zero-upstream-change via the
plugin suite above — `--patch` overlays and slot injections. See
[ARCHITECTURE.md §2](docs/ARCHITECTURE.md) for implementation details.

Some approaches borrow from pilot-harness's `apps/desktop` (process-tree
termination, log credential redaction, settled-URL parsing from child stdout,
loopback-only URL validation, etc.).

## Building & distribution

```sh
npm run dist:win     # NSIS installer (x64 + arm64)
npm run dist:mac     # dmg + zip (x64 + arm64; notarization via env vars)
npm run dist:linux   # AppImage + deb (x64 + arm64)
```

The kernel runtime artifact is built by `scripts/build-runtime.mjs` (one per
platform/arch); CI publishes them to GitHub Releases:

```sh
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.8
```
