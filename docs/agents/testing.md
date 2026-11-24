# Testing

The three layers that verify this repository, what each one is blind to, and the
CI jobs that gate a merge. Read this before changing a suite's shape, a gate's
wiring, or the order of the CI jobs.

Three layers, each blind to something the others see.

**Root suites** — `npm test` builds first, runs `scripts/ensure-electron.mjs` (Electron's binary is unpacked
lazily, and `node --test` runs each file in its own process, so several files race to unpack it into the same
directory), then `node --test "test/*.test.mjs"` over 70 files. They cover the shell, the kernel manager, the
gates themselves, the security invariants and the documentation-vs-code pairs (`desktop-chrome-css`,
`touchpoints`, `suites-drift`, `recursive-delete-guard`); `test/scratch.mjs` is the shared temp-tree helper.

**Plugin suites** — each plugin's own `scripts/test.mjs` bundles `plugins/plugin-*/tests/*.test.ts`
with esbuild into `.test-dist/` (type-only framework imports stripped) and runs `node --test` over the
result. All nineteen have suites; run one from its own directory per `plugins/AGENTS.md`.

**Real-kernel smoke** — `npm run verify` (`scripts/smoke-suite.mjs`) boots an actual dsh kernel with the full
suite overlay and asserts what a bare `ok:true` cannot: health, every suite route, every dual-face client
bundle non-empty, the PPT template catalog, the bundled PDF CJK font, and (with `--tgz`) that the artifact
really contains the resource directories the plugins declare. This is the executable answer to
"compile-green ≠ runtime-green": the type gate cannot see across the plugin/kernel boundary, and this can.

**Source rules** — a case whose title starts with `source rule:` asserts the SHAPE of a source file
(`assert.match(source, …)`, an absence, an order of two statements), not a behaviour. It is a lint rule that
lives in a suite because the repository has no linter for it, and it is admitted only where no test can run
the behaviour: a React component with no mount harness, app boot in `src/main/index.ts`, Electron-bound code
with no fake. Three conditions hold for every one of them:

1. **It fails when the fix it guards is removed.** A rule that pins a comment, a type annotation, a function's
   name, or a lazy pattern that scans past its own function is deleted instead of kept.
2. **It is scoped to what owns the fact** — the handler, the function, the module — so a change beside it
   cannot satisfy it.
3. **Its title says what the source must keep, and its comment names the defect**, so a reader can tell a
   tripwire from a test, and the day a harness can run the behaviour the rule is replaced by that test.

A pin on a shipped artefact's own text — a stylesheet's declarations, an overlay row, a locale table, a
`package.json` script — is none of these and carries no prefix: there the text IS the product, so matching it
is the behaviour.

What a text assertion cannot see, measured 2026-11 on `test/platform-view.test.mjs`: with `dispose()` no
longer marking the instance and the preload's main-frame guard neutralised, all 26 of the cases it had then
stayed green. A rule sees that a line exists, never that it runs. So a behaviour test is written wherever one
can be: `test/platform-view-lifecycle.test.mjs` runs the view against a fake Electron, both preloads are
evaluated
against a fake `electron` module, the caption sampler is run inside a fake `document`, and
`mountNavIconPatch` runs against five stubbed `document` members and one observer. Adding a renderer (a `react-dom` and a DOM as plugin
devDependencies) is what would turn the remaining component rules into behaviour tests; that is a dependency
decision, not a test fix.

**CI** (`.github/workflows/ci.yml`) is the definition of done for a merge. Its `gate` job runs the
changeset gate, the typecheck, the four static checks and both test layers; its order matters — the
root tests run *after* the per-plugin installs because two suites resolve packages that exist only
inside a plugin's own `node_modules`, and the slot check and the kernel preflight for the same reason
(measured: the preflight reports 15 phantom blockers on a fresh `npm ci` tree, 0 once the plugins are
installed). The preflight is the only gate here that reads the kernel line itself — a copy below the
followed line, a symbol that stopped being exported, a retired slot or service id, or an `engines.node`
floor above the pinned Node; a copy *above* the line is a note, because it means upstream published and
blocking on it would red every unrelated pull request. Its `smoke` job builds the suite and a real
linux-x64 runtime, then runs `smoke-suite.mjs --tgz` on it.
