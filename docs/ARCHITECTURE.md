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
│   src/main/index.ts        boot, lifecycle, crash/rollback orchestration
│   src/main/server.ts       dsh child process: spawn, health, restart, shutdown
│   src/main/window.ts       sandboxed main window + setup window
│   src/main/tray.ts         tray menu
│   src/main/updater.ts      shell channel (electron-updater)
│   src/main/ipc.ts          IPC contract for the setup window
├─ Kernel manager
│   src/kernel/manager.ts    lifecycle: init / update / activate / rollback / cleanup
│   src/kernel/sources/*     version + artifact resolution (npm registry, GitHub Releases, dev checkout)
│   src/kernel/manifest.ts   current.json + manifest I/O (atomic writes)
│   src/kernel/integrity.ts  sha512 verification
├─ Setup renderer (static/)
│   First-run install UI (progress, install/retry/cancel) over a narrow preload bridge
└─ Brand suite (plugins/)
    plugin-brand (host)      brand settings, app info, desktop bridge
    plugin-client-ui (client) brand theme + UI slot enhancements
```

## 3. Kernel runtime layout

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

## 4. Update flow (kernel channel)

```
check (startup + every 6h + manual)
  → npm registry dist-tags (@deepseek-ai/dsh): latest | rc
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

## 5. Server process management

- Dynamic free port (`net.listen(0)`), passed as `--port`; host pinned to
  `127.0.0.1` (loopback passes the dsh trusted-host fence with no extra flags).
- Health = HTTP 200 on the server root within 30 s.
- Crash → restart with backoff; repeated failure → kernel rollback.
- Shutdown: SIGTERM → 8 s grace → SIGKILL; logs tee'd to
  `<userData>/logs/dsh-server-*.log`.

## 6. Security posture

- Main window: `contextIsolation`, `sandbox`, no preload, `nodeIntegration:false`.
- Navigation confined to `127.0.0.1`; everything else → `shell.openExternal`.
- Setup window: minimal static page, explicit `contextBridge` API, CSP header.
- Kernel downloads verified by sha512 before activation (integrity from the
  release asset sidecar; can be upgraded to signed manifests later).

## 7. Packaging & distribution (M4)

- `electron-builder.yml`: win NSIS, mac dmg+zip, linux AppImage+deb; x64+arm64.
- Shell updates: `electron-updater` with GitHub Releases provider.
- Kernel artifacts: CI matrix builds `dsh-runtime-<platform>-<arch>-<version>.tgz`
  per platform/arch and attaches them to the same release.
- Signing: macOS notarization requires Apple credentials (CI secrets); Windows
  signing optional (SmartScreen without it); Linux unsigned.

## 8. Known TODOs

- `plugin-brand`: settings namespace + app-info service + desktop bridge remotes.
- `plugin-client-ui`: complete the four slot components (file panel, reminder
  summary, trajectory export, model badges) in the dev loop against the running UI.
- First-run UX polish: kernel download progress in the setup window is wired;
  add pause/resume and checksum display.
- Optional: signed manifests + rollback of `$DSH_HOME` settings on major
  version cross-grades.
