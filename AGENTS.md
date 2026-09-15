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

Electron 33 + TypeScript 5.7, compiled to CommonJS/ES2022 by `tsc`.
electron-builder 25 packages NSIS (win) / dmg+zip (mac) / AppImage+deb (linux),
x64 + arm64. esbuild 0.28 bundles the plugin halves; `npm` drives this repo,
`pnpm` the harness checkout. Node 22+.

```
src/main/     Electron shell: boot/lifecycle, window, tray, server spawn,
              shell updater, dialogs, safe mode, env scrub, proxy detection
src/kernel/   Kernel runtime manager: lifecycle, manifest I/O, integrity,
              version/artifact resolution sources
src/shared/   Shared constants + types
plugins/      Brand suite (17 packages) + dsh-app.patch.yml (loader overlay)
              + build-lib.mjs (shared esbuild recipe)
scripts/      Build/release tooling + hand-run probes (none run in CI)
test/         Root node:test suites (require a prior build)
static/       Empty today; copy-static.mjs still copies it when present
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
- Hand-run probes: `scripts/probe-*.mjs` (mirror, shell-update, websearch, fff)
  and the `probe-*.cjs` DOM-stub probes. `probe-drag.cjs` mirrors
  `DESKTOP_CHROME_CSS` in `src/main/window.ts` — **keep the two in sync**.

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

Dependency-install discipline: root changes use plain `npm install`;
plugin-local installs use `npm install --legacy-peer-deps` **inside the plugin
dir only**. `--legacy-peer-deps` at the ROOT prunes the peer-only tree from
`package-lock.json` and has broken `npm ci` in every CI job. When switching
kernel lines, delete root `node_modules/` first — a stale tree causes ERESOLVE
that tempts exactly that mistake.

## 4. Conventions

- **Language**: code comments and technical docs are **English**. User-facing
  strings are **zh-CN** (status messages, dialogs, tray labels, settings copy).
  `README.md` (zh-CN) and `README.en.md` are kept in sync with a top-of-file
  switcher. `CHANGELOG.md` is bilingual, 中文 first, bullets aligned 1:1.
- **TypeScript**: `strict`; avoid `any`. Shell code is CommonJS + Node
  resolution; plugins are ESM with `moduleResolution: "Bundler"` and explicit
  extensions on local imports.
- **Desktop adaptation stays shell-side**: inject via `executeJavaScript`,
  stylesheets, and `--patch` overlays only. Never modify harness source.
- **No native browser dialogs in client UI**: never `window.alert` /
  `confirm` / `prompt`. Use the in-app modal idiom (mask + centered card,
  Esc/mask = cancel, Enter = primary); `src/main/in-frame-dialog.ts` is the
  reference, `plugins/plugin-mcp/src/client/confirm-dialog.tsx` the React port.
- **Security invariants** (full list in `docs/ARCHITECTURE.md`):
  - Main window: `contextIsolation`, `sandbox`, `nodeIntegration:false`, and
    **no preload** for the remote-origin dsh UI.
  - Bind `127.0.0.1` only; confine navigation to the local server origin (host
    **and** port), everything else → `shell.openExternal` (http/https only).
  - Plugin `/api` routes need a same-origin check **plus** a loopback Host
    fence (see `plugins/plugin-sidebar/src/trust-fence.ts`).
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
| 90 s (`SERVER_HEALTH_TIMEOUT_MS`) | the server must answer HTTP 200 within this before boot is judged failed | `server.ts` |
| 8 s (`SERVER_SHUTDOWN_GRACE_MS`) | SIGTERM → SIGKILL grace, then `taskkill /T` on Windows | `server.ts` |
| `1000 ms × attempt` | crash-restart delay; the counter resets **only** on a ready server, so persistent failure terminates instead of looping | `index.ts` |
| 6 h (`KERNEL_CHECK_INTERVAL_MS`) | background kernel check — never at startup, never auto-installing | `index.ts` |
| 10 s after boot | the one automatic shell-update check; afterwards tray only | `index.ts` |
| 2000 chars / 10 files (`MAX_LOG_LINE` / `MAX_KEPT_LOG_FILES`) | child-log redaction cap and pruning | `server.ts` |
| ~30 min to hours | npm dist-tag goes live **before** the runtime matrix finishes uploading, so "安装包尚未发布" in that window is expected, not a bug | CI |
| `scripts/publish-modelscope.mjs`, `scripts/diagnose-modelscope-upload.mjs` | manual mirror drills — CI itself uses the Python SDK in `.github/scripts/` | `scripts/` |

## 6. Environment variables

| Variable | Used in | Meaning |
|---|---|---|
| `DSH_APP_DEV=1` | `index.ts` | Dev mode: local harness checkout instead of a downloaded kernel |
| `DSH_APP_DEV_RUNTIME` | `index.ts` | Explicit dev checkout path (else `../deepseek-harness`) |
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

- `plugin-brand`: host services are scaffolds — settings namespace, app-info
  service and desktop bridge remotes are not wired.
- `plugin-client-ui`: registers exactly one `settings.section` (advanced Models
  page, order 11) plus a nav-icon patch and the whale background. The
  reminder-summary / trajectory-export / model-badge slots mentioned in older
  notes are **gone from the code** — verify slot ids against the running UI
  before adding anything.
- `plugin-sidebar`: no automated test suite for its client components.
- CI runs only two of the thirteen plugin suites (see §3).
- First-run UX: kernel download progress is wired; pause/resume and checksum
  display are not (cancellation is a `TODO` in `KernelManager.download`).
- `docs/ARCHITECTURE.md` lags the code: its plugin roster says ten entries
  (there are seventeen) and it predates the safe-mode / proxy / websearch work.
- **Pre-release gaps**: macOS signing/notarization and (optional) Windows
  signing secrets must be supplied as CI secrets; `resources/icon.png` is still
  a placeholder brand icon.
- Optional future: signed kernel manifests; rollback of `$DSH_HOME` settings on
  major-version upgrades.
