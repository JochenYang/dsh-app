# AGENTS.md — DSH APP (dsh-app)

How to work in this repository. This file carries what every task needs; the depth lives in the
documents below. Read the one your change touches, and when a document and the code disagree, re-read the code.

| Read this | When your change touches |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | a module's design: layers, update flow, security posture, packaging; §2.1 is the which-file-decides-what table |
| [`docs/agents/commands.md`](docs/agents/commands.md) | a gate, a packaging target, or which probe your change obliges you to re-run |
| [`docs/agents/runtime-shape.md`](docs/agents/runtime-shape.md) | the boot path: the kernel child, the activation file, the brand-suite stitching, the office payload |
| [`docs/agents/security-invariants.md`](docs/agents/security-invariants.md) | a security invariant — §7 indexes them, this file carries the reasoning |
| [`docs/agents/process-rules.md`](docs/agents/process-rules.md) | the reason behind a process rule — §9 indexes them |
| [`docs/agents/testing.md`](docs/agents/testing.md) | a suite's shape, a gate's wiring, or the CI job order |
| [`docs/agents/settings-rail-order.md`](docs/agents/settings-rail-order.md) | adding or moving a settings section: the order table and the no-reuse rule |
| [`docs/agents/codegraph.md`](docs/agents/codegraph.md) | `plugin-codegraph`: what the graph holds, the three pass phases, the three ways it can be quietly wrong |
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

The kernel LINE has one source of truth: the spec every `@deepseek-ai/dsh*` dependency in the root
`package.json` shares, resolved and asserted by `scripts/kernel-line.mjs`; nothing else — no workflow
variable, no hand-flipped channel — decides it. The concrete VERSION is the one the committed
`package-lock.json` resolved (the dist-tag is only a fallback for a tree without a lockfile), so a
suite-only release keeps the kernel it already pins instead of following npm `next`.

## 2. Stack and layout

Electron 44 + TypeScript 5.7 → CommonJS/ES2022 via `tsc`; electron-builder 26 packs NSIS (win) /
dmg+zip (mac) / AppImage+deb (linux); esbuild 0.28 bundles the plugin halves; `npm` here, `pnpm`
inside the harness checkout and the runtime assembly; Node 22+ (what CI runs).

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

Which file decides what (the `package.json` script table, the `tsconfig` shapes, the roster
copies, the workflow roles) is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2.1 — read the row
for the file you are about to change.

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

The four a change almost always needs:

```sh
npm run typecheck             # tsc --noEmit; the compile gate
npm run build                 # tsc -> dist/ + static/overlay/tray icon copy
npm test                      # root suites (builds first; needs dist/)
npm run dev                   # DSH_APP_DEV=1 + the installed runtime
```

Everything else — packaging targets, the six static gates, `npm run verify`, the
hand-run probes with the trigger that obliges each one, `probe:reap`, and the
dependency-install rules — is in [`docs/agents/commands.md`](docs/agents/commands.md).
Read it when you need a gate, an artifact, or to know which probe your change
obliges you to re-run.

**Two facts that change how you verify**, both from that file:

- A **prompt** change is testable with `npm run dev` alone: dev resolves the suite
  from the working tree (`devSuiteSources()`, `src/main/index.ts:1244`), not from the
  installed kernel's copy. A packaged build reads the kernel's copy and needs a release.
- A probe running inside Electron must pass `windowsHide: true` to every `spawn`,
  or each console child pops a terminal onto the user's desktop.

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
- **Settings sections are one ordered rail.** Two rules, and they are the ones that get broken:
  **update the order table in the same commit as an `order` change, and never reuse a value that is
  taken.** The current assignments, the upstream-owned and pinned slots, and the 维护设置 tab shape are
  in [`docs/agents/settings-rail-order.md`](docs/agents/settings-rail-order.md) — read it before adding
  or moving a section. No gate catches a collision; the rail just renders in an order nobody chose.

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

Eighteen dsh plugins layered on the upstream kernel **without forking it** — that is what keeps the
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
