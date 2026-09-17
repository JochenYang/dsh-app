# AGENTS.md — DSH APP (dsh-app)

How to work in this repository. Two companions carry the depth —
`docs/ARCHITECTURE.md` (layers, security posture, packaging) and
`plugins/README.md` (the authoritative plugin roster) — and **mechanism-level
detail lives in the code's own JSDoc**: read a module's header comment before
changing it. When a comment here and the code disagree, re-read the code.

## 1. Project shape

DSH APP is a **branded Electron client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** —
Windows / macOS / Linux, public release, MIT. Three ideas govern every change:

- **Self-contained, no fork.** The app ships and installs its own versioned
  dsh kernel under `<userData>/kernel/`; it never detects or uses a system
  `dsh`. All brand functionality is a plugin suite layered on the upstream
  kernel. The harness is never forked or patched, so an upstream release is
  just an ordinary kernel update.
- **Two decoupled update channels**: the Electron shell, and the kernel
  (`KernelManager`). An upstream dsh release never requires a new shell build.
- **Mainland China first.** Every network path (npm registries, GitHub
  assets, installers, Node dist) has a mirror chain, and the primary
  shell-update source is the ModelScope mirror rather than GitHub. This
  constraint shapes more code here than anything else.

## 2. Stack & layout

Electron 44 + TypeScript 5.7, compiled to CommonJS/ES2022 by `tsc`.
electron-builder 25 packages NSIS (win) / dmg+zip (mac) / AppImage+deb (linux),
x64 + arm64. esbuild 0.28 bundles the plugin halves; `npm` drives this repo,
`pnpm` the harness checkout. Node 22+.

```
src/main/     Electron shell: boot/lifecycle, window, tray, desktop-host
              transport (`dsh-app://` + pipes), host lifecycle, shell updater,
              dialogs, safe mode, env scrub, proxy detection
src/kernel/   Kernel runtime manager: lifecycle, manifest I/O, integrity,
              version/artifact sources, split layers (`layers.ts`)
src/shared/   Shared constants + types
plugins/      Brand suite (17 packages) + dsh-app.patch.yml (loader overlay)
              + build-lib.mjs (shared esbuild recipe)
scripts/      Build/release tooling + hand-run probes (no probe runs in CI;
              `smoke-package.mjs` and `split-runtime-layers.mjs` do)
test/         Root node:test suites (require a prior build)
static/       First-launch splash (`startup.html`), copied to `dist/static`
resources/    App icons (buildResources; window/tray icon source)
docs/         ARCHITECTURE.md + planning docs
.github/      workflows/ + scripts/ (mirror_release.py and its unit tests)
CHANGELOG.md  Bilingual (中文 first, bullets aligned), incremental; feeds
              scripts/gen-release-notes.mjs
```

Gitignored — never commit build output: `dist/`, `release/`, `runtime-dist/`,
`bundled-kernel/`, `plugins/*/lib/`, `plugins/*/.test-dist/`,
`plugins/*/package-lock.json`, `logs/`, `scratch/`, `repo/`,
`release-notes.md`, `*.tgz`, `*.log`, `__pycache__/`.

## 3. Build, dev & verification

Prerequisites (one-time): a sibling `deepseek-harness` checkout
(`../deepseek-harness`) with `pnpm install` + `pnpm run build:web`, then
`npm install` here.

```sh
# ── primary gates ──────────────────────────────────────────────────────
npm run typecheck             # tsc --noEmit; the compile gate
npm run build                 # tsc -> dist/ + static/overlay/tray icon copy
npm test                      # root tests (builds first; needs dist/)

# ── run ────────────────────────────────────────────────────────────────
npm start                     # build + launch Electron (production-like)
npm run dev                   # DSH_APP_DEV=1 + local harness checkout
#   PowerShell:  $env:DSH_APP_DEV="1"; npm start
#   Override:    DSH_APP_DEV_RUNTIME=D:/.../deepseek-harness
#   (PowerShell does NOT support `VAR=1 cmd`; cmd.exe does.)

# ── package ────────────────────────────────────────────────────────────
npm run dist:win | dist:mac | dist:linux

# ── kernel runtime artifact (CI does this per OS/arch cell) ────────────
npm run runtime:build                                   # scripts/build-runtime.mjs
node scripts/build-runtime.mjs win32 x64 0.1.5-rc.1     # pinned (asserted)

# ── suite verification against a real kernel ───────────────────────────
npm run verify                                          # smoke-suite.mjs
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

- Plugin `build.mjs` files are thin wrappers over `plugins/build-lib.mjs`. Each
  emits `lib/index.js` (host half) and `lib/client.js` (browser half, wrapped
  in the dsh client-loader closure); framework imports stay external.
- Plugin tests live in `plugins/plugin-*/tests/*.test.ts` and run through that
  plugin's own `scripts/test.mjs` (esbuild → `.test-dist/`, then `node --test`).
  **Thirteen** plugins have suites (archives, doc, hooks, market, mcp, memory,
  pdf, ppt, presets, sheet, swarm, usage, websearch); `plugin-brand`,
  `plugin-client-ui`, `plugin-fff`, `plugin-sidebar` have none.
- **CI runs only `plugin-memory` and `plugin-swarm`** — run the rest locally
  before a release.
- Hand-run probes: `scripts/probe-*.mjs` / `scripts/probe-*.cjs` (mirror,
  shell-update, websearch, fff, launch-folder, settings-nav, splash). After a
  kernel-line bump run `probe-launch-folder.mjs` (workspace service names
  against the installed kernel); after touching a settings section run
  `probe-settings-nav.cjs --lang en-US [--sweep]` (nav order, rail scrolling,
  glyphs, Han-character count of the active pane). The `probe-*.cjs` UI probes
  boot their own `dsh web --patch` harness — they exercise the kernel UI, not
  this shell. `probe-drag.cjs` mirrors `DESKTOP_CHROME_CSS` in
  `src/main/window.ts` — **keep the two in sync**.
- **A probe that runs inside Electron must pass `windowsHide: true` to every
  `spawn`** — otherwise each console child (the kernel, `taskkill`) pops a new
  terminal window onto the user's desktop.

### Rebuilding the runtime + bundled kernel

```sh
node scripts/build-runtime.mjs <platform> <arch> [version]
node scripts/prepare-bundled-kernel.mjs <platform> <arch>
```

Both outputs are gitignored; CI rebuilds them. Omit `<version>` to resolve the
followed line's dist-tag. Before bundling a **new kernel line**, bump every
`@deepseek-ai/dsh*` dependency in the root `package.json` to one spec (plugins
follow via their peer/dev deps), then verify with `npm run typecheck` and a
smoke run of `<runtime>/app` → `node_modules/@deepseek-ai/dsh/lib/bin.js
--version`.

The runtime carries three things the shell needs besides the kernel CLI:
`@deepseek-ai/dsh-web-frontend` (published per line — `latest` still points at
0.0.1-rc.5 from an older line, so it is pinned to the shipped version), the
private `@deepseek-ai/dsh-desktop-host` (never published, so `build-runtime.mjs`
takes its source from the tag of the line it ships — a worktree of a git
checkout, else a shallow clone of `DSH_APP_HOST_REPO_URL` — installs and builds
that one app, and packs it; `DSH_APP_HOST_CHECKOUT` / `DSH_APP_HOST_PACKAGE`
remain the escape hatches), and the host's own runtime dependency closure,
derived from that tarball's manifest. `build-runtime.mjs` refuses a host whose
version differs from the kernel it would ship beside, and resolves the packed
host's `workspace:` dependency specs first — pnpm cannot install them outside a
workspace, so `npm pack` output alone dies with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.

Dependency-install discipline: root changes use plain `npm install`;
plugin-local installs use `npm install --legacy-peer-deps` **inside the plugin
dir only**. `--legacy-peer-deps` at the ROOT prunes the peer-only tree from
`package-lock.json` and has broken `npm ci` in every CI job. When switching
kernel lines, delete root `node_modules/` first — a stale tree causes ERESOLVE
that tempts exactly that mistake.

## 4. Conventions

- **Language**: code comments and technical docs are **English**. Shell copy
  lives in `src/shared/locale.ts` (zh-CN + en-US): the en table is typed
  `Record<MessageKey, string>` and `t()` throws on a missing key, so neither a
  missing translation nor an unfilled param ships silently. Locale =
  `DSH_APP_LOCALE` > `app.getLocale()` > zh-CN; **zh is frozen copy** (a moved
  string stays byte-identical). `src/shared/locale.ts` is the only file under
  `src/` allowed to hold Han characters; each plugin owns its own dictionary.
  `README.md` / `README.en.md` stay in sync; `CHANGELOG.md` is bilingual
  (中文 first, bullets aligned).
- **TypeScript**: `strict`; avoid `any`. Shell code is CommonJS + Node
  resolution; plugins are ESM with `moduleResolution: "Bundler"` and explicit
  extensions on local imports.
- **Settings sections are one ordered rail.** The `order` values are a shared
  table (`docs/desktop-optimization-plan.md` §3.1): upstream pins 0/10/15/20/25,
  ours fill the gaps — **update the table in the same commit as an `order`
  change, and never reuse a taken value**. `plugin-client-ui`'s
  `src/client/settings-nav.ts` injects the rail's scroll rule and the two nav
  glyphs.
- **Host halves never send user-visible prose.** They send
  `HostText { code, params?, text? }` (`plugins/plugin-websearch/src/wire.ts`): a
  stable code the client maps to its dictionary, plus an English diagnostic in
  `text` for an unknown code. Matching on localized copy across the boundary
  once made the failure classifier read "tampered" as "network error".
- **Desktop adaptation stays shell-side**: inject via `executeJavaScript`,
  stylesheets, and profile patch rows only. Never modify harness source. Two
  shapes in use: an injected script (chrome sync, cards, splash), and a **page
  global the shell calls** (`window.__dshAppOpenWorkspace`, see
  `src/main/workspace-launch.ts`). All of them answer status tokens, never copy.
- **No native browser dialogs in client UI**: never `window.alert` /
  `confirm` / `prompt`. Use the in-app modal idiom (mask + centered card,
  Esc/mask = cancel, Enter = primary); `src/main/in-frame-dialog.ts` is the
  reference, `plugins/plugin-mcp/src/client/confirm-dialog.tsx` the React port.
- **Security invariants** (full list in `docs/ARCHITECTURE.md`):
  - **The app binds no port.** The kernel runs as a child process whose web
    surface travels over fd3/fd4 byte pipes (`src/main/desktop-host.ts`), and the
    window loads `dsh-app://app/index.html` — a scheme that must be registered
    as privileged **before** `app.ready` and served only by forwarding to that
    child (every other host in the scheme → 404, no host → 503).
  - Main window: `contextIsolation`, `sandbox`, `nodeIntegration:false`, and
    **no preload** for the dsh-app UI.
  - Confine navigation to `dsh-app://app` (the splash's `file:` document is the
    shell's own); everything else → `shell.openExternal` (http/https only).
  - **An app-origin document never goes into a sandbox frame.** The shell's
    action route trusts the top frame's stamped initiator alone
    (`src/main/shell-actions.ts`), and a sandboxed iframe reports the app's URL
    while running in an opaque origin — so never hand a document served from
    `dsh-app://app` to a frame.
  - Plugin `/api` routes are fenced by the Connection carrier (Host/Origin
    check **plus** browser authentication before a handler runs); a suite route
    carries no fence of its own. A suite plugin's host half registers with
    `ctx.connection.fetch.register(...)` and answers
    `/api/plugins/dsh-app/<plugin>/<name>` — no `@` in a path segment,
    GET/HEAD/POST only. The host keeps its `webserver` row disabled, so a
    plugin that injects `webServer` never activates and a stale
    `/plugins/@dsh-app/…/api` URL 404s.
  - Kernel downloads are sha512-verified before activation, with metadata from
    the official host first so mirrors cannot swap content.
  - Never hardcode secrets. Keys go through dsh's credential store; plugin keys
    support `$ENV:NAME` and are masked on read.
  - Redact credential-looking fragments (`api[key|_key]`, `authorization`,
    `token`, `secret`, `password`) in child logs; cap line length.
- **Failure paths**: user-facing errors are stable, actionable, zh-CN, and leak
  no sensitive detail.
- **Commits**: `<type>(<scope>): <subject>` (`feat:`/`fix:`/`chore:`/`ci:`/
  `docs:`/`test:`), English imperative subject ≤50 chars, no trailing period.
  Body: `-` bullets, one change each (2-4 preferred), wrapped at ~72 chars,
  then a standalone `Verified:` line. No prose paragraphs.

## 5. Process rules (each cost someone a bad day)

- **Gate commands must run bare — never behind a pipe.** `npm run typecheck 2>&1
  | tail -2 && git commit` commits even when typecheck fails, because `&&` sees
  `tail`'s exit code. Run the gate, check its result, then commit.
- **`fs.rmSync(dir, { recursive: true })` follows a directory junction** — under
  Electron's Node (44.4.1 / Node 24.21; the async `fs.rm` does not). Measured: a
  scratch home whose `profiles/node_modules` held junctions into an extracted
  runtime, removed with `rmSync`, emptied that runtime's own package
  directories. So a profile must never hold a link that NAMES the runtime tree:
  the 0.1.5 line's kernel tree is mirrored into the profile as HARDLINKS
  (`suite-profile.ts`, `mirrorRuntimeIntoProfile`) for exactly that reason, and
  any scratch/home cleanup of a profile-like directory uses a link-safe walker
  (`scratch/safe-rm.mjs`). The junction shape was tried first and rejected after
  reproducing the wipe twice.
- **The host child runs a real Node, never Electron's own.** The profile
  resolver loads `node-addon-require-builtin`, whose fingerprint table names
  Electron versions exactly — 44.4.1 is not in it, so an `ELECTRON_RUN_AS_NODE`
  child dies with `unsupported Electron runtime fingerprint` before composing
  anything. Production uses the runtime's bundled `node/`, dev the machine's own
  (`DSH_APP_NODE_BINARY`); `src/main/desktop-host.ts` only sets
  `ELECTRON_RUN_AS_NODE` when the executable really is Electron.
- **A suite plugin must be linked into the BOOTED PROFILE's
  `node_modules/@dsh-app`.** The host installs the harness resolver in enforcing
  mode; for a bare specifier it collects candidates from the profile's own
  `node_modules` walk and stops at the shared fallback position, which resolves
  only through the installation closure table. The shared
  `$DSH_HOME/profiles/node_modules` link alone yields
  `17 entries did not activate` and a silently vanilla UI — `brand-suite.ts`
  writes both scopes, and a pnpm install in the profile may prune the
  profile-local one, which is why it is re-linked on every start.
- **No backticks inside template-literal CSS/scripts.** `DESKTOP_CHROME_CSS`
  and the injected scripts are backtick literals; a backtick in an embedded
  comment silently terminates the string and only surfaces as a syntax error at
  the next typecheck.
- **Injected `executeJavaScript` promises must not resolve eagerly.** The
  chrome-sync loop in `src/main/window.ts` re-enters on *every* resolution, so
  an eagerly-resolving promise becomes a tight main↔renderer round-trip
  (~5-8k calls/s, ~9% CPU with the window idle). Keep such promises
  change-triggered. Triage idle burn by per-process CPU first: **GPU ≈ 0%
  beside non-zero main + renderer means an IPC loop, not rendering.**
- **The suite roster lives in five places and they must match exactly**:
  `plugins/dsh-app.patch.yml` (insert rows), `scripts/kernel-line.mjs`
  (`SUITE_PLUGINS`), `src/main/brand-suite.ts` (`SUITE_PLUGIN_DIRS`),
  `scripts/smoke-suite.mjs` (`SUITE_DIRS`), and the pre-build loop in
  `.github/workflows/release.yml`. A row without its package ships a runtime
  the loader cannot compose — every suite page silently disappears behind the
  fail-soft vanilla boot. Update all five in one commit, then run
  `smoke-suite.mjs --tgz` against a fresh build.
- **Runtime resources are derived from each plugin's own `package.json`
  `files` field**, never a hand-written list (that list once dropped
  `plugin-ppt/templates/` and `plugin-pdf/assets/` while every route still
  answered `ok:true`). `smoke-suite.mjs` asserts the resource facts a bare
  `ok:true` cannot see.
- **Upstream API drift**: structural slices plus `as unknown as` casts bypass
  the type gate — when the kernel deletes an API, plugin typecheck and unit
  tests stay green while the runtime throws silently. After every kernel-line
  bump, verify each suite plugin **end-to-end at runtime**
  (`npm run verify`, `npm run check:plugins`), never trust compile-green across
  the plugin/kernel boundary.
- **Proxy: probe before injecting.** A TUN/fake-IP client resolves every
  hostname into `198.18.0.0/15`, which `web-fetch-http` refuses as non-public
  unless the hop is proxied. The kernel installs its proxy dispatcher **once at
  boot**, so a proxy that disappears later points every outbound request —
  including direct ones — at a closed port. `src/main/proxy-detect.ts` probes
  first, an explicit user-exported proxy always wins, and the watchdog restarts
  the server only for a proxy this shell injected.
- **Web search is a provider, not a tool.** `web_search`/`web_fetch` are
  upstream's and are never replaced; new capability means registering a
  `ctx.web` provider. The seam resolves exactly one provider per call, so
  fallback lives inside the provider. `web_search`'s request type is only
  `{ query, maxResults }`.
- **The `- id: web` overlay row is a PAIR.** Patch semantics replace the whole
  config object, so naming only `searchProvider` drops `fetchProvider`,
  re-registers `web-fetch-http`, and kills the composed tree on a duplicate
  loader entry. Always write both.

### Troubleshooting anchors

Numbers and codes that tell "hung" from "still working". Values verified
against the code; the module beside each holds the full detail.

| Signal | Means | Where |
|---|---|---|
| `WEB_PROVIDER_AMBIGUOUS` | several usable search providers registered and none pinned | `ctx.web` seam |
| `WEB_PROVIDER_CONFIGURED_MISSING` | the pinned provider is not registered (e.g. the upstream row is disabled) | `ctx.web` seam |
| 90 s (`HOST_READY_TIMEOUT_MS`) | the host child must report `{type:'ready'}` on the IPC channel within this before boot is judged failed | `server.ts`, constants |
| 8 s (`HOST_SHUTDOWN_GRACE_MS`) then 5 s per signal (`HOST_SIGNAL_GRACE_MS`) | `shutdown` message + closed request pipe → SIGTERM → `taskkill /T` on Windows | `desktop-host.ts` |
| `unsupported Electron runtime fingerprint` | the host was started with Electron's own Node; the profile resolver's addon refuses it — the child runs the runtime's bundled Node | `index.ts` (`hostRuntime`) |
| `unsupported internal option "<dir>"` | the child was handed an argv shape it does not know: hosts up to 0.1.5 take `[entry, projectDir]`, 0.1.6 and later `[entry, runtimeDir, projectDir]`. The shell maps the shape from the host package's `version` and, for an unmapped one, starts on the current shape and falls back once | `desktop-host.ts` (`hostArgShape`, `DshHost.start`) |
| `installed package "@deepseek-ai/dsh" has no manifest` / `profile bundle … resolved outside the desktop profile` | a host up to 0.1.5 resolves the profile's kernel packages out of the PROFILE's own `node_modules`, not out of the runtime it was handed. The shell mirrors the runtime's `node_modules` into the profile (hardlinks, `mirrored <n> kernel entries` in the log) for that line only, and drops it again when the app moves to 0.1.6+ | `desktop-host.ts` (`hostProfileAnchor`), `suite-profile.ts` (`mirrorRuntimeIntoProfile`) |
| `N entries did not activate` | the host's enforcing profile resolver could not find a row's package: a suite plugin must be linked into the **booted profile's** `node_modules/@dsh-app`, not only the shared fallback | `brand-suite.ts` |
| `1000 ms × attempt` | crash-restart delay; the counter resets **only** on a ready host, so persistent failure terminates instead of looping | `index.ts` |
| 6 h (`KERNEL_CHECK_INTERVAL_MS`) | background kernel check — never at startup, never auto-installing | `index.ts` |
| 10 s after boot | the one automatic shell-update check; afterwards tray only | `index.ts` |
| 2000 chars / 10 files (`MAX_LOG_LINE` / `MAX_KEPT_LOG_FILES`) | child-log redaction cap and pruning | `redact.ts` / `server.ts` |
| ~30 min to hours | npm dist-tag goes live **before** the runtime matrix finishes uploading, so "安装包尚未发布" in that window is expected, not a bug | CI |
| `scripts/publish-modelscope.mjs`, `scripts/diagnose-modelscope-upload.mjs` | manual mirror drills — CI itself uses the Python SDK in `.github/scripts/` | `scripts/` |

## 6. Environment variables

| Variable | Used in | Meaning |
|---|---|---|
| `DSH_APP_DEV=1` | `index.ts` | Dev mode: local harness checkout instead of a downloaded kernel |
| `DSH_APP_DEV_RUNTIME` | `index.ts` | Explicit dev checkout path (else `../deepseek-harness`) |
| `DSH_APP_NODE_BINARY` | `index.ts` | Dev-mode Node that runs the host child (else `node` from PATH); production uses the runtime's bundled `node/node[.exe]` |
| `DSH_APP_HOST_CHECKOUT` | `build-runtime.mjs` | Already-built checkout to pack the private `@deepseek-ai/dsh-desktop-host` from, instead of taking the source from the tag; its `apps/desktop-host/lib/index.js` is required |
| `DSH_APP_HOST_PACKAGE` | `build-runtime.mjs` | Prebuilt host tarball instead of building one (pack it with `pnpm pack`, which resolves `workspace:` specs) |
| `DSH_APP_HOST_REPO` | `build-runtime.mjs` | Git checkout the host's source is taken from at `dsh-v<DSH_VERSION>` (else a sibling `../deepseek-harness` / `../../deepseek-harness`) |
| `DSH_APP_HOST_REPO_URL` | `build-runtime.mjs`, `release.yml` / `ci.yml` (`vars.DSH_APP_HOST_REPO_URL`) | Clone URL used only when no local checkout exists (default upstream); empty disables cloning. The workflows keep a non-empty default, so an unset variable moves nothing |
| `DSH_APP_HOST_TAG` | `build-runtime.mjs`, `release.yml` / `ci.yml` (`vars.DSH_APP_HOST_TAG`) | Tag the host's source is taken from (default `dsh-v<DSH_VERSION>`; empty falls back to it) |
| `DSH_APP_CHANNEL` | `index.ts`, `kernel-line.mjs`, `build-runtime.mjs` | Kernel line: `alpha` → alpha tag, `beta` → `next`, else stable. At runtime it selects the update channel; at build time it is only the explicit cross-line override (skips the spec assertion and warns) |
| `DSH_APP_ARTIFACT_OWNER` / `DSH_APP_ARTIFACT_REPO` | `shared/constants.ts` | GitHub owner/repo hosting runtime artifacts |
| `DSH_APP_SUITE_VERSION` | `kernel-line.mjs`, `sources/dev.ts` | Overrides the content-hash suite version in the runtime manifest |
| `DSH_APP_NPM_REGISTRIES` | `sources/registry.ts` | Comma-separated registry chain replacing the default |
| `NPM_CONFIG_REGISTRY` | `sources/registry.ts` | Single-registry override; npmmirror still appended |
| `DSH_APP_GITHUB_MIRRORS` | `sources/artifact.ts`, `updater.ts` | Comma-separated mirror URL prefixes; empty disables mirrors |
| `DSH_APP_LOG_DIR` | `server.ts`, `index.ts` | Log directory (default `<userData>`; logs land in `<dir>/logs`) |
| `DSH_APP_PROXY_PORTS` | `proxy-detect.ts` | Ports to probe, replacing the default list |
| `DSH_APP_PROXY_WATCHDOG_MS` | `index.ts` | Watchdog interval (default 30000) |
| `DSH_HOME` | `brand-suite.ts` | dsh profiles home (default `~/.dsh`) |
| `DSH_VERSION` | `build-runtime.mjs` | Kernel version to bundle (else resolved from the followed dist-tag, then asserted) |
| `NODE_DIST_MIRROR` | `build-runtime.mjs` | Mirror for the Node archive; `SHASUMS256.txt` still comes from nodejs.org first |
| `MODELSCOPE_TOKEN` / `MODELSCOPE_REPO` | `publish-mirror.yml`, `mirror_release.py` | Mirror credentials/target; an unset token reports `SKIPPED`. The SDK version is pinned in `MODELSCOPE_SDK_VERSION` |

## 7. Release SOP

**Which dsh line a build follows is decided by the root `package.json` alone**:
`scripts/kernel-line.mjs` reads the single spec all `@deepseek-ai/dsh*` deps
must share, maps it to a dist-tag, and owns the suite roster + `suiteVersion`
hash. `build-runtime.mjs` and the workflow's `resolve` job both assert against
it. Moving the line is therefore **one edit** — bump the root deps, then tag;
nothing in `release.yml` needs touching.

**`suiteVersion` hashes the plugins' `package.json` versions**, not their
code: a plugin change without a version bump is invisible to it, so CI's
`resolve` job reuses the published runtime and an installed app keeps the kernel
it already has. **Any change under `plugins/` needs a patch bump in that
plugin.** (The root shell version is separate: a shell-only release reuses the
runtime on purpose.)

Shell release, e.g. 0.11.10:

1. **Bump + changelog**: set `version` in `package.json`, move `[Unreleased]`
   in `CHANGELOG.md` to `[v0.11.10]` (zh/en bullets aligned). Commit both.
2. **Tag + push**: `git tag v0.11.10 && git push origin v0.11.10`. The tag must
   equal the `package.json` version.
3. **Wait for CI green**, then **verify what was built before publishing** —
   green jobs are not proof of the right content. All jobs (prepare-release +
   6 runtime + 4 app) must succeed; the release stays a draft.

   ```sh
   gh run list --repo JochenYang/dsh-app --workflow release.yml --limit 1
   gh run view <id> --repo JochenYang/dsh-app
   # the runtime job log must print this line with the kernel you meant to ship:
   #   Runtime artifact ready: …dsh-runtime-<platform>-<arch>-<version>.tgz
   ```

   Before diagnosing any "artifact missing" report, confirm the release is
   complete — all 6 cells present, each sidecar sha512 equal to the manifest's
   `integrity`:

   ```sh
   gh api repos/JochenYang/dsh-app/releases/tags/runtime-<v> --jq '.assets[].name'
   ```

   The `runtime-<dshVersion>` release **must stay flagged prerelease**.
   GitHub's `/releases/latest` alias resolves to the newest non-prerelease
   release, so a fresh runtime tag would hijack it — and since it carries no
   `latest.yml`, the shell app-update check dies on a metadata 404. (That is
   exactly how `runtime-0.1.5-rc.2` once outranked `v0.11.4`.)
4. **Notes**: `node scripts/gen-release-notes.mjs v0.11.10` → `release-notes.md`.
5. **Publish the draft**: `gh release edit v0.11.10 --repo JochenYang/dsh-app
   --draft=false --notes-file release-notes.md`. **Use your own credentials** —
   a release published by CI's `GITHUB_TOKEN` triggers nothing, silently
   skipping the mirror.
6. **Verify the mirror**: publishing triggers `publish-mirror`. Check that
   run's Summary for `OK` / `SKIPPED` (no token) / `FAILED` (reason + backfill
   command), plus the `Prune` and `Latest cleanup` sections. Confirm
   `releases/latest/` holds only this version's assets + the four `latest*.yml`.
   A failed mirror never blocks or rolls back the release. Re-mirror with
   `gh workflow run publish-mirror.yml -f tag=v0.11.10`; after a `503 commit
   publisher unavailable`, run `-f mode=diagnose` first.
7. **Runtime-only release** (`workflow_dispatch` or a kernel line bump): run
   `npm run check:plugins -- --kernel <runtime.tgz> --home <real profile dir>`
   first (without `--home` it uses a temp DSH_HOME and never writes `~/.dsh`).

Mirror internals — upload, index and prune logic — live in
`.github/scripts/mirror_release.py`, not in the YAML; review changes there.
Unit tests: `python .github/scripts/test_mirror_release.py`. Retention policy:
`keep_versions` (default 10, stable and prerelease ranked separately) governs
`releases/archive/` and `releases/prerelease/`; `releases/latest/` is instead
converged to exactly what the current release uploaded, so **the archive, not
`latest`, is the rollback source**. Deletes use a positive allowlist or a
narrower single-file guard and refuse anything else rather than deleting.

**Kernel runtime assets** (`runtime-<dshVersion>` tags, mirrored so mainland
users can fetch a 100 MB kernel without GitHub) are a separate flow behind the
same subcommand: they land under `releases/runtime/<tag>/`, never touch
`releases/versions.json` or `releases/latest/`, and prune on their own window
`keep_runtime_versions` (default **3**, independent of `keep_versions`; the tag
being published is always kept). Their delete guard is a second, disjoint
allowlist — exactly `<tag>/<file>` below `releases/runtime/`, no nesting — and
the whole plan is validated before the first delete, so a leftover runtime
version cannot shadow a shell asset or vice versa (~2 GB of logical LFS per
window). The mirror job waits for the runtime matrix to finish uploading
before it commits and refuses an incomplete cell set.

**Split layers (kernel updates transfer ~10 MiB instead of ~96 MiB).** A runtime
release also carries the same runtime split into five layers plus one index per
cell (`layers-<platform>-<arch>.json`): `node` 33.9 + `vendor` 45.5 + `dsh` 9.9 +
`suite` 6.9 + `meta` ~0 MiB, summing to the single tarball's size. Layer names
ARE the cache keys — `node`/`vendor`/`meta` are content-addressed (an identical
rebuild keeps its name, so a client reuses what it already has), `dsh`/`suite`
are version-addressed. `scripts/split-runtime-layers.mjs` produces them and
verifies its own output by re-assembling the layers alone and comparing every
file against the input tree (26 464 files today).

The client **prefers the layer path and falls back to the single tarball** on
any failure (no index, invalid index, layer 404, digest mismatch, assembly
error) — the fallback is the byte-identical legacy path, so a broken fast path
can never stop an install. Layer digests live in the per-cell index, which obeys
the same metadata rule as the `.sha512` sidecar: official host first and
fail-closed, proxy mirrors only when the official host is unreachable,
ModelScope never. Layers are cached under `<userData>/kernel/layers/`; `cleanup()`
must keep that directory and reclaims only layers the active `current.json`
record does not reference. Mirror side: layer assets are exempt from the shape
rules (their names are not version-addressed and they carry no sidecar) but they
can never satisfy the "an archive is present" requirement, so the completeness
check still fails on a missing per-cell tgz.

Release notes: incremental only (never a full history), bilingual with the zh
block open and English folded in `<details>`, generated by the script — never
hand-written HTML.

**Failure recovery**:

- **Never re-run the same tag** to "regenerate": electron-builder's publish is
  not idempotent and fails 422 `already_exists`. To rebuild:

  ```sh
  gh api -X DELETE repos/JochenYang/dsh-app/releases/<id>
  git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
  # then re-tag and push
  ```
- **Runtime tags are different** — they are created published and re-uploaded
  with `--clobber`, so re-running a failed runtime job is safe and idempotent.
- A single failed job recovers with `gh run rerun <run> --failed`, but **only
  for environmental flakes**: rerun re-executes the ORIGINAL commit, so a
  code fix needs a re-trigger (`workflow_dispatch`). Verify via `headSha`.
- **Never run two writers against one runtime tag** — both `--clobber` and the
  loser silently overwrites the winner. Before a manual re-upload, confirm no
  other `release.yml` run is in progress and that the fix is pushed
  (`git log origin/main..HEAD` empty — dispatch checks out `origin/main`, not
  your worktree).

## 8. Known TODOs / scaffolds (do not assume finished)

- **Desktop actions ride the shell's own protocol route.** They are served by
  `src/main/shell-actions.ts` under `dsh-app://app/__dsh-app/action/<name>`
  (open-logs / notify / save-text-as), inside the origin the window is already
  loaded from — so no port is bound, and the kernel child is not involved in the
  call. `plugin-brand`'s three routes for those actions cannot forward to it
  (a Node child has no `dsh-app` scheme), so they validate the payload and hand
  the CLIENT the coordinates; `plugin-client-ui`'s diagnostics page makes the
  call. The retired `desktop-bridge.ts` (loopback + bearer token) is gone with
  its `DSH_APP_BRIDGE_*` variables. Fence: cross-origin reach is refused by
  Chromium itself (the scheme is deliberately not CORS-enabled), and the shell
  stamps every request below that prefix via
  `session.webRequest.onBeforeSendHeaders` with the TOP frame's URL, the
  `webContents` id and a per-process secret — a subframe is left unstamped and
  refused. `Origin` and `Referer` never reach a `protocol.handle` request, so
  `webRequest` is the only witness of the initiator: `origin`/`sec-fetch-site` are
  read by nothing, and a worker's request never reaches the hook at all (measured
  — the page's own headers arrive untouched, which is what the secret closes).
  Only an `application/json` body is read (see the module header).
- `plugin-brand`: host routes (`/api/plugins/dsh-app/plugin-brand`) perform
  open-in-folder and pick-directory through the KERNEL's own seams
  (`sessionController`, `directoryPicker`), answer coordinates for the three
  shell actions, and serve the availability probe, the log tail and the
  diagnostics facts. Scaffolds: the `brand` settings namespace and the app-info
  service.
- `plugin-client-ui`: registers **two** `settings.section`s — advanced Models
  (order 11) and 诊断/Diagnostics (order 22: desktop-feature status, log
  directory, kernel log tail) — plus a nav-icon patch and the whale background.
  Its diagnostics page is the caller of the shell's action route. Slot ids come
  and go — verify them against the running UI before adding anything.
- `plugin-sidebar`: no automated test suite for its client components.
- CI runs only two of the thirteen plugin suites (see §3).
- First-run UX: kernel download progress is wired; pause/resume and checksum
  display are not (cancellation is a `TODO` in `KernelManager.download`).
- `docs/ARCHITECTURE.md` lags the code: its plugin roster says ten entries
  (there are seventeen) and it does not cover the safe-mode / proxy / websearch
  work.
- **Pre-release gaps**: macOS signing/notarization and (optional) Windows
  signing secrets must be supplied as CI secrets; `resources/icon.png` is a
  placeholder brand icon.
- Optional future: signed kernel manifests; rollback of `$DSH_HOME` settings on
  major-version upgrades.
