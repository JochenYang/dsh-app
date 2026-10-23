# Commands, gates and hand-run probes

The full command surface. `AGENTS.md` §4 keeps the four commands a change
almost always needs and points here for the rest; read this file when you need
a gate, a packaging target, or to know which probe a change obliges you to
re-run.

## Prerequisites

None for `npm run dev` and `npm test`. A dev run boots the **installed** runtime,
the same artifact a packaged start uses; a local `deepseek-harness` checkout is
needed only for live sources or to rebuild the artifact.

`DSH_APP_DEV_KERNEL` boots a built runtime tree in place and
`DSH_APP_DEV_RUNTIME` boots a harness source checkout; with neither set a dev run
boots the installed runtime, and with nothing installed it installs the bundled
`kernel.tgz` offline. `docs/agents/environment.md` lists every variable.

One consequence worth knowing before you test a **prompt** change: dev mode
resolves the suite from the working tree (`devSuiteSources()`,
`src/main/index.ts:1244`), not from the installed kernel's copy, so `npm run dev`
exercises edited plugin source with no runtime install. A packaged build goes
through `prodSuiteSources()` and reads the kernel's own copy — that one needs a
release.

## Everyday commands

```sh
npm run typecheck             # tsc --noEmit; the compile gate
npm run build                 # tsc -> dist/ + static/overlay/tray icon copy
npm test                      # root suites (builds first; needs dist/)
npm start                     # build + launch Electron (production-like)
npm run dev                   # DSH_APP_DEV=1 + the installed runtime
#   PowerShell: $env:DSH_APP_DEV="1"; npm start   (no `VAR=1 cmd` in PowerShell)
#   A built runtime tree:  DSH_APP_DEV_KERNEL=D:/.../scratch/<name>/runtime
#   A source checkout:     DSH_APP_DEV_RUNTIME=D:/.../deepseek-harness  (must be built)
```

## Packaging and artifacts

```sh
npm run dist:win | dist:mac | dist:linux          # build + bundle kernel + electron-builder
npm run runtime:build                             # rebuild the runtime artifact
npm run primary-runtime:build                     # stage the Python set the office payload carries
npm run smoke:package                             # assert a packaged output carries what boot loads
npm run icon:build | icon:gen                     # regenerate resources/ icons
```

## Gates (all static — no kernel, no network)

```sh
npm run check:graph           # plugin-graph + suite-roster rules
npm run check:suites          # the five roster copies agree (--check form: check:suites:gate)
npm run check:slots           # every ctx.slots id a client half names still exists in the line
npm run check:surface         # kernel-surface report
npm run check:touchpoints     # the seven pre-flight contact-surface scans (--check form gates)
npm run check:plugins -- --kernel <runtime.tgz> --home <the dir holding profiles/>
```

## Real-kernel verification

```sh
npm run verify                                        # smoke-suite.mjs against a dev checkout
npm run verify -- --tgz runtime-dist/dsh-runtime-linux-x64-*.tgz
```

## Hand-run probes

Each probe mirrors a piece of shipped behaviour and must be re-run when that
piece moves. The trigger is the column that matters — a probe whose trigger has
not moved does not need a run.

| Probe | Re-run when | What only it can see |
|---|---|---|
| `probe-launch-folder.mjs` | after a kernel-line bump | the folder-launch path |
| `probe-settings-nav.cjs --lang en-US [--sweep]` | after touching a settings section | order, icons, scrolling, residual Han characters |
| `probe-workbench.cjs` | after touching `plugins/plugin-workbench`, its seats, or the sidebar rail | the container in a real window: the row, both child seats, the rendered page, the card frame, the panel-leave reset |
| `probe-routes.cjs` | after a kernel-line bump or any move of the route carriers | what the W14 routing decision rests on (S3–S6) |
| `probe-effort-hover.cjs` | after touching `plugin-effort`'s stylesheet, track geometry or tick rules | the REAL sheet's rendered behaviour in Chromium |
| `probe-diff-ruler.cjs` | after touching the Git panel's ruler or its styles | a mark's PAINTED height against its true line fraction |
| `probe-codegraph-langs.cjs` | after touching `plugin-codegraph`'s `styles.ts`, its language-row markup, or the row's action button | a language row LAID OUT at the grid's 240px floor: the action label stays on one line, the name is not truncated, the tooltip ANCHOR box equals the width of the word it labels (a flex box measured 164px for a 31px word, which is where the bubble landed), and the click target keeps its width — plus the component-side structure a stylesheet measurement cannot see |

**`plugin-codegraph/scripts/fetch-ci-grammars.mjs`** is not a probe: it is the CI
step that downloads the four on-demand grammars, through the product's own
`downloadGrammar` (so the recorded sha512 applies), before the plugin suites run.
Without it those tables print 16 skips. To reproduce CI locally, run it into a
directory and set `DSH_APP_CODEGRAPH_GRAMMARS` to the same directory.
| `probe-office-menu.cjs` | after touching `plugin-ppt`'s `office-menu.ts`, its icons, the `menu.*` keys, or the client entry's registration | the four rows rendering, ordered, clicking to ONE chip |
| `probe-swarm-team-prompt.mjs` | after touching `plugin-swarm`'s prompt sections | whether both delegation sections survive assembly, contiguous and ordered |
| `probe-team-section-mount.mjs` | after touching the Team section's mount | the optional `agentTeams` mount in BOTH composition orders |
| `probe-chrome-surfaces.cjs` / `probe-in-frame-dialog.cjs` / `probe-overlay-modal.cjs` / `probe-update-card.cjs` / `probe-whale.cjs` / `probe-mirror.mjs` | after touching the surface each names | that surface |

`scripts/capture.mjs` screenshots the running UI for visual work.

### The probes whose shape is easy to get wrong

**`probe-workbench.cjs`** (`node_modules/.bin/electron`) boots a real runtime
artifact, links the container from the working tree, and takes
`scripts/fixtures/probe-workbench` as its walk-in domain plugin — build it first:
the probe refuses a missing or stale `lib/` on either half and names the command.

**`probe-routes.cjs`** (`node_modules/.bin/electron`) boots a real runtime
artifact in the **desktop-host shape the shell actually spawns** and asserts what
the W14 routing decision rests on: the Connection fetch carrier is exact-only
(S3), passes `Range` through (S4) and streams rather than buffers (S4b), a
`webServer` `kind: 'prefix'` route serves deep sub-paths (S3), and the fence
comparison (S5a: the `/api` carrier answers 401 with no cookie and 403 for a
foreign `Origin`; S5b: the same prefix route answers both), plus one real suite
plugin's own routes dispatching behind that fence and the carrier's own plain-text
404/403 bodies (S6). It links `scripts/fixtures/probe-routes` and
`scripts/fixtures/probe-wsinject` into the booted profile. Run `npm run build`
first — it `require`s the shell's own `dist/main/` modules.

**`probe-effort-hover.cjs`** (`node_modules/.bin/electron`) evaluates the REAL
sheet (esbuild-bundles `styles.ts`, runs `adoptStyles` against a stub document) and
measures the rendered result in Chromium: a hovered tick grows and returns, a
neighbour does not move, the computed transition names `transform` alone, and
reduced motion keeps the mark without the animation. It boots no kernel, so
`npm run build` is not needed; it reads the source. Reading the built
`lib/client.js` as text is NOT a substitute — that file is a browser module whose
template keeps its `${…}` placeholders, so a text slice of it is not CSS at all
(measured: every tick 0px wide).

**`probe-diff-ruler.cjs`** (`node_modules/.bin/electron`, no kernel, no build)
applies `plugin-sidebar`'s REAL stylesheet in Chromium and measures marks at
0.25/1/5/20%, asserting the painted height equals the true fraction (0.5px, 2px,
10px, 40px on a 200px column), that no minimum height applies, and that the
`::after` overhang still makes a hairline clickable — measured once as 0.25%
painting at 2px, which made a one-line change look like a whole block. **The Git
panel's own UI walk was retired** (2026-10-22): it depended on session switching
and Git-panel timing, and its `A1` step failed on the switch rather than on the
panel, so a red run proved nothing. Its remaining facts now rest on the
pure-function suite — `buildPathTree` (9 cases) and `diffRulerMarks` (6 cases) —
plus that probe. The single-vertical-scroller rule has **no automated check**,
which `docs/agents/known-gaps.md` records. Do not re-add a UI walk for this
plugin without fixing the session-switch precondition first.

**`probe-office-menu.cjs`** (`node_modules/.bin/electron`) boots a real runtime
artifact with `plugin-ppt` linked from the WORKING TREE, types `/` into a real
composer and asserts what a static check cannot see: four rows rendering with a
glyph, their name and their description; the four rows contiguous and between the
kernel's 指令 and 技能 groups; a click landing ONE chip node whose token is
`/office-docx` (so one Backspace removes it); the same token typed by hand still
readable in the conversation; the mode capsule still toggling; and no error,
crashed slot entry or failure line anywhere in the run.

**`probe-swarm-team-prompt.mjs`** and **`probe-team-section-mount.mjs`** (plain
`node`, no Electron) boot the REAL `@deepseek-ai/dsh-system-prompt` service out of
the installed kernel and drive the real `assemble()` / `renderPrompt()`, because
the facts they check are invisible to a unit test over constants: whether a
`tool:agent-team` section survives assembly next to the kernel's own `team:policy`
(a same-name scoped section SHADOWS a global one), whether the three delegation
sections stay CONTIGUOUS and in order 590/600/620, whether a stray double-brace
group makes rendering throw, and whether the Team section mounts through
`ctx.inject(['agentTeams'])` in BOTH composition orders and unmounts when the
service goes. Both read the working tree by default; `--plugin <lib/index.js>`
points them at a copy that shipped in a runtime artifact, which is what makes a
packaged-bytes claim rather than a working-tree one.

## A probe running inside Electron must pass `windowsHide: true` to every `spawn`

Otherwise each console child pops a terminal onto the user's desktop.

## Reaping orphaned probe kernels

`npm run probe:reap` (`scripts/reap-probe-kernels.mjs`) has no re-run trigger — it
is maintenance, not a check. A probe stopped by a timeout, a closed terminal or
`taskkill /F` ends through `TerminateProcess`, so nothing takes its `dsh web`
kernel down and it keeps a core and hundreds of MB until something else reaps it.
This reaps on demand: first the registry the probes write while they run
(`scratch/.probe-kernels.json` — entries whose probe is gone, and a no-op where
nothing has recorded one), then a sweep for any kernel older than `--stale` (15
minutes by default). **Safe to run at any time** — it only touches a process whose
command line carries `--no-open`, which `npm run dev`'s kernel never does, and
only once it is past the threshold; `--dry-run` prints the same decisions and
changes nothing.

## Dependency installs

Root changes use plain `npm install`; plugin-local installs use
`--legacy-peer-deps` **inside the plugin directory only** (at the ROOT it prunes
the peer-only tree and breaks `npm ci`); when switching kernel lines delete root
`node_modules/` first — a stale tree causes ERESOLVE.

## Diagnosing the prompt

`scripts/attribute-prompt.mjs` answers "why is the system prompt N KB". It decodes
a recorded session (a zstd CONCATENATION of frames — a single
`zstdDecompressSync` returns only the first frame and every session then looks
empty), recovers the assembled prompt, and ranks it by OWNER. Its large
contributors have not been the sections anyone would suspect: a PTC preset's
generated `run_code` TypeScript SDK (`interface ToolArgsMap` / `ToolOutputMap`,
measured at 89 KB of a 112 KB prompt) dwarfs everything this suite contributes
(the batch section is 1.7 KB).
