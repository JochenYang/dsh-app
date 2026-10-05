/**
 * The touchpoint scan's own contract.
 *
 * `scripts/check-touchpoints.mjs` is the executable half of
 * `docs/agents/kernel-line-regression.md` §1, and its report is what a
 * kernel-line move is planned from. That makes three things worth asserting
 * here, and nothing else:
 *
 *   1. the pattern table stays loadable and its classes stay exactly the seven
 *      the document defines — a class silently dropped from the table would
 *      shrink the scan without shrinking the doc;
 *   2. every class still matches THIS tree. The scan is heuristic, so an empty
 *      class is not proof that a surface is unused — it means the patterns have
 *      drifted away from the code, and the report would read as "nothing to see
 *      here" for a surface we demonstrably do use. This is the one failure the
 *      scanner can diagnose about itself, and it is asserted here rather than
 *      left to a human noticing a `none` in the output;
 *   3. a comment that NAMES a touchpoint is not a use of one — in a `.ts` file
 *      and in a `.yml` one. The composition overlay is mostly prose explaining
 *      its rows, so before the YAML pass existed 10 of its 38 hits were the
 *      explanation rather than the row.
 *
 * Deliberately NOT asserted: any hit count, or any specific location. Those move
 * with every ordinary code change, and a test that pins them gets edited
 * reflexively instead of read — which is how a scan stops meaning anything.
 *
 * @module dsh-app/tests/touchpoints
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCANNER = join(ROOT, 'scripts', 'check-touchpoints.mjs')
const PATTERNS = join(ROOT, 'scripts', 'touchpoint-patterns.json')

/** Run the scanner against a repository root and parse its JSON report. */
function scan(repoRoot = ROOT) {
  const stdout = execFileSync(process.execPath, [SCANNER, '--json', '--repo', repoRoot], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/** Total hits in a report, across every class. */
const totalHits = (report) => report.classes.reduce((sum, klass) => sum + klass.hits, 0)

test('the pattern table carries exactly the seven documented classes', () => {
  const table = JSON.parse(readFileSync(PATTERNS, 'utf8'))
  assert.equal(table.schema, 1)
  assert.equal(table.scope, 'heuristic', 'the table must stay declared as heuristic: a scan is not a verdict')

  // The ids and slugs the document's §1 table names. A rename here without the
  // doc moving with it is the drift this assertion exists to catch.
  const expected = [
    [1, 'composition-rows'],
    [2, 'session-events'],
    [3, 'services-and-remote'],
    [4, 'host-paths'],
    [5, 'client-registration'],
    [6, 'custom-channels'],
    [7, 'subprocess'],
  ]
  assert.deepEqual(table.classes.map((klass) => [klass.id, klass.slug]), expected)

  for (const klass of table.classes) {
    assert.ok(Array.isArray(klass.patterns) && klass.patterns.length > 0, `class ${klass.id} has no patterns`)
    assert.equal(typeof klass.why, 'string', `class ${klass.id} does not say why it matters`)
    for (const pattern of klass.patterns) {
      // A pattern that does not compile would throw inside the scanner; catching
      // it here names the offending entry instead of failing the whole run.
      assert.doesNotThrow(() => new RegExp(pattern, 'u'), `class ${klass.id} pattern ${JSON.stringify(pattern)} does not compile`)
    }
  }
})

test('every touchpoint class still matches this tree', () => {
  const report = scan()
  assert.ok(report.scannedFiles > 100, `the scan only saw ${String(report.scannedFiles)} files, which cannot be the whole repository`)

  const empty = report.classes.filter((klass) => klass.hits === 0)
  assert.deepEqual(
    empty.map((klass) => `${klass.id}:${klass.slug}`),
    [],
    'these classes matched nothing — the patterns have drifted away from the code, so the report would read as "no surface here" for a surface we use',
  )
})

test('a comment naming a touchpoint is not a use of one', () => {
  // A throwaway tree whose every mention of a pattern sits inside a comment.
  // Scanning it must report zero hits; if it does not, the scanner is reading
  // prose and the real report is inflated by every explanatory comment in the
  // overlay. The strings below are the shapes that actually produced false
  // positives: a JS line comment naming a service key, and a YAML full-line
  // comment naming the composition file.
  const fixture = mkdtempSync(join(tmpdir(), 'dsh-touchpoint-fixture-'))
  mkdirSync(join(fixture, 'src'), { recursive: true })
  writeFileSync(join(fixture, 'src', 'commented.ts'), [
    "// ctx.get('profileContext') reads the profile name — this is prose, not a call",
    '/* inject: [\'sessions\'] in a block comment is still prose */',
    'export const nothing = 1',
    '',
  ].join('\n'))
  writeFileSync(join(fixture, 'cordis.patch.yml'), [
    '# these rows join the composed tree; see cordis.patch.yml for the sibling layer',
    '# - id: probe',
    'rows: []',
    '',
  ].join('\n'))

  const report = scan(fixture)
  assert.equal(
    totalHits(report),
    0,
    `a comment-only tree reported ${String(totalHits(report))} hit(s): ${JSON.stringify(report.classes.filter((klass) => klass.hits > 0))}`,
  )
})
