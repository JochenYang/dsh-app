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
delivered as dsh plugins — upstream is never forked. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the layered design, kernel
runtime layout, update & rollback mechanism, and packaging.

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
See [ARCHITECTURE.md §3–4](docs/ARCHITECTURE.md) for the runtime layout and the
full update flow.

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
title-bar color sync, and a fully localized Chinese UI. See
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
