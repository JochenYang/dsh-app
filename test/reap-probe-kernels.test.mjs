// The decision that makes `scripts/reap-probe-kernels.mjs` safe: which process
// commands are a leaked probe kernel, and which are somebody's live work.
//
// Every case below pins one way the decision can be wrong. The four that matter:
// a probe-shaped kernel past the threshold MUST be reaped (the leak this closes);
// the same argv under the threshold MUST be kept (a probe running right now);
// `dev.mjs`'s own kernel MUST be kept at any age (it is the developer's session,
// not a leftover — and it is what a sloppy matcher would take); and a command
// line that merely carries `dsh web` inside an ARGUMENT VALUE MUST be kept (a
// substring match would kill it).
//
// The argv shapes are copied from the real spawn sites, not invented:
//   scripts/probe-workbench.cjs   spawn(nodeBin, [script, '--profile', 'dsh-app', … '--no-open'])
//   scripts/probe-settings-nav.cjs spawn(`pnpm dsh web … --no-open`, { shell: true })
//   scripts/dev.mjs               → `npm start` → the shell's
//                                 spawn(executable, ['--expose-internals', entry, …])
//
// Nothing here spawns a process; the function is pure by design.
//
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isProbeKernel, parseArgs, splitCommandLine } from '../scripts/reap-probe-kernels.mjs'

const MINUTE = 60_000
const STALE = 15 * MINUTE
const NOW = 1_800_000_000_000

/** A start time `minutes` before {@link NOW}. */
const startedMinutesAgo = (minutes) => NOW - minutes * MINUTE

/** probe-workbench's own argv: the CLI entry, direct, `--no-open` last. */
const WORKBENCH = [
  'C:\\runtime\\node\\node.exe',
  'C:\\runtime\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  '--profile', 'dsh-app',
  '--patch', 'C:\\repo\\plugins\\dsh-app.patch.yml',
  '--host', '127.0.0.1', '--port', '53177',
  '--no-open',
]

/** probe-settings-nav's shell: true spawn, as Win32_Process reports it. */
const SETTINGS_NAV = 'cmd.exe /d /s /c "pnpm dsh web --patch '
  + '\'C:\\repo\\plugins\\dsh-app.patch.yml\' --host 127.0.0.1 --port 53178 --no-open"'

test('a probe-shaped kernel older than the threshold is reaped', () => {
  // Both spawn shapes, because they are matched by different rules and a fix to
  // one must not silently drop the other.
  assert.equal(isProbeKernel(WORKBENCH, startedMinutesAgo(45), NOW, STALE), true)
  assert.equal(isProbeKernel(SETTINGS_NAV, startedMinutesAgo(45), NOW, STALE), true)
})

test('the same kernel under the threshold is kept', () => {
  // A probe that is running right now: 1 minute in, and 14 minutes in.
  assert.equal(isProbeKernel(WORKBENCH, startedMinutesAgo(1), NOW, STALE), false)
  assert.equal(isProbeKernel(WORKBENCH, startedMinutesAgo(14), NOW, STALE), false)
  assert.equal(isProbeKernel(SETTINGS_NAV, startedMinutesAgo(1), NOW, STALE), false)
})

test('exactly at the threshold the kernel is reaped, and --stale 0 reaps at once', () => {
  // The boundary is inclusive: `--stale 0` is a documented way to reap now, and
  // an exclusive comparison would make it do nothing.
  assert.equal(isProbeKernel(WORKBENCH, NOW - STALE, NOW, STALE), true)
  assert.equal(isProbeKernel(WORKBENCH, NOW, NOW, 0), true)
})

test("a dev.mjs-style kernel is kept at any age", () => {
  // The shell's own child. No `--no-open` anywhere: `npm run dev` → `npm start`
  // → spawn(executable, ['--expose-internals', entry, runtimeDir, projectDir, …]).
  const devShell = [
    'C:\\runtime\\node\\node.exe',
    '--expose-internals',
    'C:\\repo\\src\\desktop-host-entry.js',
    'C:\\runtime',
    'D:\\projects\\notes',
    'C:\\runtime\\primary-runtime',
  ]
  assert.equal(isProbeKernel(devShell, startedMinutesAgo(600), NOW, STALE), false)
  // The kernel a dev session starts for itself, in the shape a probe would use
  // minus the flag — the one line that separates the two.
  const devKernel = WORKBENCH.filter((part) => part !== '--no-open')
  assert.equal(isProbeKernel(devKernel, startedMinutesAgo(600), NOW, STALE), false)
  // And the wrapper form without it.
  assert.equal(isProbeKernel('pnpm dsh web --host 127.0.0.1 --port 53178', startedMinutesAgo(600), NOW, STALE), false)
})

test('a command line that merely carries `dsh web` as an argument value is kept', () => {
  // An editor, a `--patch` value, a working directory note: the words occur, but
  // as ONE quoted argument, not as the subcommand. A `/dsh web/` substring match
  // reaps this; token equality does not.
  const notes = 'node "C:\\Program Files\\note-cli\\bin.js" --open "C:\\my apps\\dsh web notes.md" --no-open'
  assert.equal(isProbeKernel(notes, startedMinutesAgo(600), NOW, STALE), false)
  // The same string as an already-split argv, where the space survives inside
  // one element — the form the quote-aware splitter produces.
  assert.equal(isProbeKernel([
    'node', 'C:\\Program Files\\note-cli\\bin.js', '--open', 'C:\\my apps\\dsh web notes.md', '--no-open',
  ], startedMinutesAgo(600), NOW, STALE), false)
  // A path that ends in the CLI's own entry but is not it, under a `--no-open`
  // that belongs to something else.
  assert.equal(isProbeKernel('webpack --watch --no-open dsh-web-notes', startedMinutesAgo(600), NOW, STALE), false)
})

test('a parent shell that repeats the kernel command line is kept', () => {
  // Measured, not imagined: with the CLI-entry rule applied to a shell's quoted
  // `-c` argument, the bash shells that launched a fake probe kernel matched, and
  // a real run would have taken down the shell the operator started the probe
  // from (reported as 10 processes in one tree). A blob is read for the `pnpm …
  // dsh web` wrapper only — a `cmd.exe /c "pnpm dsh web …"` wrapper is a kernel's
  // parent, a `bash -c "… node … dsh/lib/bin.js …"` is somebody's terminal.
  const parentShell = '"C:\\Program Files\\Git\\bin\\bash.exe" -c "cd \'/d/repo\' && node scratch/x/dsh/lib/bin.js '
    + '--profile dsh-app --host 127.0.0.1 --port 53199 --no-open"'
  assert.equal(isProbeKernel(parentShell, startedMinutesAgo(600), NOW, STALE), false)
  // The wrapper through the same shape IS matched: `probe-settings-nav.cjs`
  // spawns exactly this, and `taskkill /T` on it is what takes the kernel down.
  assert.equal(isProbeKernel('cmd.exe /d /s /c "pnpm dsh web --host 127.0.0.1 --port 53199 --no-open"',
    startedMinutesAgo(600), NOW, STALE), true)
})

test('a pnpm wrapper without the dsh web subcommand is kept', () => {
  // `pnpm dsh install`, `pnpm dsh plugin …`: a package operation, not a server.
  assert.equal(isProbeKernel('pnpm dsh install --no-open', startedMinutesAgo(600), NOW, STALE), false)
})

test('the quote-aware splitter keeps a quoted argument whole', () => {
  // This is the mechanism the argument-value case above rests on.
  assert.deepEqual(splitCommandLine('node "C:\\a b\\x.js" --no-open'), ['node', 'C:\\a b\\x.js', '--no-open'])
  // `\"` is what `shell: true` produces for a nested quote; it is a literal, not
  // a delimiter, so the cmd.exe blob stays one token.
  const blob = splitCommandLine(SETTINGS_NAV)
  assert.equal(blob.length, 5)
  assert.equal(blob[4].startsWith('pnpm dsh web'), true)
})

test('--stale and --dry-run parse, and a bad --stale is refused', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, staleMinutes: 15, help: false })
  assert.equal(parseArgs(['--dry-run']).dryRun, true)
  assert.equal(parseArgs(['--stale', '30']).staleMinutes, 30)
  assert.equal(parseArgs(['--stale=2.5']).staleMinutes, 2.5)
  assert.equal(parseArgs(['--help']).help, true)
  assert.throws(() => parseArgs(['--stale']), /non-negative number of minutes/u)
  assert.throws(() => parseArgs(['--stale', 'soon']), /non-negative number of minutes/u)
  assert.throws(() => parseArgs(['--stale', '-1']), /non-negative number of minutes/u)
  assert.throws(() => parseArgs(['--wat']), /unknown argument/u)
})
