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
| Conversation sidebar (native views): **Git** — change list grouped by directory, unified diff with dual line numbers, stage/restore/commit, tracked-file list, graph modal (click a commit for its title/body/file stat). The file-tree tab was retired: the upstream sidebar ships workspace file management natively | `@dsh-app/plugin-sidebar` (host + client dual-face) | `plugins/plugin-sidebar/src/client/git-tab.tsx` |
| Advanced models settings page: model-level editors and whole-list management for llm-pi-ai models (reasoning effort, input modalities, compat switches); declaring a reasoning level auto-fills the compat switches (`supportsDeveloperRole` false + `maxTokensField`), additive-only and never overwriting explicit values; companion-route migration for off-catalog models; models.dev prefill with gh-proxy mirror fallback | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/models-advanced/` |
| Brand theme and bilingual (zh/en) UI: `--dsw-alias-*` token overrides | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client.ts:58` |
| Brand whale background: static frame at idle, hover-only pointer scatter (the render loop parks when the pointer leaves — no scroll jank); theme-aware contrast (light boost for legibility, dark low-alpha watermark); hovers above the composer, active phase enlarges and centers on the conversation column | `@dsh-app/plugin-client-ui` | `plugins/plugin-client-ui/src/client/whale-background.ts` |
| Cross-session memory: `memory_save`/`memory_recall`/`memory_forget` tools + system-prompt injection (newest first under budgets), global vs per-project memory files routed by session cwd; settings-page toggles; a background distiller backfills quiet sessions after 60 seconds through a direct model call (per-call tokens and duration logged), with curator sweeps gated by cooldown and file-change detection and calling the model the same way | `@dsh-app/plugin-memory` | `plugins/plugin-memory/src/{tools,routes,distiller,curator}.ts` |
| Batch subagent orchestration: independent subtasks fan out to parallel continuable children with an adaptive concurrency gate (shrinks on failure, grows on clean streaks), per-item auto-retry on preserved sessions, resume by child id; `swarm` tool + `/swarm` command | `@dsh-app/plugin-swarm` | `plugins/plugin-swarm/src/orchestrator.ts` |
| Usage statistics: balance card (official deepseek providers, CNY idle/peak dual-tier pricing, key never leaves the host), daily heatmap and trend chart; 5-minute TTL balance cache (single-flight, silent refresh on mount, forced re-query on card click) | `@dsh-app/plugin-usage` | `plugins/plugin-usage/src/client/usage-section.tsx` |
| Session archive manager: grouped by project cwd (collapsible, keyboard support), two-step delete confirm; deletion physically removes the session's log directory via `resolveCurrentLog` (pre-migration sessions fall back to a directory lookup by backend layout), and the archive record is kept as the client's visibility fence, reclaimed by the panel's prune action | `@dsh-app/plugin-archives` | `plugins/plugin-archives/src/client/archives-section.tsx` |
| MCP server manager: settings-page CRUD, dynamic mount/unmount, each server's tools registered as native `mcp__<server>__<tool>`; secret values masked on read | `@dsh-app/plugin-mcp` (dual-face) | `plugins/plugin-mcp/src/client/mcp-section.tsx` |
| External hooks bridge: settings-page CRUD over Claude Code / Codex `hooks.json` files, mounted as live hook instances that gate prompts, tools and turns | `@dsh-app/plugin-hooks` (dual-face) | `plugins/plugin-hooks/src/client/hooks-section.tsx` |
| Office document conversion: `office_to_pdf` renders docx / xlsx / pptx / pdf sources to PDF; the conversion engine (LibreOffice) installs on demand from the Diagnostics page and never ships inside the runtime; missing font families are reported one by one | `@dsh-app/plugin-doc` / `plugin-sheet` / `plugin-ppt` / `plugin-pdf` (host tools + dual-face skill prefill) | `plugins/plugin-{doc,sheet,ppt,pdf}/src/` |
| Web search: `web_search` / `web_fetch` attached as a provider (brand engine chain anysearch / Bing / Parallel / Exa / SearXNG with one-click self-check); the host half sends stable error codes only | `@dsh-app/plugin-websearch` (dual-face) | `plugins/plugin-websearch/src/` |
| Plugin market: settings-page browsing / install / uninstall of third-party dsh plugins (installed through the kernel CLI into the current profile; the market handles pnpm's supply-chain policy) | `@dsh-app/plugin-market` (dual-face) | `plugins/plugin-market/src/` |
| Preset bundles: import / export of brand + upstream configuration sets from the settings page | `@dsh-app/plugin-presets` (dual-face) | `plugins/plugin-presets/src/` |
| Brand bridge: app info, diagnostics facts and the desktop action route (the host half is still a scaffold) | `@dsh-app/plugin-brand` (host) | `plugins/plugin-brand/src/routes.ts` |

Suite wiring (performed at every server start, `src/main/brand-suite.ts`):

1. **Module resolution**: the suite plugins are linked into the shared fallback
   `$DSH_HOME/profiles/node_modules/@dsh-app/` (junction on Windows) — it
   resolves from any profile, and no profile's pnpm run prunes it; dev uses this
   repo's `plugins/*`, production the active kernel's `app/node_modules/@dsh-app/*`.
2. **A profile of its own**: the kernel boots `--profile dsh-app`, while your
   own `dsh` / `dsh web` runs keep `web`. On first run the shell creates that
   profile in the background and carries your own patch layer over (hand-written
   disables, MCP rows); **third-party packages are not carried** — the in-app
   market reinstalls them into the new profile, because it is the component that
   handles pnpm's supply-chain policy, build-script approval and specs that no
   longer resolve (both "carry the tree" variants were measured and rejected:
   copying trips over Windows' `.pnpm` symlink privilege, reinstalling trips
   over `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`). The boot switches only after
   the profile is ready; a failure keeps booting `web` and retries next launch.
   The profile in force is exported as `DSH_APP_PROFILE`, so the plugin market
   and presets always install into the profile the app actually reads.
3. **Loader overlay**: `plugins/dsh-app.patch.yml` is copied into userData and
   injected on the kernel command line (`--patch`) — suite entries applied after
   the official bundle layers (last write wins, no upstream profile template
   changes).

Every piece **degrades gracefully**: a kernel without the suite plugins (e.g. a
rollback target) boots vanilla, never blocked by brand wiring.

## Install (users)

Download the installer for your platform from
[Releases](https://github.com/JochenYang/dsh-app/releases); for mainland China
the ModelScope mirror works too — see "Mainland China network adaptation" below.

> **The current builds are not code-signed.** This is a free, community-run
> project without a signing certificate, so each platform shows its own one-time
> security prompt. That is expected — follow the steps below and the install
> completes normally; it does not affect functionality or later updates.

- **Windows**: if "Windows protected your PC" (SmartScreen) appears after
  double-clicking the installer, click "More info" → "Run anyway", then finish
  the wizard.
- **macOS**: if double-clicking the dmg reports an unverified developer, or
  that the app is damaged, open **System Settings → Privacy & Security** and
  click **Open Anyway** in the Security section, then confirm. macOS Sequoia
  (15) and later removed the Control-click → Open bypass, so that route no
  longer works.

Once installed, you can also **hand the app a folder**:

- Windows: `dsh-app.exe "D:\some-project"`, or drop a folder onto the exe /
  the desktop shortcut.
- macOS: `open -a "DSH APP" /path/to/project`.

The folder is registered as a workspace and a session is opened in it (the
session's `cwd` is that folder). If the app is **already running**, launching it
this way just **focuses the existing window** and opens the new folder as a
workspace — no second window. A path that does not exist gets an explanatory
card instead of silence.

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

In dev mode the shell uses the local checkout in place of a downloaded kernel:
the same desktop host child process (entry taken from
`apps/desktop-host/lib/index.js`, with `allowLinkedProfile` letting the linked
workspace profile boot) — no downloads, no kernel artifacts. Neither mode binds
a port, and both load `dsh-app://app`.

### Point at another checkout

```powershell
$env:DSH_APP_DEV="1"; $env:DSH_APP_DEV_RUNTIME="D:/codes/DSH-APP/deepseek-harness"; npm start
```

### Known dev/prod differences

| Item | Dev mode | Production |
|---|---|---|
| Kernel source | local checkout (desktop host child process) | preinstalled runtime under `userData/kernel/` (direct node binary) |
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

**Bundled-runtime drift detection**: on an upgrade, if the bundled runtime's
identity stamp (`<dsh version>+<suite version>`, recorded in `current.json` as
`bundledStamp`) differs from the one this install adopted (e.g. the suite
gained a plugin), boot re-extracts and re-activates the bundle — stale content
can never silently lose plugins; a newer kernel installed online is never
downgrade-overwritten (an equal stamp is skipped: a packaged tarball is not
byte-reproducible, so the comparison is the version stamp, not the sha512).

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
title-bar color sync, and a bilingual (zh/en) UI. Brand functionality
(sidebar, models page, …) is equally zero-upstream-change via the
plugin suite above — `--patch` overlays and slot injections. See
[ARCHITECTURE.md §2](docs/ARCHITECTURE.md) for implementation details.

Another desktop-side seam is the **launch folder**: a folder given as a launch
argument is opened as a workspace through a page global
(`window.__dshAppOpenWorkspace`, installed by a suite plugin and called by the
shell via `executeJavaScript`). A kernel without that plugin (a rollback
target, safe mode) is skipped silently and boots as usual — see
`src/main/workspace-launch.ts`.

## Building & distribution

```sh
npm run dist:win     # NSIS installer (x64 + arm64)
npm run dist:mac     # dmg + zip (x64 + arm64; notarization via env vars)
npm run dist:linux   # AppImage + deb (x64 + arm64)
```

App icon: `resources/icon.png` is currently a placeholder brand icon — replace it with the final icon before release;
`npm run icon:gen` generates the placeholder, `npm run icon:build` derives multi-size PNGs + ICO from it (requires Pillow).

The kernel runtime artifact is built by `scripts/build-runtime.mjs` (one per
platform/arch); CI publishes them to GitHub Releases:

```sh
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.8
```
