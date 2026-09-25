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
    plugin-client-ui (client) brand theme + advanced models settings page + diagnostics page
    plugin-sidebar (dual-face) native conversation view: Git
    plugin-swarm (dual-face)   batch parallel subagent orchestration (swarm tool + /swarm command)
    plugin-usage (dual-face)   usage capture/aggregation + balance card, heatmap, trend chart
    plugin-archives (dual-face) session archive manager (host list/delete + settings section)
    plugin-memory (dual-face)  cross-session memory (tools + prompt injection + curator)
    plugin-mcp (dual-face)     external MCP server manager with dynamic mounting
    plugin-hooks (dual-face)   external hooks bridge (Claude Code / Codex / native rules)
    plugin-websearch (dual-face) web_search/web_fetch as a provider: brand engine chain + self-check
    plugin-market (dual-face)  third-party plugin market: install/uninstall into the booted profile
    plugin-presets (dual-face) preset bundles: import/export of brand + upstream configuration
    plugin-doc / plugin-sheet / plugin-ppt / plugin-pdf (dual-face)
                               office_to_pdf conversion per source format: host tool + client skill
                               prefill, over the LibreOffice engine installed on demand (§4.1)
```

There is no setup renderer: the first run downloads/activates the kernel in the
background and reports through the in-window update card and the tray.

## 3. Brand suite wiring

Three pieces are stitched at every server start (`src/main/brand-suite.ts`,
`src/main/suite-profile.ts`):

1. **Module resolution** — `$DSH_HOME/profiles/node_modules/@dsh-app/<plugin>` is
   a junction (Windows) / symlink to the real package: dev = this repo's
   `plugins/*`, prod = the active kernel's npm-flattened
   `app/node_modules/@dsh-app/*`. `SUITE_PLUGIN_DIRS` lists every member
   (`plugins/README.md` is the roster). The links stay in that shared fallback
   on purpose: it resolves from any profile (Node's parent walk reaches it) and
   it is the one directory no profile's pnpm run prunes.
2. **Profile** — the suite boots its own profile, `dsh-app`
   (`SUITE_PROFILE` in `src/shared/constants.ts`); a user's own `dsh` /
   `dsh web` runs keep `web`. On first run the shell creates that profile from
   the shipped template's bundle list and carries the user's own patch layer
   across (hand-written disables, MCP rows); third-party packages are NOT
   carried — the in-app market reinstalls them into the new profile, because it
   is the component that already handles pnpm's supply-chain policy,
   build-script approval and specs that no longer resolve (carrying the tree was
   measured and rejected: copying hits `EPERM` on pnpm's `.pnpm` symlinks on
   Windows, reinstalling hits `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`). The
   work runs in the background and the boot switches only once a marker records
   success; a failure keeps booting `web` and retries next launch. The profile
   in force is exported to the child as `DSH_APP_PROFILE`, so plugin-market and
   plugin-presets install into the profile the app reads.
3. **Loader overlay** — `plugins/dsh-app.patch.yml` is copied into userData and
   passed on the kernel command line (`dsh --profile <name> --patch <file>`); it
   inserts the suite entries after the official bundle layers (last write wins),
   so no upstream profile template is touched.

Every piece **degrades gracefully**: missing suite plugins (e.g. a rollback
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
- **Maintenance settings section** (`plugin-client-ui`, one rail row at order
  22): the suite's three upkeep pages — usage statistics (`plugin-usage`),
  preset packages (`plugin-presets`) and diagnostics — as TABS of that one
  section. The owner declares the child list slot
  `settings.dsh-app-maintenance.tab` in the same `register()` call that
  contributes the section, draws the strip, and mounts one contribution per
  panel (`renderSlot(key, {}, { only: id })`); the contributors register into
  that slot from their own client halves. This is the kernel's own 内置插件
  section pattern, copied rather than reinvented — a tab keeps its state once
  selected, and a single remaining contribution renders as the page itself. The
  slot's `SlotMap` augmentation is repeated in the three client entries (the
  suite ships no shared package) and pinned identical by
  `plugins/plugin-client-ui/tests/settings-merge.test.ts`.

Host side (suite routes on the Connection carrier): every suite plugin registers
its routes with `ctx.connection.fetch.register` and they answer under
`/api/plugins/dsh-app/<plugin>/<name>` — a path segment may not contain `@`, and
only GET/HEAD/POST are admitted. The carrier (see §2) applies its Host/Origin
fence and browser authentication before a handler runs, so a route carries no
fence of its own. `plugin-sidebar`'s git routes (`git-routes.ts`) still use
`execFile` with argument arrays, an env baseline of PATH + HOME only,
`windowsHide`, and reads via `sessions.binding(sessionId)` (never the
"most recent session" — blank sessions sort wrong).

**Web search is a provider, not a tool** (`plugin-websearch`): the suite
registers one `ctx.web` search provider (`dsh-app`) whose engine chain
(anysearch / bing / parallel / exa / searxng) falls back per call; the
model-facing `web_search` / `web_fetch` tools stay upstream's, so the kernel
upgrades its tools while the brand chain keeps answering behind them. A host
route never sends user-visible prose — only a stable code the client maps to
its own dictionary plus an English diagnostic (`src/wire.ts`).

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

`app/node_modules` holds only what this artifact's platform/arch can load:
`build-runtime.mjs` drops build and diagnostic files plus the payload for other
platforms before the inventory and the tarball are written
(`docs/agents/build-and-release.md` §1). The
one exclusion that goes further is the LibreOffice engine, which is not in the
runtime at all — see below.

### 4.1 The office payload (the engine that is NOT in the runtime)

```
<userData>/dsh-app-office/
  office-skills/            materialized from <kernelDir>/runtime/office-skills
                            (the four skill files the host's boot check needs)
  payload/<payloadVersion>/ the installed engine: manifest.json + node_modules
                            (@deepseek-ai/libreoffice-kit, its closure and the
                            target's `…-kit-<platform>-<arch>` engine)
  payload/.staging-*/       in-flight download/extract, removed on success or
                            failure; a version becomes visible by one rename
```

The engine is ~115 MiB compressed, only needed when a document is converted, and
identical for every kernel that wants the same kit — so it travels in a second
release artifact (`office-payload-<platform>-<arch>-<dshVersion>.tgz`, resolved
by the same official-first metadata chain and the same ModelScope → official →
proxies transport order as the runtime) and is installed on
demand from the 诊断 settings row. The runtime keeps a loader shim at
`app/node_modules/@deepseek-ai/libreoffice-kit` because
`@deepseek-ai/dsh-office-to-pdf` imports that specifier **statically at module
scope**: without it the provider fails to load, which is a plugin-tree fault
rather than "the engine is not installed". The shim loads the real kit out of
`DSH_APP_OFFICE_PAYLOAD` at call time (`scripts/runtime-stubs/libreoffice-kit`),
so a payload installed while the kernel runs takes effect without a restart, and
an absent one produces an actionable refusal instead of a mystery failure.

The install directory is named for the payload's CONTENT version (kit version,
plus the Python version when a Python set is carried), never the dsh version:
that is what makes a kernel update — or a rollback — reuse what is already on
disk. The exception is the release ASSET name, which carries the dsh version
because every asset of a runtime release is version-addressed (the mirror's own
completeness check reads it that way). `src/kernel/office-payload.ts` owns
resolve/verify/extract/swap/prune; nothing downloads automatically.

**Fonts are deliberately not bundled.** The engine uses the families a document
declares when the machine has them and substitutes when it does not, reporting
every family it could not supply (`missingFonts`, surfaced by `office_to_pdf` and
by the preview's font notice) — that reporting is the difference from an office
suite that swaps silently. A bundled font is only worth its bytes if it changes
that substitution, and it does not: measured on a 36-slide deck that declares
`Noto Sans CJK SC` / `Noto Serif CJK SC` (absent from this host), passing the
kit's `fontDirectories` and also dropping the face into the engine's own
`share/fonts/truetype` left the conversion byte-identical, because the kit's
default fallback groups rank `微软雅黑` / `黑体` above `Noto Sans SC` and any
Chinese Windows has them. The bundled face is picked only when nothing else can
cover the glyphs — a host with no CJK fonts at all, which is not this product's
audience (the kit's README says the same about minimal Linux containers).

## 5. Update flow (kernel channel)

```
check (every 6 h + manual; never at startup)
  → npm registry dist-tags (@deepseek-ai/dsh): latest | next (rc) | alpha
  → newer? → prompt
download runtime artifact (GitHub Release asset, per platform/arch)
  → candidates: ModelScope copy → official release → public proxies, sha512
    verified against the official sidecar on EVERY candidate
extract staging → validate inner manifest + platform/arch match
  → rename into versioned dir
activate: write current.json { active: new, previous: old }
  → restart server → health check
on boot failure: rollback current.json → previous → restart → report
after healthy boot: cleanup (drop non-active/non-previous dirs + staging)
```

Rollback is automatic and bounded: a kernel that fails to become healthy twice
is rolled back once, then the app surfaces the error rather than looping.

**Office payload (a second, on-demand download)**: the runtime manifest may
carry an `officePayload` record (version, platform, arch, engine, python). When
it does, the 诊断 settings row can fetch
`office-payload-<platform>-<arch>-<dshVersion>.tgz` from the same release tag
through the same metadata chain, verify it against the sidecar sha512, validate
its inner manifest against the record, and swap it into
`<userData>/dsh-app-office/payload/<version>` with one rename
(`src/kernel/office-payload.ts`). It is never fetched at boot and never
automatically: a kernel that declares no payload (dev mode, an older runtime)
reports so instead. Because the install directory is keyed on the payload's
content version, a kernel update or rollback reuses the engine already on disk;
a new kit version installs the new payload and prunes the old one.

**Channel and the bundled kernel** (`src/kernel/bundled.ts`): the line a run
follows defaults to the bundled kernel's own `channel` — read from
`resources/kernel/manifest.json` when packaged, else the repo's
`bundled-kernel/manifest.json` — and only falls back to `stable` when no
manifest is readable. `DSH_APP_CHANNEL` still overrides it.

The two kernels a shell can install are resolved independently (the shell ships
whenever it ships; a registry line moves on its own cadence), so neither is
newer by construction. `preferredKernel({ bundled, resolved })` decides which
one a boot install uses — the bundle when it is newer or equal (no download for
bytes already on disk), the channel's version when that is newer (today's
download flow, including the "artifact pending" answer when the runtime is not
published yet), and each branch falls back to the other so a first run fails
only when neither can produce a kernel. The update offer treats the bundle as a
third candidate the same way, and can offer it on its own when the channel's
release has no artifact yet.

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

**Install-time kernel extraction** (`scripts/installer/extract-kernel.nsh`,
`src/kernel/staged.ts`): the Windows installer unpacks the bundled tarball into
`resources/kernel-staged/` while it installs (an NSIS `customInstall` hook over
Windows' own `tar.exe`), so the first launch activates the staged tree — a
rename, or a copy when userData sits on another volume — instead of unpacking
~13k files behind the splash. The tarball's sha512 is verified against its
sidecar BEFORE the staged tree is touched, and every fault (no stage, a
half-written stage, a manifest that disagrees with the bundle) falls back to
the app's own extraction path — a failed pre-extraction is a slower first
launch, never a broken install. The stage is an installer artifact: dev and
unpackaged runs have none and follow the tarball path.

Artifact metadata naming: `build-runtime.mjs` publishes
`dsh-runtime-<platform>-<arch>-<ver>.tgz`, its `.sha512` sidecar, and a
platform-suffixed `manifest-<platform>-<arch>.json` (six parallel CI cells
upload distinct names). The resolver's phase-1 metadata fetch reads the
suffixed manifest (`sources/artifact.ts`).

Which kernel line a build follows is decided by `package.json` alone (the
`@deepseek-ai/dsh*` dependencies), resolved by `scripts/kernel-line.mjs` and
asserted in both the build and CI — see `docs/agents/build-and-release.md` §3.

## 6. Server process management

- The window loads `dsh-app://app/index.html`, served only by forwarding to the
  kernel child. Two transports carry that forward, chosen by the host package's
  own version: up to `0.1.6-alpha.1` the web surface travels over fd3/fd4 byte
  pipes and **no port is bound** (`src/main/desktop-host.ts`); from
  `0.1.6-alpha.2` on, the child binds its own loopback port, reports an
  authenticated URL over IPC, and the shell exchanges that URL for a cookie and
  forwards with it (`src/main/host-web.ts`). That line's child is reachable from
  the rest of the machine, and the shell's own origin model — the scheme, the
  window URL, the action route — is unchanged by either transport.
- The URL transport is not only a proxy: the client's own stream is a WebSocket
  straight to the child. The boot document carries
  `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }` (the row
  upstream's desktop sets from its preload; this shell's preload is a marker only —
  `src/main/account-preload.ts` — so the transport row comes from the host's own
  document instead),
  and `src/main/host-stream-auth.ts` rewrites `ws://127.0.0.1/*` handshakes from
  the main window to carry that child's cookie and an `origin` it accepts —
  cancelling any handshake whose `origin` is not `dsh-app://app`. Removing either
  half leaves the window connected to nothing: no session list, `[connection]
  connection lost, retry` in the client console.
- Health = the child reports `{type:'ready'}` on the IPC channel within 90 s
  (`HOST_READY_TIMEOUT_MS`); on the URL transport the start then also
  authenticates that URL (same deadline) before it resolves.
- Crash → restart with backoff; repeated failure → kernel rollback. A crash
  during startup is reported once (through the rejected `start()`), not twice.
- Shutdown: SIGTERM → 8 s grace → SIGKILL; logs tee'd to
  `<userData>/logs/dsh-server-*.log` (kernel diagnostics go to
  `<userData>/logs/dsh-kernel.log`).
- **Safe mode** (`src/main/safe-mode.ts`): a boot switch that drops the suite's
  overlay rows (the plugins that keep failing to load) while keeping the user's
  own patch rows, so a broken suite update never bricks the app. The toggle
  lives in the in-frame dialog; the next boot reads the marker.
- **Proxy auto-detection** (`src/main/proxy-detect.ts`): on a TUN/fake-IP VPN
  client every hostname resolves into 198.18.0.0/15, which the kernel's
  address-validating web provider refuses. The shell probes the common local
  proxy ports and injects `HTTPS_PROXY`/`ALL_PROXY` into the kernel child only
  when a listener actually answers AS a proxy (a TCP connect followed by an
  HTTP CONNECT probe — a bare connect would adopt any squatter on 7897/7890).
  An explicit proxy in the user's environment always wins; a watchdog restarts
  the server only when a SHELL-injected proxy dies (a user's own proxy is
  theirs to manage). Loopback is never proxied.

## 7. Security posture

- Main window: `contextIsolation`, `sandbox`, `nodeIntegration:false`, and a
  preload whose entire surface is one frozen marker (`window.dshDesktop`,
  `src/main/account-preload.ts`). It exists because the kernel's account UI
  registers itself only when that key is present
  (`ui-settings-account/src/client/index.ts` returns early without it), so the
  preload is the switch for the account section, sign-in dialog and balance card.
  It exposes **no channel and no IPC**: a page cannot ask the main process for
  anything through it. The embedded Platform view has its own preload and its own
  non-persistent partition (`src/main/platform-preload.ts`, `platform-view.ts`),
  which the app document cannot reach.
- Navigation confined to `dsh-app://app` plus the shell's own splash `file:`
  document (the predicate is `src/main/nav-policy.ts`, compared by
  protocol + hostname — a custom scheme's URL `origin` is the literal string
  "null" in every realm); everything else → `shell.openExternal`
  (http/https only).
- Plugin `/api` routes are fenced by the Connection carrier (Host/Origin check
  **plus** browser authentication before a handler runs), so a DNS-rebinding
  request cannot reach them by presenting a matching Origin.
- Kernel downloads verified by sha512 before activation (integrity from the
  release asset sidecar; can be upgraded to signed manifests later). The
  artifact is additionally bound to the requested version before activation:
  a mirror serving an older tarball under a versioned URL is refused, not
  silently installed. Tar extraction treats every archive as untrusted — the
  filter refuses absolute paths, `..` segments, AND link entries whose target
  leaves the extraction root.
- The shell's update metadata (latest.yml) is read official-GitHub-first (the
  version is a trust decision); the ~180 MB installer bytes stay mirror-first
  for the mainland topology, every candidate gated by that metadata's sha512.

## 8. Packaging & distribution (M4)

- `electron-builder.yml`: win NSIS, mac dmg+zip, linux AppImage+deb; x64+arm64.
- Shell updates: Windows uses a custom in-app flow — latest.yml detection via
  the GitHub `releases/latest` alias, arch-matched installer download with a
  mirror-first / official-GitHub fallback chain, sha512 verification, then a
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
  no shared-name clobber races) and the office payload of that cell
  (`office-payload-<platform>-<arch>-<dshVersion>.tgz`, its `.sha512` and
  `office-payload-<platform>-<arch>.json`) — the engine is deliberately not
  inside the runtime, so the release is incomplete without it. An existing
  release is reused only when it is complete (all seven assets per cell) AND its
  suite version matches the tree's.
- Signing: macOS notarization requires Apple credentials (CI secrets); Windows
  signing optional (SmartScreen without it); Linux unsigned.

## 9. Known TODOs

- `plugin-brand`: settings namespace + app-info service remain scaffolds; the
  desktop side of the bridge (action route + connection routes) is wired.
- `plugin-client-ui`: slot ids still to be verified against the running UI
  before any new enhancement slot is wired.
- `plugin-sidebar`: no automated test suite for the client components — the
  plugin is verified through tsc + esbuild + headless dsh server API smokes.
- First-run UX: kernel download progress is wired into the in-window update
  card; pause/resume and checksum display are not.
- Office payload: not bundled with the installer, so a first run with no network
  converts no documents until the 诊断 row downloads the engine; the Python set
  the office skills need travels in that same artifact and is staged per cell by
  `scripts/build-primary-runtime.mjs` (`DSH_APP_PRIMARY_RUNTIME` carries it into
  the build; win32 and darwin only, because no linux engine is staged or tested
  here and one would ride ~150 MB in every linux office payload — a 0.1.7 host
  reads a linux manifest itself). Every non-linux cell now smoke-verifies the
  staged Python set with the host's own code before it ships (release.yml).
- Optional: signed manifests + rollback of `$DSH_HOME` settings on major
  version cross-grades.
