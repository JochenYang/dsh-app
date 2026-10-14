# AGENTS.md — DSH APP (dsh-app)

How to work in this repository. This file carries what every task needs; the depth lives in the
documents below. Read the one your change touches before you start — and when a document and the
code disagree, re-read the code.

| Read this | When your change touches |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | a module's design: layers, update flow, security posture, packaging |
| [`docs/agents/build-and-release.md`](docs/agents/build-and-release.md) | the runtime artifact, the office payload, the bundled kernel, cutting or recovering a release, the ModelScope mirror |
| [`docs/agents/release-checklist.md`](docs/agents/release-checklist.md) | cutting a release — the order of operations, with the mistakes that each cost one called out |
| [`docs/agents/environment.md`](docs/agents/environment.md) | an environment variable's meaning, or adding one |
| [`docs/agents/troubleshooting.md`](docs/agents/troubleshooting.md) | a timeout, an error code or a log line you cannot place |
| [`docs/agents/kernel-line-regression.md`](docs/agents/kernel-line-regression.md) | a kernel-line move: the pre-flight touchpoint scan, the gates and what each one cannot see, the rendering-side blind spot, the checklist |
| [`docs/agents/profile-supply-chain.md`](docs/agents/profile-supply-chain.md) | a machine's own `dsh` profiles after a kernel-line move |
| [`plugins/AGENTS.md`](plugins/AGENTS.md) | anything under `plugins/` (also auto-loaded there) |
| [`plugins/README.md`](plugins/README.md) | which plugin owns a capability, and each one's host/client role |
| the module's own JSDoc header | that module — it states constraints the code cannot show |

## 1. What this project is

DSH APP is a **branded Electron desktop client for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** — DeepSeek's coding-agent
CLI/Web app. Windows / macOS / Linux, public release, MIT, hosted at GitHub `JochenYang/dsh-app`.
Three constraints govern every change:

1. **Self-contained** — the app ships and installs its **own versioned dsh kernel** and never depends
   on, or detects, a system-installed `dsh`; all brand functionality is a **plugin suite layered on
   the upstream kernel** (§8), never a fork.
2. **Two decoupled update channels** — the shell (the Electron app) and the kernel (dsh + the brand
   suite, packed into one runtime artifact) are built, released and updated independently:
   `src/main/updater.ts` owns the shell channel, `src/kernel/manager.ts` the kernel channel.
3. **Mainland China first** — every download has a mirror chain, and ModelScope — not GitHub — is the
   primary shell-update source.

The kernel line has one source of truth: the spec every `@deepseek-ai/dsh*` dependency in the root
`package.json` shares (`^0.2.0-rc.2` today), resolved and asserted by `scripts/kernel-line.mjs`;
nothing else — no workflow variable, no hand-flipped channel — decides it.

## 2. Stack, layout and key configuration files

Electron 44 + TypeScript 5.7 → CommonJS/ES2022 via `tsc`; electron-builder 26 packs NSIS (win) /
dmg+zip (mac) / AppImage+deb (linux); esbuild 0.28 bundles the plugin halves; `npm` here, `pnpm`
inside the harness checkout and the runtime assembly; Node 22+ (what CI runs).

**Configuration files that decide behaviour**

| File | What it decides |
|---|---|
| `package.json` | shell version, every npm script, and the `@deepseek-ai/dsh*` spec that picks the kernel line |
| `tsconfig.json` / `plugins/*/tsconfig.json` | the shell's compile (`strict`, CommonJS, Node resolution, ES2022, `src/` → `dist/`) and a plugin's (ESM, `moduleResolution: "Bundler"`, explicit local-import extensions, `noEmit`) |
| `plugins/*/package.json` | a plugin's own version (hashed into `suiteVersion`), `files` (the only source of runtime resources), `dsh.bundle` / `dsh.client` wiring, and its dependency fields |
| `electron-builder.yml` | packaging targets, the NSIS hook include, `extraResources` (the bundled kernel), the `publish` provider |
| `plugins/dsh-app.patch.yml` | the loader overlay that mounts the suite into the kernel (roster copy 1 of 5 — §8) |
| `scripts/kernel-line.mjs` | line derivation, `SUITE_PLUGINS` (roster copy 2), `suiteVersion`, the LibreOffice kit pin |
| `scripts/primary-runtime-lock.json` | the Python set the office payload carries, plus the bundled pnpm pin |
| `changesets/*.md` | the release-input fragments (§11) |
| `.github/workflows/{ci,release,publish-mirror}.yml` | the gates, the release pipeline, the ModelScope mirror |
| `.github/scripts/mirror_release.py` (+ its test) | the mirror's own logic, including its delete allowlists |

**Directory layout**

- `src/main/` — the shell (Electron main): boot and lifecycle, the kernel child (`server.ts`,
  `desktop-host.ts`), the window and its injected desktop chrome (`window.ts`), tray, updater, safe
  mode, proxy detection, crash/log/event files, profile healing, the in-frame dialog.
- `src/kernel/` — the kernel manager: install / activate / rollback / cleanup, artifact resolution
  (`sources/`), `current.json` + manifest I/O, sha512 integrity, tar-entry filtering, the office
  payload, bundled-kernel adoption.
- `src/shared/` — cross-cutting constants, types, the shell locale table.
- `plugins/` — the eighteen-plugin brand suite (§8), each its own npm package with a host half, a
  client half, or both.
- `scripts/` — build, packaging, gate, smoke, probe and release tooling; `scripts/lib/` holds the
  verdicts those tools share.
- `test/` — the root unit suites (`test/*.test.mjs`, 70 files).
- `docs/` — architecture, per-topic runbooks (`docs/agents/`), plans (`docs/plans/`), the capability
  roadmap, and kernel-line records.
- `static/` — the startup page; `resources/` — icons; `bundled-kernel/` — the tarball, sidecar and
  manifest a packaged shell ships.

**Never commit build output** (all gitignored, per `.gitignore`): `dist/`, `release/`, `runtime-dist/`,
`bundled-kernel/`, `runtime-layers/`, `plugins/*/lib/`, `plugins/*/.test-dist/`, `plugins/*/package-lock.json`,
`logs/`, `scratch/`, `repo/`, `.devflow/`, `release-notes.md`, `*.tgz`, `*.log`, `__pycache__/`.

## 3. How the app actually runs

The Electron main process **spawns a real Node child** running the dsh kernel from an installed,
versioned tree (`<userData>/kernel/dsh-<dshVersion>+suite-<suiteVersion>/`, holding `node/` and
`app/`). The window loads `dsh-app://app/index.html`, a privileged custom scheme served only by
forwarding to that child; there is no setup renderer, and the first run downloads or adopts a kernel
in the background, reporting through the in-window update card and the tray.

`<userData>/kernel/current.json` is the **single source of activation truth** (`active`, `previous`,
plus a `bundledStamp`). Versioned directories are immutable; activation is one atomic file rewrite, so
a bad boot always has a `previous` to roll back to, and a kernel that fails to become healthy twice is
rolled back once, then surfaced as an error rather than looping.

The brand suite is stitched in at every server start (`src/main/brand-suite.ts`, `suite-profile.ts`):
its plugins are linked into the booted profile's `node_modules/@dsh-app` and the shared fallback (§9),
it boots its own profile named `dsh-app` (`SUITE_PROFILE` in `src/shared/constants.ts`; a user's own
`dsh web` keeps `web`), `plugins/dsh-app.patch.yml` is copied into userData as a loader overlay, and
every piece degrades gracefully — a rollback target without the suite boots vanilla, never blocked.

The LibreOffice engine is deliberately **not** in the runtime artifact: it travels in the on-demand
"office payload" (§10), and a loader shim at the kit's specifier turns an absent payload into an
actionable refusal rather than a plugin-tree load fault.

## 4. Build, dev and verification commands

Prerequisites: none for `npm run dev` and `npm test` — a dev run boots the **installed** runtime, the
same artifact a packaged start uses; a local `deepseek-harness` checkout is needed only for live
sources or to rebuild the artifact, and must have had `pnpm install` + `pnpm run build` run in it.
`DSH_APP_DEV_KERNEL` boots a built runtime tree in place and `DSH_APP_DEV_RUNTIME` boots a harness
source checkout; with neither set a dev run boots the installed runtime, and with nothing installed it
installs the bundled `kernel.tgz` offline. A pulled-but-unbuilt checkout is deliberately never a
candidate; every variable is listed in `docs/agents/environment.md`.

```sh
npm run typecheck             # tsc --noEmit; the compile gate
npm run build                 # tsc -> dist/ + static/overlay/tray icon copy
npm test                      # root suites (builds first; needs dist/)
npm start                     # build + launch Electron (production-like)
npm run dev                   # DSH_APP_DEV=1 + the installed runtime
#   PowerShell: $env:DSH_APP_DEV="1"; npm start   (no `VAR=1 cmd` in PowerShell)
#   A built runtime tree:  DSH_APP_DEV_KERNEL=D:/.../scratch/<name>/runtime
#   A source checkout:     DSH_APP_DEV_RUNTIME=D:/.../deepseek-harness  (must be built)
npm run dist:win | dist:mac | dist:linux          # build + bundle kernel + electron-builder
npm run runtime:build                             # rebuild the runtime artifact
npm run primary-runtime:build                     # stage the Python set the office payload carries
npm run smoke:package                             # assert a packaged output carries what boot loads
npm run icon:build | icon:gen                     # regenerate resources/ icons

# Gates (all static, no kernel, no network)
npm run check:graph           # plugin-graph + suite-roster rules
npm run check:suites          # the five roster copies agree (--check form: check:suites:gate)
npm run check:slots           # every ctx.slots id a client half names still exists in the line
npm run check:surface         # kernel-surface report
npm run check:touchpoints     # the seven pre-flight contact-surface scans (--check form gates)
npm run check:plugins -- --kernel <runtime.tgz> --home <the dir holding profiles/>

# Real-kernel verification
npm run verify                                        # smoke-suite.mjs against a dev checkout
npm run verify -- --tgz runtime-dist/dsh-runtime-linux-x64-*.tgz
```

**Hand-run probes** (`scripts/probe-*.mjs` / `.cjs`) — each mirrors a piece of shipped behaviour and must be re-run
when that piece moves: `probe-launch-folder.mjs` after a kernel-line bump; `probe-settings-nav.cjs --lang en-US
[--sweep]` after touching a settings section (it measures order, icons, scrolling and residual Han characters);
`probe-drag.cjs` mirrors `DESKTOP_CHROME_CSS` in `src/main/window.ts` — **keep the two in sync** (a root test
already diffs them); the remaining `probe-chrome-surfaces.cjs` / `probe-in-frame-dialog.cjs` /
`probe-overlay-modal.cjs` / `probe-update-card.cjs` / `probe-whale.cjs` / `probe-mirror.mjs` cover the surfaces
their names say; `scripts/capture.mjs` screenshots the running UI for visual work.

**A probe running inside Electron must pass `windowsHide: true` to every `spawn`** — otherwise each
console child pops a terminal onto the user's desktop.

**Dependency installs**: root changes use plain `npm install`; plugin-local installs use
`--legacy-peer-deps` **inside the plugin directory only** (at the ROOT it prunes the peer-only tree
and breaks `npm ci`); when switching kernel lines delete root `node_modules/` first — a stale tree
causes ERESOLVE.

## 5. Testing

Three layers, each blind to something the others see.

**Root suites** — `npm test` builds first, runs `scripts/ensure-electron.mjs` (Electron's binary is unpacked
lazily, and `node --test` runs each file in its own process, so several files race to unpack it into the same
directory), then `node --test "test/*.test.mjs"` over 70 files. They cover the shell, the kernel manager, the
gates themselves, the security invariants and the documentation-vs-code pairs (`desktop-chrome-css`,
`touchpoints`, `suites-drift`, `recursive-delete-guard`); `test/scratch.mjs` is the shared temp-tree helper.

**Plugin suites** — each plugin's own `scripts/test.mjs` bundles `plugins/plugin-*/tests/*.test.ts`
with esbuild into `.test-dist/` (type-only framework imports stripped) and runs `node --test` over the
result. All eighteen have suites; run one from its own directory per `plugins/AGENTS.md`.

**Real-kernel smoke** — `npm run verify` (`scripts/smoke-suite.mjs`) boots an actual dsh kernel with the full
suite overlay and asserts what a bare `ok:true` cannot: health, every suite route, every dual-face client
bundle non-empty, the PPT template catalog, the bundled PDF CJK font, and (with `--tgz`) that the artifact
really contains the resource directories the plugins declare. This is the executable answer to
"compile-green ≠ runtime-green": the type gate cannot see across the plugin/kernel boundary, and this can.

**CI** (`.github/workflows/ci.yml`) is the definition of done for a merge. Its `gate` job runs the
changeset gate, the typecheck, the three static checks and both test layers; its order matters — the
root tests run *after* the per-plugin installs because two suites resolve packages that exist only
inside a plugin's own `node_modules`, and the slot check for the same reason. Its `smoke` job builds
the suite and a real linux-x64 runtime, then runs `smoke-suite.mjs --tgz` on it.

## 6. Code style and conventions

- **Language**: comments and documentation are **English**. All user-visible shell copy lives in
  `src/shared/locale.ts` (zh/en; the en table is typed and `t()` throws on a missing key). Locale
  resolution is `DSH_APP_LOCALE` > `app.getLocale()` > zh-CN, and **the zh table is frozen** — only
  that one file under `src/` may hold Han characters, and each plugin owns its own dictionary.
  `README*.md` stay in sync; `CHANGELOG.md` is bilingual, entries aligned one-to-one between
  `### 中文` and `### English`.
- **TypeScript**: `strict`, avoid `any`. The shell is CommonJS with Node resolution; plugins are ESM
  with `moduleResolution: "Bundler"` and explicit local-import extensions. A `tsc`-only plugin build
  is the exception (`plugin-brand`); everything else builds with esbuild, which **does not type
  check** — see the gates in §8.
- **Failure paths**: user-facing errors are stable, actionable, zh-CN, and leak no sensitive detail.
  Errors carry actionable context and preserve the original cause; failures crash where they happen
  rather than being swallowed behind a degraded path.
- **No native dialogs in client UI** (`window.alert` / `confirm` / `prompt`) — use the modal idiom
  (mask + card, Esc/mask = cancel, Enter = primary; `src/main/in-frame-dialog.ts`).
- **Client UI composes the host's primitives; it never redraws them** — a dialog is `Modal` (+ `Button`), a
  diff is `DiffBlock`, an announcement is `Toast`, all from `@deepseek-ai/dsh-client-ui-primitives`. Check
  that package's export list BEFORE writing a surface: the mask, blur, elevation, focus handling, Escape,
  modal layer and fade timing come with the primitive, and a hand-rolled one reads as off-theme beside every
  other dialog. Override a primitive through its own documented seat (`className`, `anchor`, `holdMs`), never
  by redrawing it. `RiskConfirmation` is the destructive-action variant but demands an acknowledgement
  checkbox — reserve it for genuinely irreversible choices, and prefer a described change (per-item rows +
  confirm) otherwise. A message that must be READ before acting holds 8s (the kernel's own refusal value),
  not the 3s announcement default; `plugin-rewind`'s `client/confirm-dialog.tsx` is the reference.
- **Host halves never send user-visible prose** — only `HostText { code, params?, text? }`
  (`plugin-websearch/src/wire.ts`): a stable code the client maps to its dictionary, plus an English
  diagnostic.
- **Desktop adaptation stays shell-side** — inject via `executeJavaScript`, stylesheets and profile
  patch rows only; never modify harness source. Injected surfaces answer status tokens, never copy.
- **Settings sections are one ordered rail.** The `order` values live in a table in
  `docs/desktop-optimization-plan.md` §3.1: **update that table in the same commit as an `order` change,
  and never reuse a value that is taken.** Current suite rows: 模型高级设置 / Advanced models 11, 用量统计 /
  Usage 21, 会话记忆 / Memory 22, 会话归档 / Archives 23, 维护设置 / Maintenance 24, 关于 DSH-APP / About 26;
  upstream owns 0, 10, 15, 20 and the pinned 25. 维护设置 is ONE section with three tabs — 预设包 / Presets 2,
  诊断 / Diagnostics 3, 撤回隔离区 / Quarantine 4 (order 1 is a vacant slot, kept vacant) — declared by the
  section owner through the `settings.dsh-app-maintenance.tab` child slot.

## 7. Security invariants

Design context: `docs/ARCHITECTURE.md` §7. These are invariants, not preferences; a change that
weakens one needs a security review, not a fixup.

- **Main window**: `contextIsolation`, `sandbox`, `nodeIntegration:false`, and a preload exposing
  **exactly one frozen marker** (`window.dshDesktop`, `src/main/account-preload.ts`) — the kernel's
  account UI registers only when that key is present, and nothing else needs a bridge. A second
  preload serves the embedded Platform view (`src/main/platform-preload.ts`), its own `WebContentsView`
  in its own partition, not exposed to the app document. **Neither may grow a channel without a
  security review.**
- **Navigation** is confined to `dsh-app://app` plus the shell's own splash `file:` document (`src/main/nav-policy.ts`
  compares protocol + hostname — a custom scheme's URL `origin` is the literal string `"null"` in every realm).
  Everything else goes to `shell.openExternal` (http/https only).
- **No port — on the frames line**: the kernel child's web surface travels fd3/fd4 byte pipes; the
  window loads `dsh-app://app/index.html`, a scheme registered privileged **before** `app.ready` and
  served only by forwarding to that child (other host → 404, no host → 503). A `0.1.6-alpha.2+` host
  binds its own loopback port instead and the shell forwards with a cookie.
- **An app-origin document never goes into a sandbox frame** — the action route trusts the top
  frame's stamped initiator alone, while a sandboxed iframe reports the app's URL from an opaque
  origin (`src/main/shell-actions.ts`).
- **Plugin `/api` routes** are fenced by the Connection carrier (Host/Origin check **plus** browser
  auth before a handler runs); a suite plugin registers with `ctx.connection.fetch.register(...)` and
  answers `/api/plugins/dsh-app/<plugin>/<name>` (no `@` in a segment, GET/HEAD/POST only); the host's
  `webserver` row stays disabled.
- **Kernel downloads** are sha512-verified before activation, with metadata from the official host first so a mirror
  cannot swap content. Bytes come official → the ModelScope copy → the public proxies (`assetCandidates`): the mirror
  is a file this project itself publishes, while ghfast.top / gh-proxy.com are third-party transports. Tar extraction
  treats every archive as untrusted — absolute paths, `..` segments and link entries whose target leaves the
  extraction root are all refused.
- **Never hardcode secrets.** dsh's credential store is the store; plugin keys support `$ENV:NAME`
  and are masked on read.
- **Redact credential-looking fragments** (`api[key|_key]`, `authorization`, `token`, `secret`, `password`) in child
  logs, and cap line length. The shareable `dsh-events.jsonl` records derived fields only — never a raw error
  message, which can hold a feed URL, a command line, a path or a credential.

## 8. The brand plugin suite (`plugins/`)

Eighteen dsh plugins layered on the upstream kernel **without forking it** — that is what keeps the
desktop app updateable when upstream moves. `plugins/README.md` is the roster (which plugin owns
which capability, and each one's host/client role); `plugins/AGENTS.md` is the working guide for the
directory. In short: `plugin-brand` (host; brand settings + desktop bridge — partly a scaffold),
`plugin-client-ui` (client; brand theme, advanced-models and maintenance sections, About row, nav
icons), `plugin-sidebar` (Git view), `plugin-swarm` (subagent orchestration), `plugin-usage`,
`plugin-archives`, `plugin-memory`, `plugin-mcp`, `plugin-hooks`, `plugin-ppt` / `plugin-doc` /
`plugin-sheet` / `plugin-pdf` (office generation, one capsule bar), `plugin-market`, `plugin-presets`,
`plugin-websearch` (`web_search` / `web_fetch`), `plugin-rewind` (message recall + file revert),
`plugin-effort` (reasoning effort).

**The suite roster lives in five places and must match exactly**: `plugins/dsh-app.patch.yml`,
`scripts/kernel-line.mjs` (`SUITE_PLUGINS`), `src/main/brand-suite.ts` (`SUITE_PLUGIN_DIRS`),
`scripts/smoke-suite.mjs` (`SUITE_DIRS`), `.github/workflows/release.yml` (the pre-build loop).
Update all five in one commit, then `smoke-suite.mjs --tgz` a fresh build.
`npm run check:suites:gate` is the executable half of that sentence: it reads all five and fails when
they do not name the same set of plugins; a copy it cannot read in the shape it is written in is exit
2, never a pass — a reader that read four copies would otherwise report agreement it did not check.

**Four checks gate a plugin's `lib/` before it can enter an artifact**, all decided in
`scripts/lib/plugin-gates.mjs` and `scripts/lib/plugin-imports.mjs` and run by `build-runtime.mjs`, by
`release.yml`'s pre-build loop, and by `ci.yml`'s `gate` job in its per-plugin build loop:

1. **Import gate** — every package a plugin's `src/**` imports must be accounted for by a dependency
   field of its own manifest, of an ancestor's, or by being installed on its resolution chain; and a
   `@deepseek-ai/*` package imported for RUNTIME must be in `peerDependencies`. esbuild marks those
   specifiers external, so nothing else on the packaging path can see a missing declaration — the
   plugin ships a load-time failure. A type-only import needs no peer.
2. **Type gate** — the plugin's own `npm run typecheck`. esbuild does not type check, so a client half
   calling an export its own module stopped exporting used to reach users as a renderer
   `ReferenceError`. A plugin that IMPORTS a package installed only by a peer must therefore declare it
   in its own `devDependencies` too: `npm install --legacy-peer-deps`, what both workflows run, installs
   dependencies and devDependencies and **no peer**, so that declaration is what lets `tsc` resolve the
   import. Fourteen plugins import `@deepseek-ai/dsh-client-ui-primitives` and all fourteen declare it
   in both fields. A peer that nothing installs makes the gate SKIP that plugin — per plugin, naming the
   packages, never silently — and every run ends with a count of those skips (`0 of 18` on a CI tree).
3. **Presence check** — the build's DECLARED outputs must exist and be non-empty: the `files` entries
   naming `lib`, plus `main` and the `exports` targets under `lib/`. npm omits a missing `files`
   directory from the tarball without a word, and this repository has already shipped a suite that
   was missing plugins with every other gate green.
4. **Freshness check** — `lib/` must not be older than the plugin's own inputs. This one is weaker on
   a CI tree and a green log must not be read as more: the freshness half passes by construction on a
   clean checkout (there is no `lib/` yet). The other three hold there.

**Any change under `plugins/` needs a version bump in that plugin.** The patch field is a SINGLE
digit — a tenth change carries into the minor (`0.8.9` → `0.9.0`), never `0.8.10`. `suiteVersion`
hashes plugin `package.json` versions, not code, so an unbumped plugin ships nothing: every
installation keeps the old one and every local gate stays green.
`test/plugin-version-bump.test.mjs` enforces this against the newest release tag (and skips in a
shallow clone).

**Runtime resources come from each plugin's own `package.json` `files` field**, never a hand list — a
`files` entry the build refuses to ship fails the runtime build, so declare resources there rather
than copying them into the artifact by hand.

## 9. Process rules (each cost someone a bad day)

- **Gate commands must run bare — never behind a pipe**: `… | tail && git commit` commits on the
  pipe's exit code.
- **Deletes that can follow a link go through `scripts/lib/remove-tree.mjs` (`removeTree`), never a
  sync recursive call** — a profile must never hold a link that NAMES the runtime tree (mirrored in
  as HARDLINKS); `test/recursive-delete-guard.test.mjs` audits every sync recursive delete, and
  plugin store deletes use a private walker copy.
- **Session header hooks go through `installSessionHeaderRules`** — Electron keeps only the LAST
  `onBeforeSendHeaders` listener per session (measured on 44.4.1: a request matched by the first filter
  arrives with neither hook's headers), so a second `install*` call silently disables the first. The
  shell's two jobs (stamp its own action requests, authenticate the client's stream handshake) are both
  RULES behind one install; a rule declines a request it does not own by returning false, and a third
  registration is a bug by construction.
- **The host child runs a real Node, never Electron's own** — an `ELECTRON_RUN_AS_NODE` child dies
  with `unsupported Electron runtime fingerprint`.
- **On the web line the profile patch must not repeat the home layer's rows** — the composer loads
  `$DSH_HOME/cordis.patch.yml` as a LAYER, so a copy is refused (`duplicate loader entry id`); the
  desktop host (frames, dev) reads the profile patch alone, where the copy keeps the user's rows. And
  the `- id: web` overlay row is a PAIR — patch semantics replace the whole object, so naming only
  `searchProvider` drops `fetchProvider` and kills the tree on a duplicate loader entry.
- **A mirror into the profile owns PACKAGES, not a shared scope directory** — `@deepseek-ai` is shared with the
  market; a scope directory goes only with its last package; profile-lockfile names are the market's
  (`lockfileOwnedNames`); a bare `@scope` from an older shell narrows against `marker.runtime`. A removal must be
  WITNESSED by that recorded runtime's own `node_modules`: a name it does not carry, or a runtime that is gone, is
  left in place (`mirrorWitnessGap`) — residue is recoverable, a deleted user package is not. A profile whose
  manifest declares a package that is not installed is repaired before the host starts (`profile-heal.ts`),
  through the kernel CLI's `plugin install` with `DSH_HOME` pinned — the CLI resolves `--profile` as
  `$DSH_HOME/profiles/<name>`, never from its cwd.
- **The window's client state belongs to the kernel LINE that wrote it** — `client-state.ts` clears
  local storage on a line change (a per-line partition cannot work: fixed at window creation).
- **A suite plugin must be linked into the BOOTED PROFILE's `node_modules/@dsh-app`** — the enforcing
  resolver walks the profile's own `node_modules`; the shared link alone yields a silently vanilla
  UI, and `brand-suite.ts` re-links both scopes every start.
- **No backticks inside template-literal CSS/scripts** — `DESKTOP_CHROME_CSS` and the injected
  scripts are backtick literals; an embedded one silently terminates the string.
- **Injected `executeJavaScript` promises must not resolve eagerly** — the chrome-sync loop in
  `src/main/window.ts` re-enters on every resolution (an eager promise = a tight main↔renderer
  round-trip).
- **Upstream API drift**: slices and `as unknown as` casts bypass the type gate — a kernel-deleted
  API leaves tests green while the runtime throws; verify each plugin end-to-end after every
  kernel-line bump (`npm run verify`, `npm run check:plugins`). A name the line STOPPED exporting
  type-checks and is `undefined` at render. `test/plugin-kernel-imports.test.mjs` checks every named
  runtime import against the installed line's real exports (no kernel tree, no network), and
  `scratch/check-third-party-client-imports.mjs` runs the same check over a third-party plugin's
  sources.
- **Proxy: probe before injecting** — a TUN/fake-IP client resolves hostnames into `198.18.0.0/15`;
  the kernel installs its dispatcher once at boot, so a proxy that disappears later points every
  request at a closed port. `proxy-detect.ts` probes first (a TCP connect followed by an HTTP CONNECT
  probe — a bare connect would adopt any squatter on 7897/7890), an explicit user proxy wins, and the
  watchdog restarts only a shell-injected proxy. Injection is otherwise unconditional (a fake-IP
  machine needs it for `web_fetch`'s address validation); `DSH_APP_PROXY_INJECT=off` opts out. **The
  runtime pins `undici` to 8.10.2** (`scripts/build-runtime.mjs`): 8.11.0 narrowed the legacy
  wrapper's HTTP/1.1 downgrade to WebSocket upgrades, so with a proxy installed Node's BUILT-IN
  `fetch` read every provider response as header-less, undecoded bytes and every model list failed.
  Re-verify the pin on every kernel-line bump (`docs/kernel-0.1.7-alpha.1-regression.md` §12.13).
- **Web search is a provider, not a tool** — `web_search` / `web_fetch` stay upstream's; register a
  `ctx.web` provider (one per call), so fallback lives inside it. Both capabilities are the brand
  plugin's now: `plugin-websearch` also serves `web_fetch` (`fetchProvider: dsh-app-fetch`), keeping
  the host provider's contract and adding one thing — a poisoned resolver (TUN/fake-IP) is detected by
  canary and bypassed with DoH, the only way the host's own provider can pass its own public-address
  guard on such a network. It never patches `dns.lookup` process-wide: the host provider reads
  `dns/promises`, and a patch that wide would reach every lookup in the kernel child.

## 10. Known TODOs and scaffolds (do not assume finished)

- `plugin-brand`, `plugin-client-ui`: scaffolds and route details in their JSDoc and `plugins/README.md`.
  `plugin-brand`'s brand settings namespace and app-info service are declared but not wired; its desktop
  action route IS wired. `plugin-client-ui`'s slot ids come and go — verify against the running UI
  (`probe-settings-nav.cjs`) before wiring a new one.
- **Desktop actions ride the shell's own protocol route** (`src/main/shell-actions.ts`,
  `dsh-app://app/__dsh-app/action/<name>`, inside the loaded origin — no port, no kernel child). A
  Node child cannot reach the scheme, so `plugin-brand` hands the client coordinates and the
  diagnostics page calls it; requests carry the top frame's URL + a per-process secret (subframes
  refused).
- **Office payload**: the Python half (upstream's `primary-runtime` set) is wired end to end and
  smoke-verified by every non-linux release cell before shipping, but it is still not bundled with the
  installer — a first run with no network converts no documents until the 诊断 row downloads it
  (`docs/agents/build-and-release.md` §2).
- **`plugin-sidebar`** has no automated test suite for its client components — the plugin is verified
  through tsc + esbuild + headless server API smokes.
- **Pre-release gaps**: macOS signing/notarization and optional Windows signing secrets must be
  supplied as CI secrets; `resources/icon.png` is a placeholder.
- **First-run UX**: kernel download progress is wired into the in-window update card; pause/resume
  and checksum display are not.
- **The `0.1.7-alpha.1` host line is history** — nothing about it is pending; what remains is the
  delivery model that would retire the `kernel/` tree, activation file and profile mirror, still
  planned in `docs/capability-roadmap/kernel-package-set.md`.
- **The app update path asks the host before it kills it** — `DshHost.inspectQuit` / `askHostTasks`
  use the child's own `quit-inspection` and `update-tasks` control, and every failure reads as "work
  is in flight" (see `src/main/updater.ts` `confirmNoActiveTasks`).
- Future: signed kernel manifests; `$DSH_HOME` settings rollback on major-version upgrades. `docs/capability-roadmap/`
  holds the rest of the roadmap; `docs/plans/` holds the plans that are still open.

## 11. Commits and changesets

`<type>(<scope>): <subject>` (`feat:` / `fix:` / `chore:` / `ci:` / `docs:` / `test:`); imperative,
≤50 chars, no period; body = one change per `-` bullet, ~72-char wrap, then a standalone `Verified:`
line.

A commit that reaches users (`src/`, a plugin's `src/` or `package.json`,
`scripts/build-runtime.mjs`, `scripts/kernel-line.mjs`) also carries a `changesets/<name>.md` fragment
declaring the shell impact and the plugins whose behaviour changed — the gate in `ci.yml` refuses it
otherwise, and `scripts/fold-changesets.mjs` consumes it at release time. Format and rules:
`changesets/README.md`. Do not run `git commit`, `push`, `tag`, or any history-rewriting command
unless the user asked for it.

## 12. Releases

Full procedure: `docs/agents/release-checklist.md` (the order of operations) and
`docs/agents/build-and-release.md` §4 (the mechanics and the reasoning). The short version of what a
change must do to reach a user:

- a change in `src/` (the shell) → a new `vX.Y.Z` tag. Nothing else delivers it.
- a change in `plugins/` or `scripts/build-runtime.mjs` → a **new runtime**, and it only reaches an
  existing install if its identity changed: the kernel's adoption key is `dshVersion+suiteVersion`
  from the runtime manifest, and `suiteVersion` hashes the suite plugins' **versions** only. **Bump
  every plugin whose behaviour changed, or the release does nothing.**
- both → one shell release with a refreshed `bundled-kernel/`.

Three rules that each cost this project a release:

1. The `runtime-<dshVersion>` release **stays a prerelease** — `/releases/latest` resolves to the
   newest non-prerelease release, and a runtime tag carries no `latest.yml`.
2. A shell `vX.Y.Z` tag is **never re-run** — electron-builder's publish is not idempotent (422
   `already_exists`); recovery is delete release + delete tag, then re-tag the same content.
3. **Publish with the generated notes** — `node scripts/gen-release-notes.mjs vX.Y.Z` →
   `release-notes.md`, then `gh release edit vX.Y.Z --draft=false --notes-file release-notes.md`;
   flipping the draft without `--notes-file` leaves an EMPTY release page, and that flip is what
   starts the ModelScope mirror (`publish-mirror.yml` hooks `release: published`).

## 13. Reporting a round's work

Every rule below was paid for in this repository's own history, and they share one cause: treating the
owner's attention as the place where open work waits.

- **A round ends in one of two states**: done, verified and shipped — or blocked, with the cause and
  the shortest path that unblocks it. There is no third state, and neither "here are the decisions I
  left for you" nor "little context left" is a report — the work was always doable, so do it, then
  say what was done.
- **A defect is not a backlog item.** Sort every open item into: harms a user, leaks something, or
  delays the next discovery — a defect, fix it now; versus makes a future mistake visible earlier —
  hardening, schedule it. Filing a defect as "next round" is how v0.16.3 shipped unbounded catalog
  reads, a wall-clock token TTL and six undeclared plugin imports — all fixed only in v0.16.4.
- **Decide, then state.** Money, legal exposure, an irreversible or outward-facing act and a change
  to the product's shape are the owner's call; everything else — including "is this acceptable?" and
  "should this be tighter?" — is decided here, written down with its reason, and reported as fact. A
  thing investigated and deliberately left unchanged belongs in that record too, not as an open item
  the reader has to re-ask.
- **Prove a gate where it runs.** A check wired into CI must be exercised in CI's own environment — a fresh
  `--legacy-peer-deps` tree with no peers and no `lib/` — before it is called green; a local green is not that
  proof, and the type gate shipped exactly that way once and stopped a release. For a claim about a commit,
  name the tree hash, not the impression. §12's three release rules apply unchanged, including the re-cut.
