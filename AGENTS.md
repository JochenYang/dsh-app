# AGENTS.md — DSH APP (dsh-app)

How to work in this repository. This file carries what every task needs; the depth lives in the
documents below. Read the one your change touches, and when a document and the code disagree, re-read the code.

| Read this | When your change touches |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | a module's design: layers, update flow, security posture, packaging |
| [`docs/agents/runtime-shape.md`](docs/agents/runtime-shape.md) | the boot path: the kernel child, the activation file, the brand-suite stitching, the office payload |
| [`docs/agents/security-invariants.md`](docs/agents/security-invariants.md) | a security invariant — §7 indexes them, this file carries the reasoning |
| [`docs/agents/process-rules.md`](docs/agents/process-rules.md) | the reason behind a process rule — §9 indexes them |
| [`docs/agents/testing.md`](docs/agents/testing.md) | a suite's shape, a gate's wiring, or the CI job order |
| [`docs/agents/delegation-division.md`](docs/agents/delegation-division.md) | a delegation prompt section, `plugin-swarm`'s order, or the batch-versus-Agent-Teams split |
| [`docs/agents/known-gaps.md`](docs/agents/known-gaps.md) | whether something here is actually finished |
| [`docs/agents/build-and-release.md`](docs/agents/build-and-release.md) | the runtime artifact, the office payload, the bundled kernel, cutting or recovering a release, the ModelScope mirror |
| [`docs/agents/release-checklist.md`](docs/agents/release-checklist.md) | cutting a release — the order of operations, with the mistakes that each cost one called out |
| [`docs/agents/environment.md`](docs/agents/environment.md) | an environment variable's meaning, or adding one |
| [`docs/agents/troubleshooting.md`](docs/agents/troubleshooting.md) | a timeout, an error code or a log line you cannot place |
| [`docs/agents/kernel-line-regression.md`](docs/agents/kernel-line-regression.md) | a kernel-line move: the pre-flight touchpoint scan, the gates and what each one cannot see, the rendering-side blind spot, the checklist |
| [`docs/agents/profile-supply-chain.md`](docs/agents/profile-supply-chain.md) | a machine's own `dsh` profiles after a kernel-line move |
| [`plugins/AGENTS.md`](plugins/AGENTS.md) | anything under `plugins/` — the roster, the four artifact gates, the version-bump rule (also auto-loaded there) |
| [`plugins/README.md`](plugins/README.md) | which plugin owns a capability, and each one's host/client role |
| [`changesets/README.md`](changesets/README.md) | the release fragment a user-reaching commit must carry |
| the module's own JSDoc header | that module — it states constraints the code cannot show |

## 1. What this project is

DSH APP is a **branded Electron desktop client for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** — DeepSeek's coding-agent
CLI/Web app. Windows / macOS / Linux, public release, MIT, hosted at GitHub `JochenYang/dsh-app`.
Three constraints govern every change: **self-contained** (its own versioned dsh kernel, never depending
on or detecting a system-installed `dsh`; brand functionality is a plugin suite layered on the upstream
kernel — §8 — never a fork), **two decoupled update channels** (the shell and the kernel — dsh + the brand
suite, packed into one runtime artifact — are built, released and updated independently:
`src/main/updater.ts` owns the shell channel, `src/kernel/manager.ts` the kernel one), and **Mainland China
first** (every download has a mirror chain; ModelScope, not GitHub, is the primary shell-update source).

The kernel line has one source of truth: the spec every `@deepseek-ai/dsh*` dependency in the root
`package.json` shares (`^0.2.1-rc.1` today), resolved and asserted by `scripts/kernel-line.mjs`;
nothing else — no workflow variable, no hand-flipped channel — decides it.

## 2. Stack and layout

Electron 44 + TypeScript 5.7 → CommonJS/ES2022 via `tsc`; electron-builder 26 packs NSIS (win) /
dmg+zip (mac) / AppImage+deb (linux); esbuild 0.28 bundles the plugin halves; `npm` here, `pnpm`
inside the harness checkout and the runtime assembly; Node 22+ (what CI runs).

| File | What it decides |
|---|---|
| `package.json` | shell version, every npm script, and the `@deepseek-ai/dsh*` spec that picks the kernel line |
| `tsconfig.json` / `plugins/*/tsconfig.json` | the shell's compile (`strict`, CommonJS, Node resolution, ES2022, `src/` → `dist/`) and a plugin's (ESM, `moduleResolution: "Bundler"`, explicit local-import extensions, `noEmit`) |
| `plugins/*/package.json` | a plugin's own version (hashed into `suiteVersion`), `files` (the only source of runtime resources), `dsh.bundle` / `dsh.client` wiring, and its dependency fields |
| `electron-builder.yml` | packaging targets, the NSIS hook include, `extraResources` (the bundled kernel), the `publish` provider |
| `plugins/dsh-app.patch.yml` | the loader overlay that mounts the suite into the kernel (roster copy 1 of 5 — `plugins/AGENTS.md` §5) |
| `scripts/kernel-line.mjs` | line derivation, `SUITE_PLUGINS` (roster copy 2), `suiteVersion`, the LibreOffice kit pin |
| `scripts/primary-runtime-lock.json` | the Python set the office payload carries, plus the bundled pnpm pin |
| `changesets/*.md` | the release-input fragments (§11) |
| `.github/workflows/{ci,release,publish-mirror}.yml` | the gates, the release pipeline, the ModelScope mirror |
| `.github/scripts/mirror_release.py` (+ its test) | the mirror's own logic, including its delete allowlists |

`src/main/` is the shell (Electron main): boot and lifecycle, the kernel child (`server.ts`,
`desktop-host.ts`), the window and its injected desktop chrome (`window.ts`), tray, updater, safe mode,
proxy detection, crash/log/event files, profile healing, the in-frame dialog. `src/kernel/` is the kernel
manager: install / activate / rollback / cleanup, artifact resolution (`sources/`), `current.json` +
manifest I/O, sha512 integrity, tar filtering, the office payload, bundled-kernel adoption. `src/shared/`
holds cross-cutting constants, types and the shell locale table. `plugins/` is the brand suite (§8);
`scripts/` the build, gate, smoke, probe and release tooling (`scripts/lib/` holds the verdicts they
share); `test/` the root suites; `docs/` the architecture, runbooks, plans and roadmap; `static/` the
startup page; `resources/` the icons; `bundled-kernel/` the tarball, sidecar and manifest a packaged
shell ships.

**Never commit build output** (all gitignored, per `.gitignore`): `dist/`, `release/`, `runtime-dist/`,
`bundled-kernel/`, `runtime-layers/`, `plugins/*/lib/`, `plugins/*/.test-dist/`, `plugins/*/package-lock.json`,
`logs/`, `scratch/`, `repo/`, `.devflow/`, `release-notes.md`, `*.tgz`, `*.log`, `__pycache__/`.

## 3. How the app actually runs

The Electron main process **spawns a real Node child** running the dsh kernel from an installed, versioned
tree, and the window loads `dsh-app://app/index.html` — a privileged custom scheme served only by
forwarding to that child; there is no setup renderer, and the first run downloads or adopts a kernel in
the background. `<userData>/kernel/current.json` is the single source of activation truth, activation is
one atomic file rewrite, and a kernel that fails to become healthy twice is rolled back once.

Full boot path: [`docs/agents/runtime-shape.md`](docs/agents/runtime-shape.md).

## 4. Build, dev and verification commands

Prerequisites: none for `npm run dev` and `npm test` — a dev run boots the **installed** runtime, the same
artifact a packaged start uses; a local `deepseek-harness` checkout is needed only for live sources or to
rebuild the artifact. `DSH_APP_DEV_KERNEL` boots a built runtime tree in place and `DSH_APP_DEV_RUNTIME`
boots a harness source checkout; with neither set a dev run boots the installed runtime, and with nothing
installed it installs the bundled `kernel.tgz` offline (`docs/agents/environment.md` lists every variable).

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
`probe-workbench.cjs` (`node_modules/.bin/electron`) after touching `plugins/plugin-workbench`, its seats or the
sidebar rail — it boots a real runtime artifact and asserts the container in a real window (the row, both child
seats, the rendered page, the card frame, the panel-leave reset), links the container from the working tree, takes
`scripts/fixtures/probe-workbench` as its walk-in domain plugin (build it first — the probe refuses a missing or
stale `lib/` on either half and names the command); `probe-routes.cjs` (`node_modules/.bin/electron`) after a
kernel-line bump or any move of the route carriers — it boots a real runtime artifact in the **desktop-host
shape the shell actually spawns** and asserts what the W14 routing decision rests on: the Connection fetch
carrier is exact-only (S3), passes `Range` through (S4) and streams rather than buffers (S4b), a `webServer`
`kind: 'prefix'` route serves deep sub-paths (S3), and the fence comparison (S5a: the `/api` carrier answers 401
with no cookie and 403 for a foreign `Origin`; S5b: the same prefix route answers both), plus one real suite
plugin's own routes dispatching behind that fence and the carrier's own plain-text 404/403 bodies (S6), linking
`scripts/fixtures/probe-routes` and `scripts/fixtures/probe-wsinject` into the booted profile. Run
`npm run build` first — it `require`s the shell's own `dist/main/` modules, which a clean checkout does not have
— and build the roster packages it links from `plugins/`: it refuses a missing or stale `lib/` on either
fixture or on any roster package, naming the command to run; `probe-effort-hover.cjs` (`node_modules/.bin/electron`) after touching `plugin-effort`'s stylesheet,
its track geometry or its tick rules — it evaluates the REAL sheet (esbuild-bundles `styles.ts`, runs
`adoptStyles` against a stub document) and measures the rendered result in Chromium: a hovered tick
grows and returns, a neighbour does not move, the computed transition names `transform` alone, and
reduced motion keeps the mark without the animation. It boots no kernel, so `npm run build` is not
needed either; it reads the source. Reading the built `lib/client.js` as text is NOT a substitute —
that file is a browser module whose template keeps its `${…}` placeholders, so a text slice of it is
not CSS at all (measured: every tick 0px wide);
`probe-swarm-team-prompt.mjs` and `probe-team-section-mount.mjs` (plain `node`, no Electron) after
touching `plugin-swarm`'s prompt sections or the batch-versus-Team wording — they boot the REAL
`@deepseek-ai/dsh-system-prompt` service out of the installed kernel and drive the real `assemble()`
/ `renderPrompt()`, because the facts they check are invisible to a unit test over constants: whether
a `tool:agent-team` section survives assembly next to the kernel's own `team:policy` (a same-name
scoped section SHADOWS a global one), whether the three delegation sections stay CONTIGUOUS and in
order 590/600/620, whether a stray double-brace group makes rendering throw, and whether the Team
section mounts through `ctx.inject(['agentTeams'])` in BOTH composition orders (present at activation,
and registered later by a bundle layer) and unmounts when the service goes. Both read the working
tree by default; `--plugin <lib/index.js>` points them at a copy that shipped in a runtime artifact,
which is what makes a packaged-bytes claim rather than a working-tree one. `attribute-prompt.mjs`
answers "why is the system prompt N KB": it decodes a recorded session (a zstd CONCATENATION of
frames — a single `zstdDecompressSync` returns only the first frame and every session then looks
empty), recovers the assembled prompt, and ranks it by OWNER. Its large contributors have not been
the sections anyone would suspect: a PTC preset's generated `run_code` TypeScript SDK
(`interface ToolArgsMap` / `ToolOutputMap`, measured at 89 KB of a 112 KB prompt) dwarfs everything
this suite contributes (the batch section is 1.7 KB);
`probe-drag.cjs` mirrors `DESKTOP_CHROME_CSS` in
`src/main/window.ts` — **keep the two in sync** (a root test
already diffs them); `probe-office-menu.cjs` (`node_modules/.bin/electron`) after touching
`plugin-ppt`'s `office-menu.ts`, its icons, the `menu.*` dictionary keys or the client entry's
registration block — it boots a real runtime artifact with `plugin-ppt` linked from the WORKING TREE,
types `/` into a real composer and asserts what a static check cannot see: four rows rendering with
a glyph, their name and their description; the four rows contiguous and between the kernel's 指令 and
技能 groups; a click landing ONE chip node whose token is `/office-docx` (so one Backspace removes it);
the same token typed by hand still readable in the conversation; the mode capsule still toggling; and
no error, crashed slot entry or failure line anywhere in the run; `probe-git-panel.cjs`
(`node_modules/.bin/electron`) after touching `plugin-sidebar`'s tree, its right pane or its diff —
it builds a fixture repository whose deep single-child path, sibling directory and many-hunk file
make the three facts decidable, boots a real runtime artifact with `plugin-sidebar` linked from the
WORKING TREE, and asserts what no static check can see: the tree nests by real directory level with
the single-child chain compacted into one header, every file row labelled with its own name, folding
one header hiding only its subtree; the right pane having exactly ONE vertical scroller for a tall
diff (the `<pre>` inside it must not scroll vertically — `overflow-y: visible` computes to `auto`
when the other axis scrolls, which is what produced the second bar); and the change ruler rendering
merged marks that match the diff's own +/− lines and move the scroll when clicked. It reaches the Git
view through the per-session preference the kernel itself restores, because the view-tab strip does
not render with a single `conversation.view` registrant — see `docs/agents/known-gaps.md`; that walk
depends on session switching and Git-panel timing, so a failure there can mean anything, and
`probe-diff-ruler.cjs` (plain `node` + Electron, no kernel) isolates the one fact a CSS floor
destroys: it applies the plugin's REAL stylesheet in Chromium and measures marks at 0.25/1/5/20%,
asserting the painted height equals the true fraction (0.5px, 2px, 10px, 40px on a 200px column),
that no minimum height applies, and that the `::after` overhang still makes a hairline clickable —
measured once as 0.25% painting at 2px, which made a one-line change look like a whole block; the remaining
`probe-chrome-surfaces.cjs` / `probe-in-frame-dialog.cjs` /
`probe-overlay-modal.cjs` / `probe-update-card.cjs` / `probe-whale.cjs` / `probe-mirror.mjs` cover the surfaces
their names say; `scripts/capture.mjs` screenshots the running UI for visual work.

`npm run probe:reap` (`scripts/reap-probe-kernels.mjs`) has no re-run trigger — it is maintenance, not a
check. A probe stopped by a timeout, a closed terminal or `taskkill /F` ends through
`TerminateProcess`, so nothing takes its `dsh web` kernel down and it keeps a core and hundreds of MB
until something else reaps it. This reaps on demand: first the registry the probes write while they run
(`scratch/.probe-kernels.json` — entries whose probe is gone, and a no-op where nothing has recorded
one), then a sweep for any kernel older than `--stale` (15 minutes by default). **Safe to run at any
time** — it only touches a process whose command line carries `--no-open`, which `npm run dev`'s kernel
never does, and only once it is past the threshold; `--dry-run` prints the same decisions and changes
nothing.

**A probe running inside Electron must pass `windowsHide: true` to every `spawn`** — otherwise each
console child pops a terminal onto the user's desktop.

**Dependency installs**: root changes use plain `npm install`; plugin-local installs use
`--legacy-peer-deps` **inside the plugin directory only** (at the ROOT it prunes the peer-only tree
and breaks `npm ci`); when switching kernel lines delete root `node_modules/` first — a stale tree
causes ERESOLVE.

## 5. Testing

Three layers, each blind to something the others see: the **root suites** (`npm test`, 70 files), the
**plugin suites** (each plugin's own `scripts/test.mjs`), and the **real-kernel smoke** (`npm run
verify`), the executable answer to "compile-green ≠ runtime-green". CI is the definition of done for a
merge, and its job order matters: the root tests run *after* the per-plugin installs, because two suites
resolve packages that exist only inside a plugin's own `node_modules`. What each layer covers and the
smoke's assertions: [`docs/agents/testing.md`](docs/agents/testing.md).

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
  check** — see the gates in `plugins/AGENTS.md` §3.
- **Failure paths**: user-facing errors are stable, actionable, zh-CN, and leak no sensitive detail.
  Errors carry actionable context and preserve the original cause; failures crash where they happen
  rather than being swallowed behind a degraded path.
- **No native dialogs in client UI** (`window.alert` / `confirm` / `prompt`) — use the modal idiom
  (mask + card, Esc/mask = cancel, Enter = primary; `src/main/in-frame-dialog.ts`).
- **Client UI composes the host's primitives; it never redraws them** — `Modal` (+ `Button`) for a dialog,
  `DiffBlock` for a diff, `Toast` for an announcement, all from `@deepseek-ai/dsh-client-ui-primitives`.
  Check that package's export list BEFORE writing a surface, and override a primitive through its own
  documented seat (`className`, `anchor`, `holdMs`) rather than by redrawing it. `RiskConfirmation`
  requires an acknowledgement checkbox — reserve it for genuinely irreversible choices. A message that
  must be READ before acting holds 8s, not the 3s default. The suite's fuller version: `plugins/AGENTS.md` §6.
- **Host halves never send user-visible prose** — only `HostText { code, params?, text? }`
  (`plugin-websearch/src/wire.ts`): a stable code the client maps to its dictionary, plus an English
  diagnostic.
- **Desktop adaptation stays shell-side** — inject via `executeJavaScript`, stylesheets and profile
  patch rows only; never modify harness source. Injected surfaces answer status tokens, never copy.
- **Settings sections are one ordered rail.** The `order` values live in a table in
  `docs/desktop-optimization-plan.md` §3.1: **update that table in the same commit as an `order` change,
  and never reuse a value that is taken.** Current suite rows: 模型高级设置 / Advanced models 11, MCP 服务器 /
  MCP 12, Hooks 13, 网络搜索 / Web search 14, 并行子代理 / Swarm 19, 用量统计 / Usage 21, 会话记忆 / Memory 22,
  会话归档 / Archives 23, 维护设置 / Maintenance 24, 关于 DSH-APP / About 26;
  upstream owns 0, 10, 15, 20 and the pinned 25. 维护设置 is ONE section with three tabs — 预设包 / Presets 2,
  诊断 / Diagnostics 3, 撤回隔离区 / Quarantine 4 (order 1 is a vacant slot, kept vacant) — declared by the
  section owner through the `settings.dsh-app-maintenance.tab` child slot.

## 7. Security invariants

These are invariants, not preferences; a change that weakens one needs a security review, not a fixup.
Each rule's reasoning: [`docs/agents/security-invariants.md`](docs/agents/security-invariants.md).

- Main window: `contextIsolation`, `sandbox`, `nodeIntegration:false`, one frozen preload marker; neither preload grows a channel without a security review.
- Navigation: `dsh-app://app` plus the shell's own splash `file:` document; everything else to `shell.openExternal`.
- No port on the frames line: fd3/fd4 byte pipes, or a `0.1.6-alpha.2+` host's own loopback port and a cookie.
- An app-origin document never goes into a sandbox frame.
- Plugin `/api` routes sit behind the Connection carrier's Host/Origin check plus browser auth; the host's `webserver` row stays disabled.
- Kernel downloads are sha512-verified before activation; tar paths and link targets that leave the extraction root are refused.
- Never hardcode secrets; dsh's credential store is the store, plugin keys use `$ENV:NAME` and are masked on read.
- Redact credential-looking fragments in child logs; `dsh-events.jsonl` records derived fields only.

## 8. The brand plugin suite (`plugins/`)

Seventeen dsh plugins layered on the upstream kernel **without forking it** — that is what keeps the
desktop app updateable when upstream moves. Each is its own npm package with a host half, a client half,
or both; `plugins/README.md` is the roster, `plugins/dsh-app.patch.yml` the loader overlay that mounts
them, and desktop adaptation always stays shell-side — never a harness modification. `plugin-workbench` is
the container: its card grid and its `workbench.view` seat currently hold no domain, and a domain joins by
registering a card into one of them, never by a change to the container.

The suite's own rules — the roster's five copies and `check:suites:gate`, the four checks that gate a
plugin's `lib/`, and the version-bump requirement — are in [`plugins/AGENTS.md`](plugins/AGENTS.md).

## 9. Process rules (each cost someone a bad day)

The reason behind each one: [`docs/agents/process-rules.md`](docs/agents/process-rules.md).

- Gate commands must run bare — never behind a pipe.
- Deletes that can follow a link go through `removeTree`, never a sync recursive call.
- Session header hooks go through `installSessionHeaderRules`; a third registration is a bug.
- The host child runs a real Node, never Electron's own.
- On the web line the profile patch must not repeat the home layer's rows, and `- id: web` is a PAIR.
- A mirror into the profile owns PACKAGES, not a shared scope directory.
- The window's client state belongs to the kernel LINE that wrote it.
- A suite plugin must be linked into the BOOTED PROFILE's `node_modules/@dsh-app`.
- No backticks inside template-literal CSS/scripts.
- Injected `executeJavaScript` promises must not resolve eagerly.
- Upstream API drift: slices and `as unknown as` casts bypass the type gate.
- Proxy: probe before injecting; the runtime pins `undici` to 8.10.2.
- Web search is a provider, not a tool; it never patches `dns.lookup` process-wide.

## 10. Known TODOs and scaffolds

Do not assume anything here is finished: `plugin-brand` and `plugin-client-ui` are partly scaffolds, the
office payload is still not bundled with the installer, `plugin-sidebar` has no client test suite, macOS
signing and Windows signing secrets are not supplied, and signed kernel manifests are future work.

The full list: [`docs/agents/known-gaps.md`](docs/agents/known-gaps.md).

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

A change in `src/` needs a new `vX.Y.Z` tag — nothing else delivers it. A change in `plugins/` or
`scripts/build-runtime.mjs` needs a **new runtime**, and it only reaches an existing install if its
identity changed: the adoption key is `dshVersion+suiteVersion`, and `suiteVersion` hashes the suite
plugins' **versions** only, so an unbumped plugin ships nothing. Both → one shell release with a
refreshed `bundled-kernel/`.

The three rules that each cost a release — the `runtime-<dshVersion>` release stays a prerelease, a shell
tag is never re-run (422 `already_exists`), and a draft is flipped with the generated `--notes-file`,
which also starts the ModelScope mirror — are written out in
[`docs/agents/release-checklist.md`](docs/agents/release-checklist.md).

## 13. Reporting a round's work

Every rule below was paid for in this repository's own history, and they share one cause: treating the
owner's attention as the place where open work waits.

- **A round ends in one of two states**: done, verified and shipped — or blocked, with the cause and
  the shortest path that unblocks it. There is no third state, and neither "here are the decisions I
  left for you" nor "little context left" is a report — the work was always doable, so do it, then say
  what was done.
- **A defect is not a backlog item.** Sort every open item into: harms a user, leaks something, or
  delays the next discovery — a defect, fix it now; versus makes a future mistake visible earlier —
  hardening, schedule it. Filing a defect as "next round" is how v0.16.3 shipped unbounded catalog
  reads, a wall-clock token TTL and six undeclared plugin imports — all fixed only in v0.16.4.
- **Decide, then state.** Money, legal exposure, an irreversible or outward-facing act and a change to
  the product's shape are the owner's call; everything else — including "is this acceptable?" and
  "should this be tighter?" — is decided here, written down with its reason, and reported as fact. A
  thing investigated and deliberately left unchanged belongs in that record too, not as an open item
  the reader has to re-ask.
- **Prove a gate where it runs.** A check wired into CI must be exercised in CI's own environment — a
  fresh `--legacy-peer-deps` tree with no peers and no `lib/` — before it is called green; a local green
  is not that proof, and the type gate shipped exactly that way once and stopped a release. For a claim
  about a commit, name the tree hash, not the impression. §12's three release rules apply unchanged,
  including the re-cut at the same version.
