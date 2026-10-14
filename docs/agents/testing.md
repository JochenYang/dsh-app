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
