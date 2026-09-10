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
│   src/main/index.ts        boot, lifecycle, crash/rollback orchestration, bundled adoption check
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
└─ Brand suite (plugins/)
    plugin-brand (host)      brand settings, app info, desktop bridge (scaffold)
    plugin-client-ui (client) brand theme + advanced models settings page
    plugin-sidebar (dual-face) native conversation view: Git
    plugin-swarm (dual-face)   batch parallel subagent orchestration (swarm tool + /swarm command)
    plugin-usage (dual-face)   usage capture/aggregation + balance card, heatmap, trend chart
    plugin-archives (dual-face) session archive manager (host list/delete + settings section)
    plugin-memory (dual-face)  cross-session memory (tools + prompt injection + distiller/curator)
    plugin-fff (host)          fast file search over the FFF engine (fffind/ffgrep/fff-glob)
    plugin-mcp (dual-face)     external MCP server manager with dynamic mounting
    plugin-hooks (dual-face)   external hooks bridge (Claude Code / Codex / native rules)
```

There is no setup renderer: the first run downloads/activates the kernel in the
background and reports through the in-window update card and the tray.

## 3. Brand suite wiring

Two seams are stitched at every server start (`src/main/brand-suite.ts`):

1. **Module resolution** — `$DSH_HOME/profiles/node_modules/@dsh-app/<plugin>` is
   a junction (Windows) / symlink to the real package: dev = this repo's
   `plugins/*`, prod = the active kernel's npm-flattened
   `app/node_modules/@dsh-app/*`. `SUITE_PLUGIN_DIRS` lists
   `plugin-brand`, `plugin-client-ui`, `plugin-sidebar`, `plugin-swarm`,
   `plugin-usage`, `plugin-archives`, `plugin-memory`, `plugin-fff`,
   `plugin-mcp`, `plugin-hooks` (`brand-suite.ts:48`).
2. **Loader overlay** — `plugins/dsh-app.patch.yml` is copied into userData and
   passed via `dsh web --patch`; it inserts the ten plugin entries after the
   official bundle layers (last write wins), so no upstream profile template is
   touched.

Both seams **degrade gracefully**: missing suite plugins (e.g. a rollback
target kernel) boot vanilla — no links, no overlay, boot is never blocked.

Client-side composition (all zero-upstream-change):

- **Git native view** (`plugin-sidebar`): registered as a `conversation.view`
  tab beside 对话/审查/轨迹 (`client/views.tsx`), rendering the Git surface —
  grouped change list, dual-line-number unified diff, stage/restore/commit,
  tracked files, graph modal with `%B` + `--stat`. The file-tree tab was retired
  once the upstream sidebar shipped workspace file management.
- **Advanced models settings page** (`plugin-client-ui`): `settings.section` —
  model-level editors over llm-pi-ai providers, companion-route migration,
  models.dev prefill with gh-proxy mirror fallback.

Host side (fenced routes): everything under
`/plugins/@dsh-app/plugin-sidebar/api` (`git-routes.ts`) runs through a loopback
Host fence, `execFile` with argument arrays, an env baseline of PATH + HOME
only, `windowsHide`, and reads via `sessions.binding(sessionId)` (never the
"most recent session" — blank sessions sort wrong). Every other suite plugin's
`/api` routes carry the same loopback fence.

## 4. Kernel runtime layout

```
<userData>/kernel/
  current.json            { active: "dsh-<dshVersion>+suite-<suiteVersion>", previous: "…",
                            installedAt, manifest, sha512?, bundledStamp? }
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
check (every 6 h + manual; never at startup)
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

**Bundled-runtime adoption** (`index.ts` boot, when an install already exists):
`resources/kernel/` ships the runtime tarball, its sha512 sidecar AND a
`manifest.json` (produced by `scripts/prepare-bundled-kernel.mjs`). The bundle's
identity — `<dshVersion>+<suiteVersion>` from that manifest — is recorded in
`current.json` as `bundledStamp` when it is adopted, so boot asks the only
question that matters: *has this install seen THIS bundled tarball?* It adopts
the bundle when the stamp differs (a new shell shipped a different runtime,
which is how an upgrade delivers new suite plugins under the same kernel
version) and skips it when the installed kernel is already ahead (an online
update must never be rolled back to an older bundle). Version arithmetic alone
cannot express either half.

The tarball sha512 is deliberately not the comparison key: a packaged runtime
tarball is not byte-reproducible across builds, so a hash comparison would
re-extract an identical runtime on every boot.

Artifact metadata naming: `build-runtime.mjs` publishes
`dsh-runtime-<platform>-<arch>-<ver>.tgz`, its `.sha512` sidecar, and a
platform-suffixed `manifest-<platform>-<arch>.json` (six parallel CI cells
upload distinct names). The resolver's phase-1 metadata fetch reads the
suffixed manifest (`sources/artifact.ts`).

Which kernel line a build follows is decided by `package.json` alone (the
`@deepseek-ai/dsh*` dependencies), resolved by `scripts/kernel-line.mjs` and
asserted in both the build and CI — see `AGENTS.md` §10.

## 6. Server process management

- Dynamic free port (`net.listen(0)`), passed as `--port`; host pinned to
  `127.0.0.1` (loopback passes the dsh trusted-host fence with no extra flags).
- Health = HTTP 200 on the server root within 90 s (`SERVER_HEALTH_TIMEOUT_MS`,
  `shared/constants.ts:34`).
- Crash → restart with backoff; repeated failure → kernel rollback. A crash
  during startup is reported once (through the rejected `start()`), not twice.
- Shutdown: SIGTERM → 8 s grace → SIGKILL; logs tee'd to
  `<userData>/logs/dsh-server-*.log` (kernel diagnostics go to
  `<userData>/logs/dsh-kernel.log`).

## 7. Security posture

- Main window: `contextIsolation`, `sandbox`, no preload, `nodeIntegration:false`.
- Navigation confined to the server's own origin; everything else →
  `shell.openExternal`. The origin is retargeted when a kernel update restarts
  the server on a new port.
- Plugin `/api` routes: same-origin check **plus** a loopback Host fence, so a
  DNS-rebinding request cannot reach them by presenting a matching Origin.
- Kernel downloads verified by sha512 before activation (integrity from the
  release asset sidecar; can be upgraded to signed manifests later).

## 8. Packaging & distribution (M4)

- `electron-builder.yml`: win NSIS, mac dmg+zip, linux AppImage+deb; x64+arm64.
- Shell updates: Windows uses a custom in-app flow — latest.yml detection via
  the GitHub `releases/latest` alias, arch-matched installer download with an
  official-first / gh-proxy-mirror fallback chain, sha512 verification, then a
  **visible** NSIS install wizard (`updater.ts`: the app writes a
  pending-install record and quits; the GUI installer is spawned directly —
  a detached cmd watcher always flashes a console window on Windows, even
  with `windowsHide` — and the next boot deletes the leftover package and
  confirms the version advanced, toasting when it did not).
  macOS/Linux keep `electron-updater`.
- Kernel artifacts: CI matrix builds `dsh-runtime-<platform>-<arch>-<version>.tgz`
  per platform/arch and attaches them to a dedicated `runtime-<dshVersion>`
  release (created published), which `GitHubArtifactResolver` resolves; kernel
  updates are thus decoupled from shell releases. The same release carries the
  platform-suffixed `manifest-<platform>-<arch>.json` (one per matrix cell,
  no shared-name clobber races). An existing release is reused only when it is
  complete AND its suite version matches the tree's.
- Signing: macOS notarization requires Apple credentials (CI secrets); Windows
  signing optional (SmartScreen without it); Linux unsigned.

## 9. Known TODOs

- `plugin-brand`: settings namespace + app-info service + desktop bridge remotes
  remain scaffolds.
- `plugin-client-ui`: the four commented-out enhancement slots (workspace file
  panel, reminder summary, trajectory export, model badges) are not wired yet;
  slot ids still to be verified against the running UI.
- `plugin-sidebar`: no automated test suite for the client components — the
  plugin is verified through tsc + esbuild + headless dsh server API smokes.
- First-run UX: kernel download progress is wired into the in-window update
  card; pause/resume and checksum display are not.
- Optional: signed manifests + rollback of `$DSH_HOME` settings on major
  version cross-grades.
