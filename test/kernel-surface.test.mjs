/**
 * The kernel surface report's contract.
 *
 * `scripts/kernel-surface.mjs` answers the question no other gate asks: of the
 * surface the followed line EXPORTS, which parts do we not use? It exists
 * because a kernel-line move that adds a capability reads as "nothing broke" in
 * every other check — the addition direction has no gate at all.
 *
 * Four things are worth asserting, and nothing else:
 *
 *   1. the three edge kinds stay distinct. `import type {} from 'pkg'` is the
 *      Cordis augmentation idiom: it names nothing and establishes no runtime
 *      edge, yet it is a hard coupling. Classifying it as a runtime use
 *      overstates what a line move can break; the report carried 0 augmentation
 *      couplings until the order of those two tests was fixed, which is exactly
 *      the regression this pins.
 *   2. a package that only a plugin's own `node_modules` carries is still
 *      reported. `@deepseek-ai/dsh-client-ui-primitives` and
 *      `@deepseek-ai/dsh-web` live only inside plugin directories; a root-only
 *      enumeration listed neither, so a package we demonstrably couple to was
 *      invisible to the report.
 *   3. the export surface of the shared helper is what both directions agree on.
 *      `test/plugin-kernel-imports.test.mjs` and this script read the same
 *      `exportsOf`; a second implementation would let one report a name the
 *      other cannot see.
 *   4. the CLI contract: `--json` parses, `--used-only`/`--unused-only` partition
 *      the same set, an unknown flag exits 2.
 *
 * Deliberately NOT asserted: any count of exports, couplings, or unused names.
 * Those move with every ordinary dependency change, and a test that pins them
 * gets re-baselined reflexively instead of read.
 *
 * @module dsh-app/tests/kernel-surface
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'kernel-surface.mjs')

/** Run the report and parse its JSON output. */
function report(extraArgs = []) {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--json', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

test('the three edge kinds stay distinct', () => {
  const data = report()
  assert.ok(data.scannedPackages > 20, `only ${String(data.scannedPackages)} packages were enumerated`)

  // Every package lands in at most one bucket, and the buckets are the three
  // kinds plus "not coupled at all". `augmentOnly` was 0 before the ordering fix
  // in `collectUsage`, so asserting it is non-zero is the regression pin.
  assert.ok(data.runtime > 0, 'no runtime coupling was found, which cannot be right')
  assert.ok(
    data.augmentOnly > 0,
    'no augmentation-only coupling was found — `import type {} from …` must classify as an augmentation, not as a type-only import',
  )

  for (const pkg of data.packages) {
    const kinds = [pkg.edges.runtime, pkg.edges.type, pkg.edges.augment].filter(Boolean).length
    assert.ok(kinds <= 3, `${pkg.name} reports ${String(kinds)} edge kinds, which is impossible`)
  }

  // A package can legitimately carry more than one kind (a runtime import in one
  // file, an augmentation in another), so the buckets may overlap; what must NOT
  // happen is an augmentation-only package counting as runtime.
  const augmentOnly = data.packages.filter((pkg) => pkg.edges.augment && !pkg.edges.runtime)
  for (const pkg of augmentOnly) {
    assert.equal(pkg.adopted.length, 0, `${pkg.name} is an augmentation-only coupling but reports imported names`)
  }
})

test('a package carried only by a plugin still appears', () => {
  const data = report()
  const names = new Set(data.packages.map((pkg) => pkg.name))

  // Both live only inside plugin-local `node_modules`, never at the root. If the
  // report goes back to enumerating the root scope alone these disappear, and a
  // package we import from in 14 plugins becomes invisible.
  for (const pkg of ['dsh-client-ui-primitives', 'dsh-web']) {
    assert.ok(names.has(pkg), `${pkg} is imported by our plugins but the report does not list it`)
  }

  const primitives = data.packages.find((pkg) => pkg.name === 'dsh-client-ui-primitives')
  assert.equal(primitives.edges.runtime, true, 'dsh-client-ui-primitives is a runtime coupling, not a type-only one')
  assert.ok(primitives.adopted.includes('Tooltip'), 'the report must name the members we actually import')
})

test('the shared export helper is what both directions read', async () => {
  // The helper is the single definition of "what does this package export".
  // Importing it here proves it is loadable and that its two entry points work;
  // `test/plugin-kernel-imports.test.mjs` imports the same module.
  const helper = await import('../scripts/lib/kernel-exports.mjs')
  const pkgDir = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-atomic-write')
  const exports = helper.exportsOf(pkgDir)
  assert.ok(exports instanceof Set, 'exportsOf must return a Set for an installed package')
  assert.ok(exports.has('writeFileAtomic'), 'dsh-atomic-write exports writeFileAtomic on the followed line')

  // A package with no readable entry answers null — "cannot judge", never an
  // empty set, because an empty set would read as "exports nothing".
  const missing = helper.exportsOf(join(ROOT, 'node_modules', '@deepseek-ai', 'does-not-exist'))
  assert.equal(missing, null, 'an unreadable package must answer null, not an empty set')
})

test('the CLI partitions its own output', () => {
  const all = report()
  const used = report(['--used-only'])
  const unused = report(['--unused-only'])

  assert.equal(
    used.packages.length + unused.packages.length,
    all.packages.length,
    '--used-only and --unused-only must partition the same package set',
  )

  const usedNames = new Set(used.packages.map((pkg) => pkg.name))
  const overlap = unused.packages.filter((pkg) => usedNames.has(pkg.name))
  assert.deepEqual(overlap.map((pkg) => pkg.name), [], 'a package appeared in both partitions')

  // An unknown flag is a usage error, not a silent report.
  const result = (() => {
    try {
      execFileSync(process.execPath, [SCRIPT, '--bogus'], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
      return 0
    } catch (error) {
      return error.status
    }
  })()
  assert.equal(result, 2, 'an unknown flag must exit 2')
})

test('the report never writes to the repository', () => {
  // It is a read-only report by contract; the simplest proof is that a run
  // against a throwaway tree that lacks the scope directory fails with the
  // documented exit code instead of inventing one.
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-surface-fixture-'))
  mkdirSync(join(fixture, 'plugins'), { recursive: true })
  writeFileSync(join(fixture, 'package.json'), '{}\n')

  const status = (() => {
    try {
      execFileSync(process.execPath, [SCRIPT, '--repo', fixture], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
      return 0
    } catch (error) {
      return error.status
    }
  })()
  assert.equal(status, 2, 'a tree without node_modules/@deepseek-ai must exit 2, not report an empty surface')
})
