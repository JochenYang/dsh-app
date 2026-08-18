# DSH App

Branded desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
Windows / macOS / Linux. Public distribution.

## Architecture in one paragraph

DSH App is an **Electron thin shell** around the local dsh server. It bundles a
versioned **kernel runtime** (dsh + brand plugins), manages its lifecycle
(first install, update, rollback), and renders the existing dsh web UI in a
sandboxed window. Brand features are **dsh plugins**, never a fork — so when
upstream dsh releases, the app swaps the kernel and keeps the suite.

```
┌─ Shell (Electron)   window / tray / lifecycle / shell auto-update
│    └─ BrowserWindow → http://127.0.0.1:<port>
├─ Kernel runtime     userData/kernel/<version>/   (immutable, atomic swap)
│    ├─ node/         Node.js binary
│    ├─ app/          npm-installed dsh + @dsh-app/plugin-*
│    └─ manifest.json version + sha512
└─ Brand suite        plugin-brand (host) + plugin-client-ui (client)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design
(update mechanism, rollback, channels, packaging).

## Quick start (development)

Requires Node.js 22+ and pnpm (the dev kernel is the local dsh checkout).

```sh
# 1. Have a deepseek-harness checkout next to this repo (../deepseek-harness)
#    with `pnpm install && pnpm run build` already done.

# 2. Install shell deps and run in dev mode.
npm install
DSH_APP_DEV=1 npm start
```

In dev mode the shell spawns `pnpm dsh web` from the local checkout on a free
port — no downloads, no kernel artifacts.

### Pointing at a different checkout

```sh
DSH_APP_DEV=1 DSH_APP_DEV_RUNTIME=D:/codes/DSH-APP/deepseek-harness npm start
```

## Channels and update model

| Channel | What it updates | How |
|---|---|---|
| Shell | Electron app (window, tray, packaging) | `electron-updater` + GitHub Releases |
| Kernel | dsh + brand suite | Runtime Updater: registry check → artifact download → sha512 → atomic swap → rollback |

- **Stable** — npm `latest` dist-tag.
- **Beta** — npm `rc` dist-tag (`DSH_APP_CHANNEL=beta`).

## Building for distribution

```sh
npm run dist:win     # NSIS installer (x64 + arm64)
npm run dist:mac     # dmg + zip (x64 + arm64, notarization via env)
npm run dist:linux   # AppImage + deb (x64 + arm64)
```

Kernel runtime artifacts are built by `scripts/build-runtime.mjs` (per
platform/arch) and published by the CI workflow to GitHub Releases:

```sh
node scripts/build-runtime.mjs win32 x64 0.1.0-rc.7
```

## Before first public release (checklist)

- [ ] Set `publish.owner` in `electron-builder.yml` (GitHub org/user).
- [ ] Set `DSH_APP_ARTIFACT_OWNER/REPO` defaults or env in `src/main/index.ts`.
- [ ] macOS: Apple Developer account → `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`,
      `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` secrets.
- [ ] Windows: code-signing cert → `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` (optional; SmartScreen warning without it).
- [ ] Replace `resources/icon.png` with the real brand icon (512×512).
- [ ] Publish the brand suite to npm and switch `scripts/build-runtime.mjs` from `file:` to registry refs.
- [ ] Wire `plugins/plugin-brand` services + `plugins/plugin-client-ui` slot components in the dev loop (M3).

## Repo layout

```
src/main/        Electron shell (entry, window, tray, server, updater, ipc)
src/kernel/      Kernel runtime manager (manifest, sources, integrity, lifecycle)
src/shared/      Constants + shared types
static/          Setup window (first-run install UI)
plugins/         Brand dsh plugin suite (host + client)
scripts/         Static copy + kernel runtime artifact builder
.github/         CI: three-platform app build + runtime artifact matrix
```
