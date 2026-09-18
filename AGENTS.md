# AGENTS.md — DSH APP (dsh-app)

How to work in this repository. Depth lives in `docs/ARCHITECTURE.md` (layers,
security posture, packaging), `plugins/README.md` (plugin roster) and each
module's own JSDoc header — read it before changing the module. When this file
and the code disagree, re-read the code.

## 1. Project shape

DSH APP is a **branded Electron client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** —
Windows / macOS / Linux, public release, MIT. Constraints that govern every
change: **self-contained** (own versioned kernel, never a system `dsh`; brand
functionality is a plugin suite), **two decoupled update channels**, and
**Mainland China first** (mirror chains everywhere; ModelScope, not GitHub, is
the primary shell-update source).

## 2. Stack & layout

Electron 44 + TypeScript 5.7 → CommonJS/ES2022 via `tsc`; electron-builder packs
NSIS (win) / dmg+zip (mac) / AppImage+deb (linux); esbuild 0.28 bundles plugin
halves; `npm` here, `pnpm` in the harness checkout; Node 22+. Layout, layers and
packaging: `docs/ARCHITECTURE.md`.

Never commit build output (gitignored): `dist/`, `release/`, `runtime-dist/`,
`bundled-kernel/`, `plugins/*/lib/`, `plugins/*/.test-dist/`,
`plugins/*/package-lock.json`, `logs/`, `scratch/`, `repo/`, `release-notes.md`,
`*.tgz`, `*.log`, `__pycache__/`.

## 3. Build, dev & verification

Prerequisites (one-time): sibling `deepseek-harness` checkout at
`../deepseek-harness` with `pnpm install` + `pnpm run build:web`, then
`npm install` here.

```sh
npm run typecheck             # tsc --noEmit; the compile gate
npm run build                 # tsc -> dist/ + static/overlay/tray icon copy
npm test                      # root tests (builds first; needs dist/)
npm start                     # build + launch Electron (production-like)
npm run dev                   # DSH_APP_DEV=1 + local harness checkout
#   PowerShell: $env:DSH_APP_DEV="1"; npm start   (no `VAR=1 cmd` in PowerShell)
#   Override:   DSH_APP_DEV_RUNTIME=D:/.../deepseek-harness
npm run dist:win | dist:mac | dist:linux
npm run runtime:build                                 # scripts/build-runtime.mjs
node scripts/build-runtime.mjs <platform> <arch> [version]   # pinned if given
npm run verify                                        # smoke-suite.mjs
npm run verify -- --tgz runtime-dist/dsh-runtime-linux-x64-*.tgz
npm run check:plugins -- --kernel <runtime.tgz> --home <real profile dir>
```

Plugin builds and tests (CI installs + builds every plugin before
`build-runtime`):

```sh
for d in plugins/*/; do (cd "$d" && npm install --legacy-peer-deps && npm run build); done
(cd plugins/plugin-brand && npm run build)   # tsc -> lib/ (the one esbuild exception)
(cd plugins/plugin-memory && npm test)       # node:test via scripts/test.mjs
```

- Plugin tests live in `plugins/plugin-*/tests/*.test.ts` (per-plugin
  `scripts/test.mjs`). **Thirteen** plugins have suites; `plugin-brand`,
  `plugin-client-ui`, `plugin-fff`, `plugin-sidebar` have none. **CI runs only
  `plugin-memory` and `plugin-swarm`** — run the rest locally before release.
- Hand-run probes (`scripts/probe-*.mjs` / `.cjs`): `probe-launch-folder.mjs`
  after a kernel-line bump; `probe-settings-nav.cjs --lang en-US [--sweep]` after
  touching a settings section; `probe-drag.cjs` mirrors `DESKTOP_CHROME_CSS` in
  `src/main/window.ts` — **keep the two in sync**.
- **A probe running inside Electron must pass `windowsHide: true` to every
  `spawn`** — else each console child pops a terminal onto the user's desktop.

### Rebuilding the runtime + bundled kernel

```sh
node scripts/build-runtime.mjs <platform> <arch> [version]
node scripts/prepare-bundled-kernel.mjs <platform> <arch>
```

Both outputs are gitignored; CI rebuilds them. Omit `<version>` to resolve the
followed line's dist-tag. On a **new kernel line**, bump every
`@deepseek-ai/dsh*` dep in the root `package.json` to one spec (plugins follow via
peer/dev deps), then `npm run typecheck` and smoke `<runtime>/app` →
`node_modules/@deepseek-ai/dsh/lib/bin.js --version`. The runtime also carries the
pinned `@deepseek-ai/dsh-web-frontend` (`latest` lags), the private
`@deepseek-ai/dsh-desktop-host` (from the line's tag; escape hatches in §6), and
the **Office skills payload** at `<kernelDir>/runtime/office-skills` — a 0.1.6+
host will not boot without `<assetRoot>/scripts/check_office.py`, so it is as
mandatory as the host (meta layer).

`build-runtime.mjs` keeps only the **target-scoped** payload (step 2e,
`trimRuntimePayload`): the ported rules from upstream's desktop packaging drop
source maps, `.d.ts`, build caches, `fs-ext` compiler output, domino test
fixtures, other-platform node-pty prebuilds and the koffi import library. The
trim runs BEFORE the file inventory and the tarball, so both describe what
ships.

**The LibreOffice engine is not in the runtime artifact at all.** The kit
(`@deepseek-ai/libreoffice-kit` + its `…-kit-<platform>-<arch>` engine, ~330 MiB
unpacked / ~115 MiB compressed) leaves the tree entirely and travels in a
**second artifact**, `office-payload-<platform>-<arch>-<version>.tgz` (+
`.sha512` and an `office-payload-<platform>-<arch>.json` sidecar), built by
`buildOfficePayload` from the same assembled tree and uploaded to the same
release. `@deepseek-ai/dsh-office-to-pdf` imports the kit **statically at module
scope**, so the runtime keeps a tiny loader shim at that specifier
(`scripts/runtime-stubs/libreoffice-kit`, staged by `stageOfficeKitShim`) which
loads the real kit out of the installed payload at call time and refuses with an
actionable error while it is absent — dropping the package without the shim
makes the provider fail to LOAD, which reads as a plugin-tree fault, not as "the
engine is not installed". The payload's own install/verify/prune lives in
`src/kernel/office-payload.ts` (the settings row in 诊断 drives it; nothing
downloads automatically). Its two version numbers are load-bearing: the asset
name carries the dsh version (release assets are version-addressed, and the
mirror's completeness check reads them that way), while `<userData>/dsh-app-office/payload/<version>`
is named for the payload's CONTENT (kit version, plus the Python version when a
Python set is carried) — that is what makes a kernel update or a rollback reuse
the engine already on disk. `buildOfficePayload` installs the closure with its
own pnpm project and `supportedArchitectures` naming the target, so a
cross-target cell (win32-arm64 built on a windows x64 runner) gets ITS engine
rather than the host's; a payload without the target's engine fails the build.
A staged Python set (upstream's `primary-runtime`) rides the same artifact when
`DSH_APP_PRIMARY_RUNTIME` names one — nothing in this repo produces one yet.

Dependency installs: root changes use plain `npm install`; plugin-local installs
use `--legacy-peer-deps` **inside the plugin dir only** (at the ROOT it prunes the
peer-only tree and breaks `npm ci`); when switching kernel lines delete root
`node_modules/` first — a stale tree causes ERESOLVE.

## 4. Conventions

- **Language**: comments and docs are **English**; shell copy lives in
  `src/shared/locale.ts` (zh/en; en table typed, `t()` throws on missing keys).
  Locale = `DSH_APP_LOCALE` > `app.getLocale()` > zh-CN, **zh frozen**; only that
  file under `src/` may hold Han characters, and each plugin owns its dictionary.
  `README*.md` in sync; `CHANGELOG.md` bilingual.
- **TypeScript**: `strict`, avoid `any`; shell = CommonJS + Node resolution,
  plugins = ESM (`moduleResolution: "Bundler"`, explicit local-import extensions).
- **Settings sections are one ordered rail** — `order` values live in a shared
  table (`docs/desktop-optimization-plan.md` §3.1): **update it in the same
  commit as an `order` change; never reuse a taken value.**
- **Host halves never send user-visible prose** — only `HostText { code, params?,
  text? }` (`plugin-websearch/src/wire.ts`): a stable code the client maps to its
  dictionary, plus an English diagnostic.
- **Desktop adaptation stays shell-side** — inject via `executeJavaScript`,
  stylesheets and profile patch rows only; never modify harness source. Injected
  surfaces answer status tokens, never copy.
- **No native dialogs in client UI** (`window.alert` / `confirm` / `prompt`) —
  use the modal idiom (mask + card, Esc/mask = cancel, Enter = primary;
  `src/main/in-frame-dialog.ts`).
- **Security invariants** (full list: `docs/ARCHITECTURE.md`):
  - **No port — on the frames line**: the kernel child's web surface travels
    fd3/fd4 byte pipes; the window loads `dsh-app://app/index.html`, a scheme
    registered privileged **before** `app.ready` and served only by forwarding to
    that child (other host → 404, no host → 503). A 0.1.6-alpha.2+ host binds its
    own loopback port instead (§5).
  - Main window: `contextIsolation`, `sandbox`, `nodeIntegration:false`, **no
    preload**.
  - Navigate only within `dsh-app://app` (the splash's `file:` document is the
    shell's own); everything else → `shell.openExternal` (http/https only).
  - **An app-origin document never goes into a sandbox frame** — the action route
    trusts the top frame's stamped initiator alone, while a sandboxed iframe
    reports the app's URL from an opaque origin (`src/main/shell-actions.ts`).
  - Plugin `/api` routes are fenced by the Connection carrier (Host/Origin check
    **plus** browser auth before a handler runs); a suite plugin registers with
    `ctx.connection.fetch.register(...)` and answers
    `/api/plugins/dsh-app/<plugin>/<name>` (no `@` in a segment, GET/HEAD/POST
    only); the host's `webserver` row stays disabled.
  - Kernel downloads: sha512-verified before activation, metadata from the
    official host first so mirrors cannot swap content. Transport order for the
    bytes is official → the ModelScope copy → the public proxies
    (`assetCandidates`): the mirror is a file the project itself publishes,
    while ghfast.top / gh-proxy.com are third-party transports.
  - Never hardcode secrets: dsh's credential store; plugin keys support
    `$ENV:NAME` and are masked on read.
  - Redact credential-looking fragments (`api[key|_key]`, `authorization`,
    `token`, `secret`, `password`) in child logs; cap line length.
- **Failure paths**: user-facing errors are stable, actionable, zh-CN, leak no
  sensitive detail.
- **Commits**: `<type>(<scope>): <subject>` (`feat:`/`fix:`/`chore:`/`ci:`/
  `docs:`/`test:`); imperative, ≤50 chars, no period; body = one change per `-`
  bullet, ~72-char wrap, then a standalone `Verified:` line.

## 5. Process rules (each cost someone a bad day)

- **Gate commands must run bare — never behind a pipe**: `… | tail && git commit`
  commits on the pipe's exit code.
- **Deletes that can follow a link go through `scripts/lib/remove-tree.mjs`
  (`removeTree`), never a sync recursive call** — a profile must never hold a link
  that NAMES the runtime tree (the kernel tree is mirrored in as HARDLINKS);
  `test/recursive-delete-guard.test.mjs` audits every sync recursive delete, and
  plugin store deletes use a private walker copy.
- **The host child runs a real Node, never Electron's own** — an
  `ELECTRON_RUN_AS_NODE` child dies with `unsupported Electron runtime
  fingerprint`.
- **On the web line the profile patch must not repeat the home layer's rows** —
  the composer loads `$DSH_HOME/cordis.patch.yml` as a LAYER, so a copy is refused
  (`duplicate loader entry id`); the desktop host (frames, dev) reads the profile
  patch alone, where the copy keeps the user's rows.
- **A mirror into the profile owns PACKAGES, not a shared scope directory** —
  `@deepseek-ai` is shared with the market; a scope directory goes only with its
  last package; profile-lockfile names are the market's (`lockfileOwnedNames`);
  a bare `@scope` from an older shell narrows against `marker.runtime`. A removal
  must also be WITNESSED by that recorded runtime's own `node_modules`: a name it
  does not carry, or a runtime that is gone, is left in place (`mirrorWitnessGap`)
  — residue is recoverable, a deleted user package is not. A profile whose own
  manifest declares a package that is not installed is repaired before the host
  starts (`profile-heal.ts`), through the kernel CLI's `plugin install` with
  `DSH_HOME` pinned — the CLI resolves `--profile` as `$DSH_HOME/profiles/<name>`,
  never from its cwd.
- **The window's client state belongs to the kernel LINE that wrote it** —
  `client-state.ts` clears local storage on a line change (a per-line partition
  cannot work: fixed at window creation).
- **A suite plugin must be linked into the BOOTED PROFILE's
  `node_modules/@dsh-app`** — the enforcing resolver walks the profile's own
  `node_modules`; the shared link alone yields a silently vanilla UI, and
  `brand-suite.ts` re-links both scopes every start.
- **No backticks inside template-literal CSS/scripts** — `DESKTOP_CHROME_CSS` and
  the injected scripts are backtick literals; an embedded one silently terminates
  the string.
- **Injected `executeJavaScript` promises must not resolve eagerly** — the
  chrome-sync loop in `src/main/window.ts` re-enters on every resolution (an eager
  promise = a tight main↔renderer round-trip).
- **The suite roster lives in five places and must match exactly**:
  `plugins/dsh-app.patch.yml`, `scripts/kernel-line.mjs` (`SUITE_PLUGINS`),
  `src/main/brand-suite.ts` (`SUITE_PLUGIN_DIRS`), `scripts/smoke-suite.mjs`
  (`SUITE_DIRS`), `.github/workflows/release.yml` (pre-build loop); update all
  five in one commit, then `smoke-suite.mjs --tgz` a fresh build.
- **Runtime resources come from each plugin's own `package.json` `files` field**,
  never a hand list; `smoke-suite.mjs` asserts what a bare `ok:true` cannot.
- **Upstream API drift**: slices and `as unknown as` casts bypass the type gate —
  a kernel-deleted API leaves tests green while the runtime throws; verify each
  plugin end-to-end after every kernel-line bump (`npm run verify`,
  `npm run check:plugins`).
- **Proxy: probe before injecting** — a TUN/fake-IP client resolves hostnames into
  `198.18.0.0/15`; the kernel installs its dispatcher once at boot, so a proxy that
  disappears later points every request at a closed port. `proxy-detect.ts` probes
  first, an explicit user proxy wins, and the watchdog restarts only a
  shell-injected proxy.
- **Web search is a provider, not a tool** — `web_search`/`web_fetch` stay
  upstream's; register a `ctx.web` provider (one per call), so fallback lives
  inside it.
- **The `- id: web` overlay row is a PAIR** — patch semantics replace the whole
  object, so naming only `searchProvider` drops `fetchProvider` and kills the
  tree on a duplicate loader entry.

### Troubleshooting anchors

Numbers and codes that tell "hung" from "still working"; the module beside each
holds the full detail.

| Signal → meaning | Where |
|---|---|
| `WEB_PROVIDER_AMBIGUOUS` — several usable search providers registered, none pinned | `ctx.web` seam |
| `WEB_PROVIDER_CONFIGURED_MISSING` — the pinned provider is not registered | `ctx.web` seam |
| 90 s (`HOST_READY_TIMEOUT_MS`) — boot failed unless the host child reports `{type:'ready'}` on the IPC channel within this | `server.ts` |
| 8 s (`HOST_SHUTDOWN_GRACE_MS`) then 5 s per signal (`HOST_SIGNAL_GRACE_MS`) — `shutdown` message + closed request pipe → SIGTERM → `taskkill /T` on Windows | `desktop-host.ts` |
| `unsupported Electron runtime fingerprint` — the host was started with Electron's own Node | `index.ts` |
| `unsupported internal option "<dir>"` — argv shape the child does not know: up to 0.1.5 `[entry, projectDir]`, 0.1.6+ `[entry, runtimeDir, projectDir]`; mapped from the host `version`, falling back once | `desktop-host.ts` |
| `installed package "@deepseek-ai/dsh" has no manifest` / `profile bundle … resolved outside the desktop profile` — a host up to 0.1.5 resolves kernel packages from the PROFILE's `node_modules`, not the handed runtime; the shell mirrors the runtime's tree in (hardlinks) for that line only | `desktop-host.ts`, `suite-profile.ts` |
| `N entries did not activate` — the enforcing resolver could not find a row's package: link the suite plugin into the booted profile (§5) | `brand-suite.ts` |
| `1000 ms × attempt` — crash-restart delay; the counter resets **only** on a ready host, so persistent failure terminates instead of looping | `index.ts` |
| 6 h (`KERNEL_CHECK_INTERVAL_MS`) — background kernel check; never at startup, never auto-installing | `index.ts` |
| 10 s after boot — the one automatic shell-update check; afterwards tray only | `index.ts` |
| 2000 chars / 10 files (`MAX_LOG_LINE` / `MAX_KEPT_LOG_FILES`) — child-log redaction cap and pruning | `redact.ts` / `server.ts` |
| `GPU ≈ 0%` beside non-zero main + renderer — an injected script re-entering a loop per resolution, not a rendering problem | `window.ts` |
| ~30 min to hours — npm dist-tag goes live **before** the runtime matrix finishes uploading, so "安装包尚未发布" in that window is expected | CI |
| `scripts/publish-modelscope.mjs`, `scripts/diagnose-modelscope-upload.mjs` — manual mirror drills; CI uses the Python SDK in `.github/scripts/` | `scripts/` |
| `办公文档转换引擎尚未安装` (code `unavailable`) — the runtime's kit shim ran: the office payload is not installed (or `DSH_APP_OFFICE_PAYLOAD` was not published). A MISSING SHIM instead makes the provider fail to load, which surfaces as a plugin-tree activation fault | `src/kernel/office-payload.ts`, `scripts/runtime-stubs/` |

## 6. Environment variables

| Variable → meaning (used in) |
|---|
| `DSH_APP_DEV=1` — dev mode: local harness checkout, not a downloaded kernel (`index.ts`) |
| `DSH_APP_DEV_RUNTIME` — explicit dev checkout path, else `../deepseek-harness` (`index.ts`) |
| `DSH_APP_NODE_BINARY` — dev-mode Node for the host child, else `node` from PATH; production uses the bundled `node/node[.exe]` (`index.ts`) |
| `DSH_APP_HOST_CHECKOUT` — built checkout to pack the private host from (`apps/desktop-host/lib/index.js` required) (`build-runtime.mjs`) |
| `DSH_APP_HOST_PACKAGE` — prebuilt host tarball instead of building one (`pnpm pack`) (`build-runtime.mjs`) |
| `DSH_APP_HOST_REPO` — checkout the host source comes from at `dsh-v<DSH_VERSION>`, else sibling `../deepseek-harness` (`build-runtime.mjs`) |
| `DSH_APP_HOST_REPO_URL` — clone URL, used only with no local checkout; empty disables cloning (`build-runtime.mjs`, CI `vars.*`) |
| `DSH_APP_HOST_TAG` — tag the host source is taken from, default `dsh-v<DSH_VERSION>` (`build-runtime.mjs`, CI `vars.*`) |
| `DSH_APP_CHANNEL` — kernel line: `alpha` → alpha tag, `beta` → `next`, else stable; **unset** follows the bundled kernel's own manifest channel (`resources/kernel/manifest.json`, else the repo's `bundled-kernel/manifest.json`) and only falls back to stable with no readable manifest; at build time the cross-line override (`index.ts`, `kernel-line.mjs`, `build-runtime.mjs`) |
| `DSH_APP_ARTIFACT_OWNER` / `DSH_APP_ARTIFACT_REPO` — GitHub owner/repo hosting runtime artifacts (`shared/constants.ts`) |
| `DSH_APP_SUITE_VERSION` — overrides the runtime manifest's content-hash suite version (`kernel-line.mjs`, `sources/dev.ts`) |
| `DSH_APP_NPM_REGISTRIES` — comma-separated registry chain replacing the default (`sources/registry.ts`) |
| `NPM_CONFIG_REGISTRY` — single-registry override; npmmirror still appended (`sources/registry.ts`) |
| `DSH_APP_GITHUB_MIRRORS` — comma-separated mirror URL prefixes; empty disables mirrors (`sources/artifact.ts`, `updater.ts`) |
| `DSH_APP_LOG_DIR` — log directory, default `<userData>` (logs in `<dir>/logs`) (`server.ts`, `index.ts`) |
| `DSH_APP_PRIMARY_RUNTIME` — a staged Python set (upstream's `primary-runtime` tree, `runtime.json` required) to carry inside the office payload; unset means engine-only (`build-runtime.mjs`) |
| `DSH_APP_OFFICE_PAYLOAD` — payload directory the shell publishes to the kernel child (`<userData>/dsh-app-office/payload/<version>`, set at spawn whether or not it is installed); read per conversion by the runtime's kit shim (`index.ts`, `scripts/runtime-stubs/libreoffice-kit`) |
| `DSH_APP_PROXY_PORTS` — ports to probe, replacing the default list (`proxy-detect.ts`) |
| `DSH_APP_PROXY_WATCHDOG_MS` — watchdog interval, default 30000 (`index.ts`) |
| `DSH_HOME` — dsh profiles home, default `~/.dsh` (`brand-suite.ts`) |
| `DSH_VERSION` — kernel version to bundle, else from the followed dist-tag, then asserted (`build-runtime.mjs`) |
| `NODE_DIST_MIRROR` — mirror for the Node archive; `SHASUMS256.txt` still nodejs.org-first (`build-runtime.mjs`) |
| `MODELSCOPE_TOKEN` / `MODELSCOPE_REPO` — mirror credentials/target; an unset token reports `SKIPPED`; SDK pinned in `MODELSCOPE_SDK_VERSION` (`publish-mirror.yml`, `mirror_release.py`) |

## 7. Release SOP

**Line derivation**: the root `package.json` alone decides the dsh line —
`scripts/kernel-line.mjs` reads the one spec all `@deepseek-ai/dsh*` deps must
share, maps it to a dist-tag, and owns the suite roster + `suiteVersion`;
`build-runtime.mjs` and the workflow's `resolve` assert against it. Moving the
line = one edit (bump, tag).

**`suiteVersion` hashes plugin `package.json` versions**, not code — **any change
under `plugins/` needs a patch bump in that plugin**, or CI reuses the published
runtime (shell-only releases reuse it on purpose).

Shell release — mechanics in `.github/workflows/release.yml`; the decisions:

1. **Bump + changelog**: `version` in `package.json`; `[Unreleased]` →
   `[vX.Y.Z]` in `CHANGELOG.md` (zh/en aligned); commit both.
2. **Tag + push** `vX.Y.Z` = the `package.json` version.
3. **Verify content before publishing** (green is not proof; the release stays a
   draft): all jobs green (prepare-release + 6 runtime + 4 app); the runtime log
   prints `Runtime artifact ready: …` **and `Office payload artifact ready: …`**
   for the intended kernel; 6 cells with sidecars matching the manifest
   `integrity` (`gh api
   repos/JochenYang/dsh-app/releases/tags/runtime-<v> --jq '.assets[].name'`).
   Each cell must carry `office-payload-<cell>-<dshVersion>.tgz` (+ `.sha512`
   and `office-payload-<cell>.json`) — without it that platform's office
   conversion has no engine at all, and nothing else in the release turns red.
   The `runtime-<dshVersion>` release **must stay prerelease** —
   `/releases/latest` resolves to the newest non-prerelease release, and a runtime
   tag has no `latest.yml`, so it would break updates.
4. **Notes**: `node scripts/gen-release-notes.mjs vX.Y.Z`; incremental, bilingual
   (zh open, English in `<details>`), generated — never hand-written HTML.
5. **Publish the draft** (`gh release edit vX.Y.Z --draft=false --notes-file
   release-notes.md`) with **your own credentials** — CI's `GITHUB_TOKEN` triggers
   nothing and skips the mirror.
6. **Verify the mirror**: Summary `OK` / `SKIPPED` (no token) / `FAILED`
   (+ backfill), `Prune` and `Latest cleanup` checked, `releases/latest/` holding
   only this version + the four `latest*.yml`; a failed mirror never rolls the
   release back. Re-run `gh workflow run publish-mirror.yml -f tag=vX.Y.Z` (after
   a `503`, add `-f mode=diagnose`).
7. **Runtime-only release**: run `npm run check:plugins -- --kernel <runtime.tgz>
   --home <real profile dir>` first (no `--home` → temp DSH_HOME). The runtime
   job now queues the ModelScope mirror itself once the six-cell set is up, so
   a dispatch-run runtime no longer needs a manual backfill; if a mirror run
   failed, backfill the same way: `gh workflow run publish-mirror.yml -f
   tag=runtime-<dshVersion>`. A shell release's own mirror run never touches
   runtime assets, so "the shell mirrored fine" says nothing about them.

Facts: mirror internals in `.github/scripts/mirror_release.py` (+ tests);
`keep_versions` default 10 governs `archive/`/`prerelease/`; `latest/` is
converged to the last upload, so **the archive is the rollback source**; deletes
use allowlists/single-file guards. Runtime assets go under
`releases/runtime/<tag>/`, never into `versions.json`/`latest/`, prune on
`keep_runtime_versions` default **3**, with a disjoint `<tag>/<file>` delete
allowlist validated before the first delete. Layers: five + one index per cell;
names are the cache keys (`node`/`vendor`/`meta` content-addressed, `dsh`/`suite`
version-addressed); the client prefers layers and falls back to the tarball;
digests official-first/fail-closed/ModelScope-never; `cleanup()` keeps
`<userData>/kernel/layers/` and drops only unreferenced layers. The office
payload is part of the runtime set the mirror requires: the script reads each
cell's manifest and demands all three payload assets for every cell once any
manifest declares an `officePayload` block (so an engine-less release still
mirrors, but a failed payload upload does not), and both the workflow's wait loop
and `release.yml`'s resolve assertion name the same trio — a mirror without it
leaves that cell's office conversion a permanent 404 while the runtime install
looks healthy.

**Failure recovery**: never re-run a tag — electron-builder's publish is not
idempotent (422 `already_exists`); delete release + tag, then re-tag:

```sh
gh api -X DELETE repos/JochenYang/dsh-app/releases/<id>
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

Runtime tags re-upload with `--clobber` and are safe to re-run. `gh run rerun
<run> --failed` re-executes the ORIGINAL commit (flakes only; a fix needs
`workflow_dispatch`). Never two writers on one runtime tag: check no other
`release.yml` run is active and `git log origin/main..HEAD` is empty.

## 8. Known TODOs / scaffolds (do not assume finished)

- **Desktop actions ride the shell's own protocol route**
  (`src/main/shell-actions.ts`, `dsh-app://app/__dsh-app/action/<name>`, inside the
  loaded origin — no port, no kernel child). A Node child cannot reach the scheme,
  so `plugin-brand` hands the client coordinates and the diagnostics page calls
  it; requests carry the top frame's URL + a per-process secret (subframes
  refused).
- `plugin-brand`, `plugin-client-ui`: scaffolds and route details in their JSDoc
  and `plugins/README.md`; the client UI registers two settings sections (Models
  order 11; 诊断/Diagnostics order 22) plus a nav-icon patch — slot ids come and
  go, verify against the running UI.
- `plugin-sidebar`: no automated test suite.
- First-run UX: download progress is wired; pause/resume and checksum display are
  not (`TODO` in `KernelManager.download`).
- `docs/ARCHITECTURE.md` lags: its roster says ten plugins (there are seventeen)
  and it misses the safe-mode / proxy / websearch work.
- **Pre-release gaps**: macOS signing/notarization and optional Windows signing
  secrets must be supplied as CI secrets; `resources/icon.png` is a placeholder.
- **Office payload**: the Python half (upstream's `primary-runtime` set) is wired
  end to end — `DSH_APP_PRIMARY_RUNTIME` stages one into the payload, the shell
  hands the child `<payload>/primary-runtime`, and an engine-only payload is the
  normal case — but nothing in this repo PRODUCES one, so
  `load_workspace_dependencies` still fails with the path it looked for. The
  payload is also not bundled with the installer: a first run with no network
  converts no documents until the 诊断 row downloads it (the engine is ~115 MiB
  — deliberately not paid by users who never convert).
- Future: signed kernel manifests; `$DSH_HOME` settings rollback on major-version
  upgrades.
- **The 0.1.6-alpha.2+ host line is not shipped-ready** — its packaged path is
  unsmoked; the delivery model that would retire the `kernel/` tree, activation
  file and profile mirror is planned in
  `docs/capability-roadmap/kernel-package-set.md`.
