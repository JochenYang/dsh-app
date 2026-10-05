/**
 * The slot registration check's contract.
 *
 * `scripts/check-slot-registrations.mjs` answers a question no other gate asks,
 * and one the type system cannot: does every seat our client halves register into
 * still EXIST in the followed kernel line?
 *
 * The kernel's slot system fails in two ways, and neither is visible to the
 * compile gate or to a request-level smoke:
 *
 *   - a slot id no `SlotMap` declares throws at registration;
 *   - a slot id that used to be declared and no longer is does NOTHING — no
 *     error, no log, no render. The surface is simply absent.
 *
 * So this file pins four things:
 *
 *   1. the checker resolves the seats we actually register into. Today every one
 *      resolves; if a line move retires a seat, this is where it surfaces.
 *   2. a declaration must be INSIDE an `interface SlotMap { … }` block. An
 *      earlier version scanned the whole file once it mentioned `SlotMap`, and
 *      the same id also appears in a `children: { … }` table and in several
 *      `ctx.slots.*(…)` calls — so deleting the declaration left those behind and
 *      the check became unfalsifiable. The mutation below is exactly that case.
 *   3. a seat declared by one of OUR OWN plugins counts. `plugin-client-ui`
 *      declares `settings.dsh-app-maintenance.tab` in its own `declare module`
 *      merge and `plugin-presets` registers into it; reading only the installed
 *      packages reported both registrations as undeclared.
 *   4. the mutation discipline: a registration into an undeclared id must fail
 *      the check, and removing a declaration from EVERY place it appears must
 *      fail it too. Both are exercised against a throwaway tree, so the working
 *      tree is never modified.
 *
 * Deliberately NOT asserted: the total number of declared slots. That grows with
 * the kernel and is not a fact about us.
 *
 * @module dsh-app/tests/slot-registrations
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { removeTree } from '../scripts/lib/remove-tree.mjs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Every fixture teardown goes through `removeTree`.
 *
 * The fixture copies `node_modules/@deepseek-ai` with `dereference: false`, so it
 * can hold a link into the repository's own tree. A sync recursive delete
 * descends THROUGH such a link instead of unlinking it — the rule
 * `test/recursive-delete-guard.test.mjs` audits, and the reason the audit count
 * moved when this file first used `rmSync`.
 */
const cleanup = (dir) => removeTree(dir).catch(() => undefined)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = join(ROOT, 'scripts', 'check-slot-registrations.mjs')

/** Run the checker against a repository root; returns status and both streams. */
function check(repoRoot = ROOT) {
  const result = spawnSync(process.execPath, [CHECKER, '--json', '--repo', repoRoot], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * A throwaway copy of the pieces the checker reads: our plugin sources and the
 * installed declarations. Copying only those keeps the fixture small while
 * preserving the two resolution roots the checker uses.
 *
 * `node_modules` is copied because the declared-slot side comes from the
 * installed packages; on a machine where it is absent the checker exits 2, and
 * the test would fail for a reason unrelated to the check.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slots-fixture-'))
  mkdirSync(join(dir, 'plugins'), { recursive: true })
  cpSync(join(ROOT, 'plugins', 'plugin-client-ui'), join(dir, 'plugins', 'plugin-client-ui'), { recursive: true })
  cpSync(join(ROOT, 'plugins', 'plugin-presets'), join(dir, 'plugins', 'plugin-presets'), { recursive: true })
  cpSync(join(ROOT, 'plugins', 'plugin-sidebar'), join(dir, 'plugins', 'plugin-sidebar'), { recursive: true })
  cpSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(dir, 'node_modules', '@deepseek-ai'), { recursive: true, dereference: false })
  return dir
}

const CLIENT_UI = join('plugins', 'plugin-client-ui', 'src', 'client.ts')
const PRESETS = join('plugins', 'plugin-presets', 'src', 'client.ts')
const VIEWS = join('plugins', 'plugin-sidebar', 'src', 'client', 'views.tsx')

/**
 * The declaration pattern, CRLF-tolerant on purpose: the working tree checks out
 * with `\r\n` and a pattern built on `\n` silently matches nothing.
 */
const DECLARATION = /^[ \t]*'settings\.dsh-app-maintenance\.tab':[ \t]*\{[\s\S]*?\r?\n[ \t]*\}[ \t]*\r?\n/m

test('every registration resolves against the followed line', () => {
  const { status, stdout } = check()
  const report = JSON.parse(stdout)

  assert.ok(report.declaredSlotCount > 20, `only ${String(report.declaredSlotCount)} slots were discovered, which cannot be the whole surface`)
  assert.ok(report.registrations > 5, `only ${String(report.registrations)} registrations were found in our client halves`)

  assert.deepEqual(
    report.undeclared,
    [],
    'a client half registers into a seat the followed line does not declare — an undeclared slot throws, a retired one silently renders nothing',
  )
  assert.equal(status, 0)
})

test('a registration into an undeclared seat fails the check', async () => {
  const dir = fixture()
  try {
    const file = join(dir, VIEWS)
    const original = readFileSync(file, 'utf8')
    const mutated = original.replace("ctx.slots.inject('conversation.view'", "ctx.slots.inject('conversation.viewRETIRED'")
    assert.notEqual(mutated, original, 'the fixture no longer contains the registration this mutation targets')
    writeFileSync(file, mutated)

    const { status, stdout } = check(dir)
    assert.equal(status, 1, 'a registration into an undeclared slot must fail')
    assert.ok(JSON.parse(stdout).undeclared.some((row) => row.id === 'conversation.viewRETIRED'))
  } finally {
    await cleanup(dir)
  }
})

test('removing a declaration we own fails the check', async () => {
  const dir = fixture()
  try {
    // The id is declared in BOTH files; removing it from one leaves the other,
    // so a mutation that only touches one file proves nothing.
    for (const relative of [CLIENT_UI, PRESETS]) {
      const file = join(dir, relative)
      const original = readFileSync(file, 'utf8')
      const mutated = original.replace(DECLARATION, '')
      assert.notEqual(mutated, original, `the fixture no longer declares the seat in ${relative}`)
      writeFileSync(file, mutated)
    }

    const { status, stdout, stderr } = check(dir)
    assert.equal(status, 1, `removing every declaration must fail the check (stdout=${stdout.slice(0, 200)} stderr=${stderr.slice(0, 200)})`)
    assert.ok(
      JSON.parse(stdout).undeclared.some((row) => row.id === 'settings.dsh-app-maintenance.tab'),
      'the removed seat must be reported as undeclared',
    )
  } finally {
    await cleanup(dir)
  }
})

test('a declaration is only a declaration inside an interface SlotMap block', async () => {
  // The regression this pins: the id also appears in a `children: { … }` table
  // and in several `ctx.slots.*(…)` calls. A checker that scans the whole file
  // keeps finding those and never notices the declaration is gone.
  const dir = fixture()
  try {
    for (const relative of [CLIENT_UI, PRESETS]) {
      const file = join(dir, relative)
      writeFileSync(file, readFileSync(file, 'utf8').replace(DECLARATION, ''))
    }
    // Put the id back OUTSIDE any SlotMap block, in the same file, in the shape
    // that fooled the earlier version.
    const file = join(dir, CLIENT_UI)
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nconst notADeclaration = { 'settings.dsh-app-maintenance.tab': { kind: 'list' } }\n`)

    const { status } = check(dir)
    assert.equal(status, 1, 'a mention outside a SlotMap block must NOT count as a declaration')
  } finally {
    await cleanup(dir)
  }
})

test('an unknown flag exits 2 rather than reporting', () => {
  const result = spawnSync(process.execPath, [CHECKER, '--bogus'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
})

test('a tree with no installed line exits 2, not 0', async () => {
  // The regression this pins: against a tree with no `node_modules/@deepseek-ai`
  // the checker reported "0 slots declared, 0 registrations" and exited 0 — a
  // silent pass that is indistinguishable from success, in the one state where
  // the check has nothing to compare against.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-slots-empty-'))
  try {
    mkdirSync(join(dir, 'plugins'), { recursive: true })
    const result = spawnSync(process.execPath, [CHECKER, '--repo', dir], { encoding: 'utf8' })
    assert.equal(result.status, 2, 'an absent installed line must be a usage error, not a clean bill')
    assert.match(result.stderr ?? '', /install the followed line first/)
  } finally {
    await cleanup(dir)
  }
})
