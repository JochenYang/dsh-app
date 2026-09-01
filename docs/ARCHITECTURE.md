# DSH APP — Architecture

## 1. Design goals

1. **Self-contained**: the app ships/installs its own dsh kernel. It never
   depends on (or detects) a user-installed `dsh` CLI. A "detect + install"
   flow exists only as the app's own first-run/repair path.
2. **No fork**: all brand functionality is a dsh plugin suite layered on the
   upstream kernel, so upstream releases are ordinary kernel updates.
3. **Updateable kernel, decoupled from the shell**: dsh releases frequently
   (rc cadence); the shell rarely changes. Two independent update channels.
4. **Safe updates**: every kernel activation is atomic and reversible.

## 2. Layers

```
┌─ Shell (Electron main process)
│   src/main/index.ts        boot, lifecycle, crash/rollback orchestration, bundled drift check
│   src/main/server.ts       dsh child process: spawn, health, restart, shutdown
│   src/main/window.ts       sandboxed main window + desktop chrome + update card
│   src/main/tray.ts         tray menu
│   src/main/updater.ts      shell channel: Windows mirror download + VISIBLE NSIS wizard; else electron-updater
│   src/main/brand-suite.ts  suite wiring: $DSH_HOME plugin links + --patch loader overlay
│   src/main/update-card.ts  injected card script (message + progress bar)
├─ Kernel manager
│   src/kernel/manager.ts    lifecycle: init / update / activate / rollback / cleanup
│   src/kernel/sources/*     version + artifact resolution (npm registry, GitHub Releases, dev checkout)
│   src/kernel/manifest.ts   current.json + manifest I/O (atomic writes)
│   src/kernel/integrity.ts  sha512 verification
├─ Setup renderer (static/)
│   First-run install UI (progress, install/retry/cancel) over a narrow preload bridge
└─ Brand suite (plugins/)
    plugin-brand (host)      brand settings, app info, desktop bridge (scaffold)
    plugin-client-ui (client) brand theme + advanced models settings page
    plugin-sidebar (dual-face) native conversation views: Files (tree + preview) and Git
```

## 3. Brand suite wiring

Two seams are stitched at every server start (`src/main/brand-suite.ts`):

1. **Module resolution** — `$DSH_HOME/profiles/node_modules/@dsh-app/<plugin>` is
   a junction (Windows) / symlink to the real package: dev = this repo's
   `plugins/*`, prod = the active kernel's npm-flattened
   `app/node_modules/@dsh-app/*`. `SUITE_PLUGIN_DIRS` lists
   `plugin-brand`, `plugin-client-ui`, `plugin-sidebar`
   (`brand-suite.ts:38`).
2. **Loader overlay** — `plugins/dsh-app.patch.yml` is copied into userData and
   passed via `dsh web --patch`; it inserts the three plugin entries after the
   official bundle layers (last write wins), so no upstream profile template is
   touched.

Both seams **degrade gracefully**: missing suite plugins (e.g. a rollback
target kernel) boot vanilla — no links, no overlay, boot is never blocked.

Client-side composition (all zero-upstream-change):

- **Files / Git native views** (`plugin-sidebar`): registered as
  `conversation.view` tabs beside 对话/审查/轨迹 with `order 100` / `110`
  (`client/views.tsx`), each rendering a full page — file tree with lazy
  directory loading + text/image/Markdown preview, and the Git surface
  (grouped change list, dual-line-number unified diff, stage/restore/commit,
  tracked files, graph modal with `%B` + `--stat`). Markdown previews run
  `remark-gfm` + `rehype-raw` + `rehype-sanitize` (raw HTML is rendered but
  scripts/event handlers are stripped; `client/file-tree.tsx` `MD_SCHEMA`).
- **Advanced models settings page** (`plugin-client-ui`): `settings.section`
  at `order 11` (`client.ts:185`) — model-level editors over llm-pi-ai
  providers, companion-route migration, models.dev prefill with gh-proxy
  mirror fallback.

Host side (fenced routes): everything under
`/plugins/@dsh-app/plugin-sidebar/api` (`fs-routes.ts`, `git-routes.ts`) runs
through a loopback Host fence, `execFile` with argument arrays, an env baseline
of PATH + HOME only, `windowsHide`, and reads via `sessions.binding(sessionId)`
(never the "most recent session" — blank sessions sort wrong).

## 4. Kernel runtime layout

```
<userData>/kernel/
  current.json            { active: "dsh-0.1.0-rc.8+suite-0.1.0", previous: "…", installedAt, manifest }
  dsh-<version>+suite-<v>/   immutable versioned kernel
    manifest.json           KernelManifest (dshVersion, suiteVersion, channel, platform, arch, integrity)
    node/                   Node.js binary
    app/                    package.json + node_modules (dsh + suite, npm-flattened)
  staging/                  download/extract workspace (cleaned after install)
```

`current.json` is the single source of activation truth. Versioned directories
are immutable once installed; activation is one atomic file rewrite, so a bad
boot can always point back at `previous`.

## 5. Update flow (kernel channel)

```
check (startup + every 6h + manual)
  → npm registry dist-tags (@deepseek-ai/dsh): latest | next (rc) | alpha
  → newer? → prompt
download runtime artifact (GitHub Release asset, per platform/arch)
  → sha512 verify (sidecar .sha512 asset)
extract staging → validate inner manifest + platform/arch match
  → rename into versioned dir
activate: write current.json { active: new, previous: old }
  → restart server → health check
on boot failure: rollback current.json → previous → restart → report
after healthy boot: cleanup (drop non-active/non-previous dirs + staging)
```

Rollback is automatic and bounded: a kernel that fails to become healthy twice
is rolled back once, then the app surfaces the error rather than looping.

**Bundled-runtime drift check** (`index.ts` boot, when an install already
exists): `resources/kernel/` ships the runtime tarball, its sha512 sidecar AND
a `manifest.json` (produced by `scripts/prepare-bundled-kernel.mjs`). Boot
compares the bundled sidecar sha512 against the `sha512` recorded in
`current.json` (legacy installs lack the field → always differs). When content
differs AND the bundled version is not older than the installed kernel
(`semver.gt`), the bundle is re-activated — the same-named versioned dir is
replaced and `previous` never points at itself. This is what lets an upgrade
ship new suite plugins under the same kernel version; online-installed newer
kernels are left untouched.

Artifact metadata naming: `build-runtime.mjs` publishes
`dsh-runtime-<platform>-<arch>-<ver>.tgz`, its `.sha512` sidecar, and a
platform-suffixed `manifest-<platform>-<arch>.json` (six parallel CI cells
upload distinct names). The resolver's phase-1 metadata fetch reads the
suffixed manifest (`artifact.ts:131`).

## 5. Server process management

- Dynamic free port (`net.listen(0)`), passed as `--port`; host pinned to
  `127.0.0.1` (loopback passes the dsh trusted-host fence with no extra flags).
- Health = HTTP 200 on the server root within 90 s (`SERVER_HEALTH_TIMEOUT_MS`,
  `shared/constants.ts:19`).
- Crash → restart with backoff; repeated failure → kernel rollback.
- Shutdown: SIGTERM → 8 s grace → SIGKILL; logs tee'd to
  `<userData>/logs/dsh-server-*.log`.

## 6. Security posture

- Main window: `contextIsolation`, `sandbox`, no preload, `nodeIntegration:false`.
- Navigation confined to `127.0.0.1`; everything else → `shell.openExternal`.
- Setup window: minimal static page, explicit `contextBridge` API, CSP header.
- Kernel downloads verified by sha512 before activation (integrity from the
  release asset sidecar; can be upgraded to signed manifests later).

## 8. Packaging & distribution (M4)

- `electron-builder.yml`: win NSIS, mac dmg+zip, linux AppImage+deb; x64+arm64.
- Shell updates: Windows uses a custom in-app flow — latest.yml detection via
  the GitHub `releases/latest` alias, arch-matched installer download with an
  official-first / gh-proxy-mirror fallback chain, sha512 verification, then a
  **visible** NSIS install wizard (`updater.ts`: the app quits, cmd waits for
  the wizard, records the exit code and deletes the installer afterwards —
  success or cancel). macOS/Linux keep `electron-updater`.
- Kernel artifacts: CI matrix builds `dsh-runtime-<platform>-<arch>-<version>.tgz`
  per platform/arch and attaches them to a dedicated `runtime-<dshVersion>`
  release (created published), which `GitHubArtifactResolver` resolves; kernel
  updates are thus decoupled from shell releases. The same release carries the
  platform-suffixed `manifest-<platform>-<arch>.json` (one per matrix cell,
  no shared-name clobber races).
- Signing: macOS notarization requires Apple credentials (CI secrets); Windows
  signing optional (SmartScreen without it); Linux unsigned.

## 9. Known TODOs

- `plugin-brand`: settings namespace + app-info service + desktop bridge remotes
  remain scaffolds.
- `plugin-client-ui`: the four commented-out enhancement slots (workspace file
  panel, reminder summary, trajectory export, model badges) are not wired yet;
  slot ids still to be verified against the running UI.
- `plugin-sidebar`: no automated test suite for the client components — probes
  live in `scripts/` (SSR markdown probe, kernel-manager e2e probe) and the
  plugin is verified through tsc + esbuild + headless dsh server API smokes.
- First-run UX polish: kernel download progress in the setup window is wired;
  add pause/resume and checksum display.
- Optional: signed manifests + rollback of `$DSH_HOME` settings on major
  version cross-grades.
