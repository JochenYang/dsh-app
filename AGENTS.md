# AGENTS.md — DSH APP (dsh-app)

How to work in this repository. This file carries what every task needs; the
depth lives in the documents below. Read the one your change touches before you
start — and when a document and the code disagree, re-read the code.

| Read this | When your change touches |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | a module's design: layers, update flow, security posture, packaging |
| [`docs/agents/build-and-release.md`](docs/agents/build-and-release.md) | the runtime artifact, the office payload, the bundled kernel, cutting or recovering a release, the ModelScope mirror |
| [`docs/agents/environment.md`](docs/agents/environment.md) | an environment variable's meaning, or adding one |
| [`docs/agents/troubleshooting.md`](docs/agents/troubleshooting.md) | a timeout, an error code or a log line you cannot place |
| [`plugins/AGENTS.md`](plugins/AGENTS.md) | anything under `plugins/` (also auto-loaded there) |
| [`plugins/README.md`](plugins/README.md) | which plugin owns a capability |
| the module's own JSDoc header | that module — it states constraints the code cannot show |

`docs/desktop-optimization-plan.md` §3.1 owns the settings-section `order` table.

## 1. Project shape

DSH APP is a **branded Electron client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** —
Windows / macOS / Linux, public release, MIT. Three constraints govern every
change: **self-contained** (own versioned kernel, never a system `dsh`; brand
functionality is a plugin suite), **two decoupled update channels**, and
**Mainland China first** (mirror chains everywhere; ModelScope, not GitHub, is
the primary shell-update source).

## 2. Stack & layout

Electron 44 + TypeScript 5.7 → CommonJS/ES2022 via `tsc`; electron-builder packs
NSIS (win) / dmg+zip (mac) / AppImage+deb (linux); esbuild 0.28 bundles plugin
halves; `npm` here, `pnpm` in the harness checkout; Node 22+.

- `src/main/` shell (Electron main), `src/kernel/` kernel manager,
  `src/shared/` cross-cutting types, constants and the locale table.
- `plugins/` the sixteen-plugin brand suite — see `plugins/AGENTS.md`.
- `scripts/` build, smoke and probe tooling; `test/` root suites.
- `static/` startup page, `resources/` icons, `docs/` documentation.

Never commit build output (gitignored): `dist/`, `release/`, `runtime-dist/`,
`bundled-kernel/`, `runtime-layers/`, `plugins/*/lib/`, `plugins/*/.test-dist/`,
`plugins/*/package-lock.json`, `logs/`, `scratch/`, `repo/`, `release-notes.md`,
`*.tgz`, `*.log`, `__pycache__/`.

## 3. Build, dev & verification

Prerequisites: for `npm run dev` and `npm test`, none — a dev run boots the
**installed** runtime, the same artifact a packaged start uses. A local
`deepseek-harness` checkout is needed only to work against live sources
(`DSH_APP_DEV_RUNTIME`) or to rebuild the runtime artifact
(`npm run runtime:build`, see `docs/agents/build-and-release.md`); it must have
`pnpm install` + `pnpm run build` run in it.

```sh
npm run typecheck             # tsc --noEmit; the compile gate
npm run build                 # tsc -> dist/ + static/overlay/tray icon copy
npm test                      # root tests (builds first; needs dist/)
npm start                     # build + launch Electron (production-like)
npm run dev                   # DSH_APP_DEV=1 + the installed runtime
#   PowerShell: $env:DSH_APP_DEV="1"; npm start   (no `VAR=1 cmd` in PowerShell)
#   A built runtime tree:  DSH_APP_DEV_KERNEL=D:/.../runtime-dist/work/runtime
#   A source checkout:     DSH_APP_DEV_RUNTIME=D:/.../deepseek-harness  (must be built)
npm run check:graph           # static plugin-graph + suite-roster rules
npm run dist:win | dist:mac | dist:linux
npm run verify                                        # smoke-suite.mjs
npm run verify -- --tgz runtime-dist/dsh-runtime-linux-x64-*.tgz
npm run check:plugins -- --kernel <runtime.tgz> --home <real profile dir>
```

Plugin builds and tests: `plugins/AGENTS.md`.

- Hand-run probes (`scripts/probe-*.mjs` / `.cjs`): `probe-launch-folder.mjs`
  after a kernel-line bump; `probe-settings-nav.cjs --lang en-US [--sweep]` after
  touching a settings section; `probe-drag.cjs` mirrors `DESKTOP_CHROME_CSS` in
  `src/main/window.ts` — **keep the two in sync**.
- **A probe running inside Electron must pass `windowsHide: true` to every
  `spawn`** — else each console child pops a terminal onto the user's desktop.
- Dependency installs: root changes use plain `npm install`; plugin-local
  installs use `--legacy-peer-deps` **inside the plugin dir only** (at the ROOT
  it prunes the peer-only tree and breaks `npm ci`); when switching kernel lines
  delete root `node_modules/` first — a stale tree causes ERESOLVE.
- On a **new kernel line**, bump every `@deepseek-ai/dsh*` dep in the root
  `package.json` to one spec (plugins follow via peer/dev deps), then
  `npm run typecheck` and smoke `<runtime>/app` →
  `node_modules/@deepseek-ai/dsh/lib/bin.js --version`. Rebuilding the runtime
  and the bundled kernel: `docs/agents/build-and-release.md`.

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
- **Failure paths**: user-facing errors are stable, actionable, zh-CN, leak no
  sensitive detail.
- **Security invariants** (design context: `docs/ARCHITECTURE.md`):
  - **No port — on the frames line**: the kernel child's web surface travels
    fd3/fd4 byte pipes; the window loads `dsh-app://app/index.html`, a scheme
    registered privileged **before** `app.ready` and served only by forwarding to
    that child (other host → 404, no host → 503). A 0.1.6-alpha.2+ host binds its
    own loopback port instead (`docs/ARCHITECTURE.md` §6).
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

## 5. Process rules (each cost someone a bad day)

- **Gate commands must run bare — never behind a pipe**: `… | tail && git commit`
  commits on the pipe's exit code.
- **Deletes that can follow a link go through `scripts/lib/remove-tree.mjs`
  (`removeTree`), never a sync recursive call** — a profile must never hold a link
  that NAMES the runtime tree (the kernel tree is mirrored in as HARDLINKS);
  `test/recursive-delete-guard.test.mjs` audits every sync recursive delete, and
  plugin store deletes use a private walker copy.
- **Session header hooks go through `installSessionHeaderRules`** — Electron keeps
  only the LAST `onBeforeSendHeaders` listener per session (measured on 44.4.1: a
  request matched by the first filter arrives with neither hook's headers), so a
  second `install*` call silently disables the first. The shell has two such jobs
  (stamp its own action requests, authenticate the client's stream handshake) and
  both are RULES behind one install; a rule declines a request it does not own by
  returning false. Adding a third registration is a bug by construction.
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
- **Upstream API drift**: slices and `as unknown as` casts bypass the type gate —
  a kernel-deleted API leaves tests green while the runtime throws; verify each
  plugin end-to-end after every kernel-line bump (`npm run verify`,
  `npm run check:plugins`). The half a compile cannot see is a name the line
  STOPPED exporting — `import { IconX } from '…/primitives'` type-checks and is
  `undefined` at render. `test/plugin-kernel-imports.test.mjs` checks every named
  runtime import against the installed line's real exports (no kernel tree, no
  network), and `scratch/check-third-party-client-imports.mjs` runs the same
  check over a third-party plugin's sources.
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

## 6. Known TODOs / scaffolds (do not assume finished)

- `plugin-brand`, `plugin-client-ui`: scaffolds and route details in their JSDoc
  and `plugins/README.md`; the client UI registers two settings sections (Models
  order 11; 诊断/Diagnostics order 22) plus a nav-icon patch — slot ids come and
  go, verify against the running UI.
- **Desktop actions ride the shell's own protocol route**
  (`src/main/shell-actions.ts`, `dsh-app://app/__dsh-app/action/<name>`, inside the
  loaded origin — no port, no kernel child). A Node child cannot reach the scheme,
  so `plugin-brand` hands the client coordinates and the diagnostics page calls
  it; requests carry the top frame's URL + a per-process secret (subframes
  refused).
- **Office payload**: the Python half (upstream's `primary-runtime` set) is wired
  end to end, and every non-linux release cell now smoke-verifies the staged
  tree with the host's own code before shipping (`release.yml`). The payload is
  still not bundled with the installer: a first run with no network converts no
  documents until the 诊断 row downloads it. Detail:
  `docs/agents/build-and-release.md`.
- **Pre-release gaps**: macOS signing/notarization and optional Windows signing
  secrets must be supplied as CI secrets; `resources/icon.png` is a placeholder.
- **The `0.1.7-alpha.1` host line is not shipped-ready** — a LOCALLY built runtime
  of it has been smoked end to end in this tree (`npm run verify -- --tgz` all
  green against `runtime-dist/dsh-runtime-win32-x64-0.1.7-alpha.1.tgz`, plus a real
  app start on `DSH_APP_DEV_KERNEL`), but no RELEASED artifact of that line has
  been cut or verified, and the delivery model that would retire the `kernel/`
  tree, activation file and profile mirror is still planned in
  `docs/capability-roadmap/kernel-package-set.md`.
- Future: signed kernel manifests; `$DSH_HOME` settings rollback on major-version
  upgrades.

## 7. Commits

`<type>(<scope>): <subject>` (`feat:`/`fix:`/`chore:`/`ci:`/`docs:`/`test:`);
imperative, ≤50 chars, no period; body = one change per `-` bullet, ~72-char
wrap, then a standalone `Verified:` line.
