/**
 * The suite-drift gate's own contract.
 *
 * `scripts/check-suites-drift.mjs` exists because the suite roster is written
 * down five times and AGENTS.md requires all five to move in one commit. Two
 * things about a gate like this are worth asserting, and the rest is not:
 *
 *   1. every reader accepts the shape the five real sources are WRITTEN IN, and
 *      refuses — loudly — a shape it does not recognise. A reader that answers
 *      "no entries" for a file it cannot parse turns the whole gate into a green
 *      that measured nothing, which is the one failure a drift gate must not
 *      have. The fixtures below are the real shapes, reduced: an overlay with a
 *      second `- insert:` block for upstream rows and a nested config key called
 *      `name`, a workflow with four other `for … in …; do` loops;
 *   2. the verdict names the drifting plugin AND both sides — the copies that
 *      carry it and the copies that do not, each with `file:line`. A report that
 *      says "drift" without saying where is a report nobody can act on.
 *
 * Deliberately NOT asserted: the roster's contents. Pinning 18 names here would
 * make a plugin addition edit this file too, and a gate that gets edited
 * reflexively alongside the thing it checks stops being read. What IS asserted
 * against the real tree is the gate's own wiring: one case runs it here, and two
 * more run it over a THROWAWAY COPY of the five sources (`--root`) whose overlay
 * is rewritten into a shape the reader refuses. Those are the regression cover
 * for the exit-2 path itself — a unit test of `exitCodeFor` cannot see whether
 * `main` still asks it the right question.
 *
 * @module dsh-app/tests/suites-drift
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  compareRosters,
  dirNameOf,
  exitCodeFor,
  readBracketArray,
  readOverlayRoster,
  readReleaseLoop,
} from '../scripts/check-suites-drift.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE = path.join(ROOT, 'scripts', 'check-suites-drift.mjs')
const OVERLAY = path.join(ROOT, 'plugins', 'dsh-app.patch.yml')

/** The five roster copies, as relative paths the gate reads them by. */
const ROSTER_FILES = [
  'plugins/dsh-app.patch.yml',
  'scripts/kernel-line.mjs',
  'src/main/brand-suite.ts',
  'scripts/smoke-suite.mjs',
  '.github/workflows/release.yml',
]

/** A source as {@link compareRosters} takes it: ids, a path, entries with lines. */
const source = (id, file, declLine, tokens) => ({
  id,
  file,
  declLine,
  problem: null,
  entries: tokens.map(([token, line]) => ({ token, line })),
})

test('the overlay reader takes the suite rows and only those', () => {
  const overlay = [
    '# prose that names the - insert: row it explains',
    '- insert:',
    '    - id: brand',
    "      name: '@dsh-app/plugin-brand'",
    '',
    '    - id: swarm',
    "      name: '@dsh-app/plugin-swarm'",
    '      config:',
    '        # a nested config key that happens to be called name',
    '        name: not-a-package',
    '',
    '- id: web',
    '  config:',
    '    searchProvider: dsh-app',
    '',
    '- insert:',
    '    - id: schedule',
    "      name: '@deepseek-ai/dsh-schedule'",
    '',
  ].join('\n')

  const found = readOverlayRoster(overlay)
  assert.equal(found.problem, null)
  assert.deepEqual(found.entries, [
    { token: '@dsh-app/plugin-brand', line: 4 },
    { token: '@dsh-app/plugin-swarm', line: 7 },
  ])
  // The locator names the block the SUITE rows are in. The second `- insert:`
  // block (upstream schedule rows) is not it, and citing it would send a reader
  // to unrelated lines.
  assert.equal(found.declLine, 2)
})

test('the overlay reader refuses an overlay it cannot recognise', () => {
  // A block sequence instead of an `- insert:` row: every name is present, and
  // the reader must still say it read nothing rather than return an empty list.
  const rewritten = [
    'rows:',
    '  - id: brand',
    "    name: '@dsh-app/plugin-brand'",
    '',
  ].join('\n')
  const found = readOverlayRoster(rewritten)
  assert.equal(found.entries.length, 0)
  assert.match(String(found.problem), /insert/u)
})

test('the overlay reader refuses a row it can see but cannot read', () => {
  // Each of these keeps every row that the reader DOES read, so a reader that
  // simply skipped the odd shape would hand back a list that still agrees with
  // the other four copies — the green this whole check exists to prevent. The
  // refusal has to name the line, because the source's entries are dropped with
  // it.
  const prefix = [
    '- insert:',
    '    - id: brand',
    "      name: '@dsh-app/plugin-brand'",
  ]

  const inlineItem = readOverlayRoster([...prefix, "    - name: '@dsh-app/plugin-extra'", ''].join('\n'))
  assert.equal(inlineItem.entries.length, 0)
  assert.match(String(inlineItem.problem), /line 4/u)

  const flowMapping = readOverlayRoster([...prefix, "    - {id: extra, name: '@dsh-app/plugin-extra'}", ''].join('\n'))
  assert.equal(flowMapping.entries.length, 0)
  assert.match(String(flowMapping.problem), /line 4/u)

  const nextLine = readOverlayRoster([
    ...prefix,
    '    - id: extra',
    '      name:',
    "        '@dsh-app/plugin-extra'",
    '',
  ].join('\n'))
  assert.equal(nextLine.entries.length, 0)
  assert.match(String(nextLine.problem), /line 5/u)

  // YAML syntax standing where a name should be: the value the row means is not
  // on this line, and treating the indicator as the name would scope it out.
  for (const value of ["&suite '@dsh-app/plugin-extra'", '*suite', '|']) {
    const syntax = readOverlayRoster([...prefix, '    - id: extra', `      name: ${value}`, '        extra', ''].join('\n'))
    assert.equal(syntax.entries.length, 0, `${value} was read as a name`)
    assert.match(String(syntax.problem), /line 5/u, `${value} was not refused`)
  }

  // The one shape that must NOT be refused: a `config:` block's own `name:` key
  // sits deeper than the entry's fields, so it is neither read as an entry nor
  // counted as one that was missed. The accepted fixture above asserts the same
  // thing through the reader's own answer.
  const nestedConfig = readOverlayRoster([
    ...prefix,
    '    - id: extra',
    "      name: '@dsh-app/plugin-extra'",
    '      config:',
    '        name: not-a-package',
    '',
  ].join('\n'))
  assert.equal(nestedConfig.problem, null)
  assert.deepEqual(nestedConfig.entries.map((entry) => entry.token), [
    '@dsh-app/plugin-brand',
    '@dsh-app/plugin-extra',
  ])
})

test('the array reader takes quoted entries and refuses a missing marker', () => {
  const text = 'export const SUITE_DIRS = [\n  \'plugin-brand\',\n  \'plugin-effort\',\n]\n'
  const found = readBracketArray(text, 'export const SUITE_DIRS = [')
  assert.equal(found.problem, null)
  assert.deepEqual(found.entries, [
    { token: 'plugin-brand', line: 2 },
    { token: 'plugin-effort', line: 3 },
  ])
  assert.equal(found.declLine, 1)

  // A renamed declaration must not read as "this copy lists no plugins".
  const renamed = readBracketArray(text, 'const DIRS = [')
  assert.equal(renamed.entries.length, 0)
  assert.match(String(renamed.problem), /was not found/u)

  // Same for a declaration the reader can see but cannot finish reading.
  const unclosed = readBracketArray("const SUITE_DIRS = ['plugin-brand',\n", 'const SUITE_DIRS = [')
  assert.equal(unclosed.entries.length, 0)
  assert.match(String(unclosed.problem), /closing/u)

  const empty = readBracketArray('const SUITE_DIRS = []\n', 'const SUITE_DIRS = [')
  assert.equal(empty.entries.length, 0)
  assert.match(String(empty.problem), /no single-quoted entry/u)
})

test('the array reader refuses an entry in another quoting', () => {
  // A re-quoted item is still an item: reading past it would return one name
  // fewer than the file lists, in a list that can still agree with the others.
  const text = "const SUITE_DIRS = ['plugin-brand', \"plugin-effort\", `plugin-memory`]\n"
  const found = readBracketArray(text, 'const SUITE_DIRS = [')
  assert.equal(found.entries.length, 0)
  assert.match(String(found.problem), /line 1/u)
  assert.match(String(found.problem), /2 comma-separated piece/u)

  // A trailing comment is not a piece, and its comma is not a separator.
  const commented = readBracketArray([
    'const SUITE_DIRS = [',
    "  'plugin-brand', // brand, and the only one",
    "  'plugin-effort',",
    ']',
    '',
  ].join('\n'), 'const SUITE_DIRS = [')
  assert.equal(commented.problem, null)
  assert.deepEqual(commented.entries.map((entry) => [entry.token, entry.line]), [
    ['plugin-brand', 2],
    ['plugin-effort', 3],
  ])
})

test('the workflow reader finds the roster loop among the workflow\'s other loops', () => {
  const workflow = [
    'jobs:',
    '  runtime:',
    '    steps:',
    '      - run: |',
    '          for p in win32-x64 darwin-x64; do',
    '            echo $p',
    '          done',
    '          for p in plugin-brand plugin-effort; do',
    '            echo $p',
    '          done',
    '          for name in "dsh-runtime-x.tgz" "manifest-x.json"; do',
    '            echo $name',
    '          done',
    '',
  ].join('\n')

  const found = readReleaseLoop(workflow)
  assert.equal(found.problem, null)
  assert.deepEqual(found.entries, [
    { token: 'plugin-brand', line: 8 },
    { token: 'plugin-effort', line: 8 },
  ])
  assert.equal(found.declLine, 8)
})

test('the workflow reader refuses zero roster loops and two of them alike', () => {
  const none = readReleaseLoop('      - run: |\n          for p in win32-x64; do\n            echo $p\n          done\n')
  assert.equal(none.entries.length, 0)
  assert.match(String(none.problem), /no `for/u)

  // Two roster-shaped loops make "which list is the roster" undefined. Guessing
  // one is how a gate starts checking the wrong list forever.
  const two = [
    '          for p in plugin-brand; do',
    '            echo $p',
    '          done',
    '          for p in plugin-effort; do',
    '            echo $p',
    '          done',
    '',
  ].join('\n')
  const ambiguous = readReleaseLoop(two)
  assert.equal(ambiguous.entries.length, 0)
  assert.match(String(ambiguous.problem), /ambiguous/u)
})

test('a roster token normalizes to the directory name it means', () => {
  assert.equal(dirNameOf('@dsh-app/plugin-effort'), 'plugin-effort')
  assert.equal(dirNameOf('plugin-effort'), 'plugin-effort')
})

test('five agreeing copies are green', () => {
  const copies = ['overlay', 'kernel', 'brand', 'smoke', 'release'].map((id, index) => source(
    id,
    `${id}.txt`,
    index + 1,
    [['@dsh-app/plugin-brand', index + 2], ['@dsh-app/plugin-effort', index + 3]],
  ))
  const verdict = compareRosters(copies)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.drift, [])
  assert.deepEqual(verdict.names, ['plugin-brand', 'plugin-effort'])
})

test('a copy missing a name is red, and the finding names both sides', () => {
  const copies = [
    source('overlay', 'plugins/dsh-app.patch.yml', 104, [
      ['@dsh-app/plugin-brand', 105],
      ['@dsh-app/plugin-effort', 113],
    ]),
    source('kernel', 'scripts/kernel-line.mjs', 39, [
      ['@dsh-app/plugin-brand', 40],
      ['@dsh-app/plugin-rewind', 41],
      ['@dsh-app/plugin-effort', 42],
    ]),
  ]
  const verdict = compareRosters(copies)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.drift.length, 1)
  const [finding] = verdict.drift
  assert.equal(finding.kind, 'membership')
  assert.equal(finding.name, 'plugin-rewind')
  // The side that carries it: the entry's own line, in its own notation.
  assert.deepEqual(finding.present.map((hit) => [hit.source.id, hit.line, hit.token]), [
    ['kernel', 41, '@dsh-app/plugin-rewind'],
  ])
  // The side that does not: the declaration that should have held it.
  assert.deepEqual(finding.absent.map((copy) => [copy.id, copy.file, copy.declLine]), [
    ['overlay', 'plugins/dsh-app.patch.yml', 104],
  ])
})

test('a name listed twice by one copy is red, and is not mistaken for agreement', () => {
  const copies = [
    source('overlay', 'plugins/dsh-app.patch.yml', 104, [
      ['@dsh-app/plugin-brand', 105],
      ['@dsh-app/plugin-brand', 110],
      ['@dsh-app/plugin-effort', 113],
    ]),
    source('kernel', 'scripts/kernel-line.mjs', 39, [
      ['@dsh-app/plugin-brand', 40],
      ['@dsh-app/plugin-effort', 42],
    ]),
  ]
  const verdict = compareRosters(copies)
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.drift.map((finding) => finding.kind), ['duplicate'])
  assert.equal(verdict.drift[0].source.id, 'overlay')
  assert.equal(verdict.drift[0].name, 'plugin-brand')
})

test('a pure reorder is reported but not fatal', () => {
  // Order is reported so a reader sees it, and is not a failure because no
  // consumer of these lists reads the order — see the gate's module header.
  const copies = [
    source('overlay', 'plugins/dsh-app.patch.yml', 104, [
      ['@dsh-app/plugin-brand', 105],
      ['@dsh-app/plugin-effort', 113],
    ]),
    source('kernel', 'scripts/kernel-line.mjs', 39, [
      ['@dsh-app/plugin-effort', 40],
      ['@dsh-app/plugin-brand', 41],
    ]),
  ]
  const verdict = compareRosters(copies)
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.drift, [])
  assert.deepEqual(verdict.order.map((copy) => copy.id), ['kernel'])

  // ... and the note is withheld while membership already drifts: a copy that is
  // missing a name is trivially "in a different order", which is noise beside
  // the finding a reader actually has to act on.
  const withDrift = compareRosters([
    copies[0],
    source('kernel', 'scripts/kernel-line.mjs', 39, [
      ['@dsh-app/plugin-effort', 40],
      ['@dsh-app/plugin-brand', 41],
      ['@dsh-app/plugin-rewind', 42],
    ]),
  ])
  assert.equal(withDrift.ok, false)
  assert.deepEqual(withDrift.order, [])
})

test('an unreadable source is red even when the readable copies agree', () => {
  // The one answer a drift gate must never give: four copies agree, so it
  // reports agreement over a set it silently shrank. The unreadable case wins
  // over every other input, including `--check` being absent.
  assert.equal(exitCodeFor({ unreadable: true, ok: true, check: false }), 2)
  assert.equal(exitCodeFor({ unreadable: true, ok: true, check: true }), 2)
  assert.equal(exitCodeFor({ unreadable: true, ok: false, check: true }), 2)
})

test('drift is fatal only under --check', () => {
  assert.equal(exitCodeFor({ unreadable: false, ok: false, check: false }), 0)
  assert.equal(exitCodeFor({ unreadable: false, ok: false, check: true }), 1)
  assert.equal(exitCodeFor({ unreadable: false, ok: true, check: false }), 0)
  assert.equal(exitCodeFor({ unreadable: false, ok: true, check: true }), 0)
})

/** Run the gate, returning `{ status, stdout, stderr }`. */
function gate(...args) {
  const result = spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('the gate is green against this tree, and reads all five copies', () => {
  const result = gate('--check')
  assert.equal(result.status, 0, `the repository's five roster copies disagree:\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /no drift/u)
  // A gate that read nothing would also be green. Every copy has to have been
  // read, and each one has to have yielded entries.
  for (const id of ['overlay', 'kernel', 'brand', 'smoke', 'release']) {
    assert.match(result.stdout, new RegExp(`^\\s+${id}\\b`, 'mu'), `${id} was not in the report`)
  }
  assert.doesNotMatch(result.stdout, /^\s+\S+\s+\S+\s+--/mu, 'a copy could not be read')
})

test('an unknown argument is a usage error, not a clean bill', () => {
  const result = gate('--check', '--repo', 'elsewhere')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage:/u)
})

test('--root is missing its directory, which is a usage error too', () => {
  const result = gate('--check', '--root')
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--root needs the directory/u)
})

/**
 * A throwaway copy of the five sources, with the overlay replaced by `overlay`,
 * for the CLI cases below. `--root` moves only WHERE the four text copies are
 * read from — `SUITE_PLUGINS` still comes from the module imported here — so a
 * copy of the tree is enough to drive every branch of `main`.
 */
function fixtureTree(overlay = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-suites-drift-'))
  for (const file of ROSTER_FILES) {
    const target = path.join(dir, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(path.join(ROOT, file), 'utf8'))
  }
  if (overlay !== null) writeFileSync(path.join(dir, ROSTER_FILES[0]), overlay)
  return dir
}

/**
 * The overlay with `row` spliced into its insert block in a shape the reader
 * refuses — and every row it DOES read left exactly as it was.
 *
 * The two rows the tests below splice differ in what a reader that shrugged at
 * the shape would do: a duplicate of an existing row still leaves the copies
 * agreeing on the SET (a refused source yields no entries, so the other four
 * copies' names all read as absent — noise, not agreement), while a row naming a
 * package no other copy carries would be read as nothing at all and reported as
 * agreement. The second is the silent "read less" this check exists to stop.
 */
function overlayWithInlineRow(row) {
  const lines = readFileSync(OVERLAY, 'utf8').split(/\r?\n/u)
  const at = lines.indexOf('    - id: effort')
  assert.notEqual(at, -1, 'the overlay no longer writes the row this fixture rewrites')
  lines.splice(at, 0, row)
  return lines.join('\n')
}

/**
 * A row the other four copies ALREADY name, in a shape the reader cannot read:
 * the copies still agree on the set, so a wrong answer here would be a
 * membership report about a roster that never moved.
 */
const INLINE_DUPLICATE_ROW = "    - name: '@dsh-app/plugin-effort'"

/**
 * A row NO other copy names, in the same unreadable shape. A reader that
 * shrugged at the shape would read eighteen rows, agree with the other four and
 * exit 0 — silence about a row that exists.
 */
const INLINE_NEW_ROW = "    - name: '@dsh-app/plugin-extra'"

test('a copy the reader refuses is exit 2 at the CLI, not a report of drift', async (t) => {
  const clean = fixtureTree()
  const rewritten = fixtureTree(overlayWithInlineRow(INLINE_DUPLICATE_ROW))
  // Cleaned with the ASYNC `rm`, as `recursive-delete-guard.test.mjs` requires of
  // any delete that could meet a link: this file then adds no sync recursive
  // delete, and that audit's count stays where it was.
  t.after(async () => {
    await rm(clean, { recursive: true, force: true })
    await rm(rewritten, { recursive: true, force: true })
  })

  // The fixture itself is faithful: without the rewrite the same command is
  // green, so the case below cannot pass by refusing everything.
  const okay = gate('--check', '--root', clean)
  assert.equal(okay.status, 0, okay.stdout + okay.stderr)
  assert.match(okay.stdout, /no drift/u)

  const refused = gate('--check', '--root', rewritten)
  assert.equal(refused.status, 2, `expected the refused overlay to exit 2:\n${refused.stdout}${refused.stderr}`)
  assert.match(refused.stderr, /1 of the 5 copies could not be read/u)
  assert.match(refused.stderr, /overlay \(plugins\/dsh-app\.patch\.yml\) —/u)
  assert.match(refused.stderr, /does not accept/u)
  // ... and the report does not then contradict itself: a refused copy yields no
  // names, so eighteen membership findings would be printed beside the sentence
  // saying it was never read. Without the exit-2 branch that noise IS the
  // report, and `--check` exits 1 — a verdict about the roster where the true
  // answer is about the reader.
  assert.doesNotMatch(refused.stdout, /\[drift\]/u)
  assert.doesNotMatch(refused.stdout, /absent/u)
})

test('a row added in a shape the reader cannot read is refused, never silence', async (t) => {
  // The case that motivated the completeness assertion: the row names a package
  // no other copy carries, so a reader that read past it would return the same
  // eighteen names as the other four, agree, and exit 0 with an overlay that has
  // nineteen rows. This is the F1 counter-proof at the CLI, not the reader's.
  const dir = fixtureTree(overlayWithInlineRow(INLINE_NEW_ROW))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const refused = gate('--check', '--root', dir)
  assert.equal(refused.status, 2, `expected the added row to be refused:\n${refused.stdout}${refused.stderr}`)
  assert.match(refused.stderr, /plugin-extra/u)
  assert.match(refused.stderr, /does not accept/u)
  assert.doesNotMatch(refused.stdout, /no drift/u)
})

test('--json reports the same refusal, and no drift beside it', async (t) => {
  const dir = fixtureTree(overlayWithInlineRow(INLINE_DUPLICATE_ROW))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })

  const result = gate('--json', '--root', dir)
  assert.equal(result.status, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.unreadable.length, 1)
  assert.match(report.unreadable[0], /^overlay \(plugins\/dsh-app\.patch\.yml\):/u)
  // The copy was not read, so its entries are zero and its membership is not a
  // fact — the drift list must not be computed from it.
  assert.deepEqual(report.drift, [])
  assert.equal(report.sources.find((source) => source.id === 'overlay').entries, 0)
  assert.ok(report.sources.every((source) => source.id !== 'overlay' || source.problem !== null))
})
