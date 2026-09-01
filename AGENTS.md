# AGENTS.md — DSH APP (dsh-app)

Guidance for AI coding agents working in this repository. Read this first;
it assumes you know nothing about the project.

## 1. Project overview

DSH APP is a **branded desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** — an Electron app
for Windows / macOS / Linux, aimed at public release. Version `0.1.0`, MIT.

The essential design idea is **"self-contained, no fork"**:

- The app **ships and installs its own versioned dsh kernel runtime** under
  `<userData>/kernel/`. It never depends on (or detects) a system-installed
  `dsh` CLI.
- All brand functionality is delivered as a **dsh plugin suite layered on the
  upstream kernel** (`plugins/`). Upstream `dsh` is never forked or patched,
  so every upstream release is just an ordinary kernel update.
- There are **two independent update channels**: the Electron shell
  (Windows: custom latest.yml detection + mirror download + silent install;
  macOS/Linux: `electron-updater` → GitHub Releases) and the dsh kernel
  (`KernelManager` → npm registry + `runtime-<version>` GitHub Release
  artifacts). They are
  decoupled: an upstream dsh release never requires a new shell build.
- Kernel updates are **atomic and reversible**: activation is a single atomic
  rewrite of `current.json`, keeping the previous version for rollback.

Full architecture: `docs/ARCHITECTURE.md` (authoritative). User-facing
README: `README.md`.

## 2. Technology stack

- **Electron 33** main process (shell), **TypeScript 5.7**, compiled to
  **CommonJS / ES2022** via `tsc` (`tsconfig.json`). `"main": "dist/main/index.js"`.
  Deps are minimal by design: `electron-updater`, `semver`, `tar`.
- **electron-builder 25** for packaging; **esbuild** for the brand client
  plugin bundle.
- The **rendered UI is not this repo's code**: the shell spawns the dsh web
  server and loads its web UI in a sandboxed `BrowserWindow`. The harness
  lives in a sibling checkout (`../deepseek-harness`) and is built with
  **pnpm** (development only — production uses a bundled kernel runtime).
- Node.js 22+ required for development; `npm` for this repo, `pnpm` for the
  harness checkout.

## 3. Repository layout

```
src/main/        Electron shell: boot/lifecycle, window, tray, server spawn,
                 shell updater, IPC, brand-suite wiring
src/kernel/      Kernel runtime manager: lifecycle, manifest I/O, integrity,
                 version/artifact resolution sources
src/shared/      Shared constants + types (imported by main + kernel)
static/          Setup/install window (first-run UI, zh-CN), no framework
plugins/         Brand plugin suite: plugin-brand (host), plugin-client-ui
                 (client), dsh-app.patch.yml (loader overlay)
scripts/         copy-static, kernel runtime build, mirror probe + dev probes,
                 release-notes generator (gen-release-notes.mjs)
CHANGELOG.md     Bilingual version changelog; feeds release-notes generation
.github/         CI: release.yml (runtime artifact matrix + app builds)
docs/            ARCHITECTURE.md
resources/       App icons
dist/            tsc + copy output (gitignored, generated)
```

### src/main (Electron shell)

| File | Responsibility |
|---|---|
| `index.ts` | Boot, single-instance lock, lifecycle orchestration, crash/rollback/cancel logic, kernel + server wiring |
| `server.ts` | `DshServer`: spawn/health-check/restart/graceful-shutdown of the dsh child process; log redaction; settled-URL parsing |
| `window.ts` | `createMainWindow` (sandboxed, desktop chrome injection, title-bar overlay sync, export toast, in-window update status card) |
| `tray.ts` | System tray menu (open, check kernel/app update, restart server, quit) |
| `updater.ts` | Shell update channel: Windows custom latest.yml + mirror download + NSIS silent install; macOS/Linux via `electron-updater` |
| `update-card.ts` | Pure injected update-card script (message + progress bar) shared by kernel and shell update progress |
| `brand-suite.ts` | Suite seams: plugin symbolic links into `$DSH_HOME` + loader overlay copy |

### src/kernel (runtime manager)

| File | Responsibility |
|---|---|
| `manager.ts` | `KernelManager`: init / check-update / download / extract / verify / activate / rollback / cleanup; `getServerSpec()` |
| `manifest.ts` | `current.json` read/write (atomic tmp+rename), `manifest.json` read helpers |
| `integrity.ts` | sha512 file hashing + comparison |
| `sources/registry.ts` | npm registry dist-tag resolution (`stable`/`beta`/`alpha`), registry fallback chain |
| `sources/artifact.ts` | GitHub Release artifact resolution + mirror fallback chain (sha512-pinned) |
| `sources/dev.ts` | Dev mode: build a manifest from the local checkout |

## 4. Kernel runtime layout & update flow

```
<userData>/kernel/
  current.json            { active, previous, installedAt, manifest }
  dsh-<v>+suite-<v>/      immutable versioned kernel
    manifest.json         KernelManifest (dshVersion, suiteVersion, platform, arch, integrity)
    node/                 Node.js binary
    app/                  package.json + node_modules (dsh + suite, npm-flattened)
  staging/                download/extract workspace (cleaned after install)
```

`current.json` is the single source of activation truth. Update flow:

1. **Resolve** the newest version from the npm registry dist-tag
   (`@deepseek-ai/dsh`: `stable` = `latest` tag, `beta` = `next` tag for rc
   builds, `alpha` = `alpha` tag — the same families dsh's own release
   pipeline publishes).
2. **Download** the runtime tarball
   (`dsh-runtime-<platform>-<arch>-<version>.tgz`) from the dedicated
   `runtime-<dshVersion>` GitHub Release (created published by CI; see §10),
   with a mirror chain; verify the **trusted sha512** (metadata sidecar
   fetched from the official host first — mirrors can never substitute
   content because every candidate is checked against the same digest).
   Before offering an update, the shell probes whether this artifact exists —
   a newer npm version without built artifacts reports "安装包尚未发布"
   instead of failing the update.
3. **Extract** into `staging/`, validate the inner `manifest.json` and that
   platform/arch match the current OS.
4. **Activate** atomically: rewrite `current.json` to
   `{ active: new, previous: old }`, then restart the server and health-check.
5. **Rollback**: if the freshly activated kernel fails to become healthy
   twice in a row, the shell rolls `current.json` back to `previous` once and
   restarts, then surfaces the error instead of looping.
6. **Cleanup**: after a healthy boot, drop any versioned dirs that are
   neither active nor previous, plus `staging/`.

The shell checks for kernel updates every 6 h (`KERNEL_CHECK_INTERVAL_MS`)
and via the tray menu (both skipped in dev mode); it does not check at
startup — a missing/broken kernel is simply (re)installed during boot. Shell
updates are checked 10 s after boot and via the tray.

## 5. Server process management

- The shell picks a **free port at runtime** (`net.listen(0)`) and pins the
  host to `127.0.0.1` (loopback passes dsh's trusted-host fence). The
  `DshServer` also **harvests the real settled URL** from the child's
  `dsh web:` stdout line, closing the find-free-port race.
- Health = HTTP 200 on the server root within `90_000` ms (`SERVER_HEALTH_TIMEOUT_MS`).
- Crash → restart with backoff (1 s, 2 s); repeated failure → kernel rollback,
  then app exit with an error dialog.
- Shutdown: SIGTERM → 8 s grace (`SERVER_SHUTDOWN_GRACE_MS`) → SIGKILL; on
  Windows a shell-mode child is killed via `taskkill /T`.
- Child stdout/stderr are line-buffered, capped at 2000 chars, **redacted**
  against credential-looking fragments, tee'd to
  `$DSH_APP_LOG_DIR/logs/dsh-server-*.log` (defaults to `logs/` under the
  working directory — that's what the repo-level `logs/` dir is).
- Tray app behavior: closing the window hides it, `window-all-closed` keeps
  the app running, quit happens via the tray menu.

## 6. Brand suite wiring (`plugins/`)

Two dsh plugins ship with the product and layer on upstream **without
forking it**:

- `@dsh-app/plugin-brand` (host side): settings namespace, app/kernel info
  service, desktop bridge — **currently a scaffold** (see TODOs in
  `plugins/plugin-brand/src/index.ts`).
- `@dsh-app/plugin-client-ui` (client side): brand theme
  (`--dsw-alias-*` token overrides), brand Models settings section
  (`BrandModelsStore` + `ModelsSection`), plus commented-out enhancement
  scaffolds (workspace file panel, reminder summary, trajectory export,
  model badges). UI copy is **zh-CN** (see §9).

Two seams are stitched at every server start (`brand-suite.ts`):

1. **Module resolution**: each plugin is symlinked (junction on Windows) into
   `$DSH_HOME/profiles/node_modules/@dsh-app/<dir>` (`$DSH_HOME` defaults to
   `~/.dsh`, overridable). Dev sources are the repo's `plugins/*`; prod
   sources are the active kernel's `app/node_modules/@dsh-app/*` (npm-installed
   via `file:` references by `scripts/build-runtime.mjs`).
2. **Loader overlay**: `plugins/dsh-app.patch.yml` is copied into `userData`
   and passed to `dsh web --patch ...`. It disables the upstream
   `ui-settings-models` page and inserts the two brand plugin entries.

Both seams **degrade gracefully**: a kernel without the suite plugins (e.g. a
rollback target) boots vanilla — no links, no overlay, boot is never blocked
by brand wiring.

## 7. Build, dev & verification commands

Prerequisites (one-time): a sibling `deepseek-harness` checkout
(`../deepseek-harness`) with `pnpm install` + `pnpm run build:web`, then
`npm install` in this repo.

```sh
# Type check (main shell + kernel). This is the primary compile gate.
npm run typecheck

# Full build: tsc -> dist/, then copy static/ assets + the brand overlay.
npm run build

# Build then launch Electron (production-like path).
npm start

# Dev mode (uses the local harness checkout, no downloads). `npm run dev` is
# the cross-platform one-liner: it sets DSH_APP_DEV=1, probes ../deepseek-harness
# and ../../deepseek-harness for the checkout, then builds + launches.
# PowerShell:  $env:DSH_APP_DEV="1"; npm start
# Override checkout:  $env:DSH_APP_DEV_RUNTIME="D:/.../deepseek-harness"
# cmd:  set DSH_APP_DEV=1 && npm start   (PowerShell does NOT support VAR=1 cmd)

# Package installers (electron-builder).
npm run dist:win     # NSIS x64+arm64
npm run dist:mac     # dmg+zip x64+arm64
npm run dist:linux   # AppImage+deb x64+arm64

# Build a kernel runtime artifact (CI does this per OS/arch).
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.8
```

Plugin builds (CI runs these before `build-runtime`):

```sh
(cd plugins/plugin-brand && npm run build)        # tsc -> lib/
(cd plugins/plugin-client-ui && npm run build)    # esbuild -> lib/client.js + lib/index.js
```

> **No automated test suite exists yet** (no test runner, no test files in
> the repo). Verification is: `npm run typecheck` + manual run in dev mode.
> Manual/probe helpers live in `scripts/`:
> `probe-mirror.mjs` (update-chain connectivity), `probe-drag.cjs` (drag
> regions + brand Models render — **keep its `CSS` in sync with**
> `src/main/window.ts` `DESKTOP_CHROME_CSS`),
> `probe-update-card.cjs` (executes the injected update-card script against a
> DOM stub — run after `npm run build`), `probe-shell-update.mjs` (Windows
> shell-update flow against the real `latest.yml`), `capture.mjs` (page
> screenshots for design work).

## 8. Environment variables

| Variable | Used in | Meaning |
|---|---|---|
| `DSH_APP_DEV=1` | `src/main/index.ts` | Dev mode: use local checkout instead of downloaded kernel |
| `DSH_APP_DEV_RUNTIME` | `src/main/index.ts` | Override the dev harness checkout path |
| `DSH_APP_CHANNEL` | `index.ts`, `build-runtime.mjs`, `dev.ts` | `alpha` → `alpha` dist-tag; `beta` → `next` dist-tag (rc); anything else = stable (`latest`) |
| `DSH_APP_ARTIFACT_OWNER` / `DSH_APP_ARTIFACT_REPO` | `index.ts` | GitHub owner/repo hosting runtime artifacts (defaults to `JochenYang` / `dsh-app`) |
| `DSH_APP_NPM_REGISTRIES` | `sources/registry.ts` | Comma-separated registry chain replacing the default (`npmjs.org` → `npmmirror.com`) |
| `NPM_CONFIG_REGISTRY` | `sources/registry.ts` | Single-registry override; npmmirror still appended as fallback |
| `DSH_APP_GITHUB_MIRRORS` | `sources/artifact.ts` | Comma-separated mirror URL prefixes; empty value disables mirrors |
| `DSH_APP_SUITE_VERSION` | `build-runtime.mjs`, `dev.ts` | Brand suite version in the runtime manifest |
| `DSH_APP_LOG_DIR` | `server.ts` | Log directory (default: `<cwd>/logs`) |
| `DSH_HOME` | `brand-suite.ts` | dsh profiles home (default `~/.dsh`) |
| `DSH_VERSION` | `build-runtime.mjs` | Kernel version to bundle (else resolved from the npm dist-tag at build time; last-resort default `0.1.0-rc.8`) |
| `PROBE_BASE` / `PROBE_TAG` / `PROBE_ASSET` / `PROBE_URL` | `probe-mirror.mjs` | Connectivity probe targets |

## 9. Code & contribution conventions

- **Language**: code comments and technical docs are **English**
  (`docs/ARCHITECTURE.md`, JSDoc). **User-facing strings are zh-CN** — status
  messages, dialogs, and the setup window are Chinese (the product ships for
  mainland users first; i18n is a follow-up). New UI copy should be zh-CN
  unless a project decision says otherwise. The repository README ships in
  both zh-CN (`README.md`) and English (`README.en.md`) with a top-of-file
  language switcher; keep both in sync and update both on every README change.
- **TypeScript**: `strict` mode; avoid `any`. Shell code is CommonJS with
  Node resolution; the client plugin uses `moduleResolution: "Bundler"` and
  imports local files with explicit `.ts` extensions (`./client/models-store.ts`).
- **Desktop adaptation must stay shell-side**: inject through
  `executeJavaScript`/stylesheets and `--patch` overlays only — never modify
  harness source. Keep the drag-region CSS mirrored in `probe-drag.cjs`.
- **Security invariants to preserve** (see `docs/ARCHITECTURE.md` §6):
  - Main window: `contextIsolation`, `sandbox`, `nodeIntegration:false`, and
    **no preload** for the remote-origin dsh UI.
  - Bind only to `127.0.0.1`; confine navigation to the local server origin,
    everything else → `shell.openExternal`.
  - Kernel downloads are **sha512-verified before activation**; keep the
    metadata-from-official-host-first rule so mirrors can't swap content.
  - Redact credential-looking fragments (`api[key|_key]`, `authorization`,
    `token`) in child logs; cap log line length.
  - Never hardcode secrets. API keys are stored via dsh's own credential
    store (`credentials.set`), not in plain settings.
- **Failure paths**: user-facing error messages are stable, actionable,
  zh-CN, and must not leak sensitive detail.
- **Generated/tracked**: `dist/`, `release/`, `runtime-dist/`,
  `plugins/*/lib/`, `logs/`, `scratch/`, `*.tgz`, `*.log` are gitignored —
  don't commit build output.
- **Commits** follow `<type>(<scope>): <subject>` (e.g. `feat:`, `fix:`) with
  an English imperative subject; the repo history uses `feat`/`fix` prefixes.
  The body lists the root cause and each change as bullets (`- `), then
  closes with a `Verified:` line — no prose paragraphs. Wrap at ~72 chars.

## 10. Release / deployment

### CI pipeline

`release.yml` triggers on a `v*` tag push (or `workflow_dispatch` with an
optional `dsh_version` input). Tag pushes run two jobs; `workflow_dispatch`
is the **runtime-only** path (publish kernel artifacts for a dsh version
without cutting a shell release):

- **runtime**: a 6-cell matrix (win32/darwin/linux × x64/arm64) builds the
  suite plugins, then `build-runtime.mjs`, and uploads
  `dsh-runtime-<os>-<arch>-<ver>.tgz` + `.sha512` + `manifest.json` to the
  dedicated **`runtime-<dshVersion>`** release (created **published** if
  absent — `GitHubArtifactResolver` resolves exactly this tag shape). The
  tagged version comes from `build-runtime`'s output: when `DSH_VERSION` is
  empty it resolves the npm dist-tag, so artifacts always match what the app
  resolves.
- **app** (tag pushes only): builds + packages the shell per OS with
  `electron-builder` and `--publish always`; macOS notarization via
  `--config.mac.notarize=true` when Apple signing secrets are present.

### Release SOP (shell version, e.g. 0.1.6)

1. **Bump + changelog**: set `version` in `package.json`; move the
   `[Unreleased]` entry in `CHANGELOG.md` to `[v0.1.6]` (bilingual rules
   below). Commit both.
2. **Tag + push**: `git tag v0.1.6 && git push origin v0.1.6`. The tag must
   equal the `package.json` version.
3. **Wait for CI green**: poll
   `gh run list --repo JochenYang/dsh-app --workflow release.yml --limit 1`
   then `gh run view <id> --repo JochenYang/dsh-app`. All 12 jobs
   (6 runtime + 6 app) must succeed; the release stays a draft.
4. **Generate release notes**:
   `node scripts/gen-release-notes.mjs v0.1.6` → writes `release-notes.md`.
5. **Publish the draft**:
   `gh release edit v0.1.6 --repo JochenYang/dsh-app --draft=false --notes-file release-notes.md`

### Release notes rules

- **Incremental only**: notes describe what changed *since the last released
  version* — never a full history or a `vX...vY` compare dump.
- **Bilingual, Chinese on top**: zh block first and open by default, English
  folded below it, wrapped in `<details>/<summary>` — GitHub strips JS/CSS in
  notes, so `<details>` is the native "click to switch" pattern. Let
  `scripts/gen-release-notes.mjs` assemble this from `CHANGELOG.md`; do not
  hand-write the HTML.
- Keep the two languages' bullets aligned (same items, same order); record
  each public/user-visible change as one bullet per language.

### Failure recovery (learned the hard way)

- **Never re-run the same tag** to "regenerate" a release: electron-builder's
  publish is not idempotent and fails 422 `already_exists` on
  installers/`latest-*.yml`. To rebuild: delete the draft release
  (`gh api -X DELETE repos/JochenYang/dsh-app/releases/<id>`), delete the tag
  (`git tag -d v0.1.6 && git push origin :refs/tags/v0.1.6`), then re-push.
- **Runtime tags are different**: `runtime-<dshVersion>` releases are created
  published and re-uploaded with `--clobber`, so re-running a failed runtime
  job (or `gh run rerun <run> --failed`) is safe and idempotent — do NOT
  delete/recreate a runtime tag, just re-upload.
- A **single failed job** recovers best with `gh run rerun <run> --failed`.
  Kernel version in runtime artifacts resolves from the registry dist-tag
  (distinct from the shell version) unless `dsh_version` is supplied.

**Remaining pre-release gaps**: `DSH_APP_ARTIFACT_OWNER` now defaults to
`JochenYang` (matching `electron-builder.yml` `publish`), so online
kernel-update downloads resolve against this repo without an injected env.
macOS signing/notarization and (optional) Windows signing secrets must be
provided as CI secrets; `resources/icon.png` is a placeholder brand icon; the
suite plugins are bundled via `file:` references and should switch to
registry versions once published.
**Temporary**: `release.yml` sets `DSH_APP_CHANNEL: alpha` on tag pushes so
runtime artifacts bundle the alpha.3 kernel the suite is adapted to (npm
`latest` still points at the older rc). Remove this line once dsh promotes
alpha to `latest`, or future formal releases will keep bundling alpha
kernels; `workflow_dispatch` with an explicit `dsh_version` is unaffected.

## 11. Known TODOs / scaffolds (do not assume finished)

- `plugin-brand/src/index.ts`: host services are scaffolds — settings
  namespace, app-info service, desktop bridge remotes are not yet wired.
- `plugin-client-ui/src/client.ts`: three enhancement slots are commented
  out (workspace file panel, reminder summary, trajectory export, model
  badges); slot ids still to be verified against the running UI.
- First-run UX: kernel download progress is wired; pause/resume and checksum
  display are not.
- Optional future: signed manifests + rollback of `$DSH_HOME` settings on
  major-version upgrades.
