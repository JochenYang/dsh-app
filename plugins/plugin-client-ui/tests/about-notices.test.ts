// The About page's success notices are feedback, not state: every one of them
// must self-clear, because the shipped page let the action rows' "started" and
// the log row's "opened" confirmations stay on screen until the page unmounted
// — a notice that never leaves reads as a stuck state. Failures and unsupported
// states are the opposite: they persist until the next attempt replaces them.
//
// Source-scan, the same shape as plugin-rewind's primitive assertions: the
// render sites and the self-clear wiring live in one module, so the guard reads
// that module. It pins the INVARIANT (every success notice is wired to a clear
// guarded by its own done flag, and a timer with cleanup exists), not the
// spelling: whitespace is normalized, the hold may be any positive literal, and
// the hook may move or be renamed as long as the wiring keeps its done guard.
//
// Run through the plugin's own suite: npm test (scripts/test.mjs).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const raw = readFileSync(fileURLToPath(new URL('../src/client/about/section.tsx', import.meta.url)), 'utf8')
/** Whitespace-normalized: formatting and line breaks are not the contract. */
const source = raw.replace(/\s+/g, ' ')

test('every success notice on the About page is wired to a self-clear', () => {
  const sites = [
    "actions['check-app-update'].kind === 'done'",
    "actions['check-kernel-update'].kind === 'done'",
    "actions['restart-server'].kind === 'done'",
    "open.kind === 'done'",
    "copy === 'done'",
  ]
  for (const site of sites) {
    assert.ok(source.includes(`useSelfClearingNotice(${site},`), `the notice for ${site} must self-clear`)
  }
})

test('every self-clear wiring is guarded by a done flag, never a wider state', () => {
  // The first argument of each call must be a `=== 'done'` comparison: a wider
  // guard (e.g. `!== 'idle'`) would clear failures and unsupported states too,
  // which is the regression this test exists to catch.
  const calls = [...source.matchAll(/(?<!function )useSelfClearingNotice\(\s*([^,]+),/g)]
  assert.ok(calls.length >= 5, 'the five success notices must each carry a wiring')
  for (const call of calls) {
    assert.match(call[1].trim(), /=== 'done'$/, `wiring ${call[1]} must guard on done alone`)
  }
})

test('the self-clear is a timer with cleanup, held for a positive window', () => {
  assert.match(source, /const NOTICE_TIMEOUT_MS = \d[\d_]*/)
  const hold = Number(/const NOTICE_TIMEOUT_MS = (\d[\d_]*)/.exec(source)?.[1].replace(/_/g, ''))
  assert.ok(hold > 0, 'the hold must be a positive duration')
  assert.match(source, /setTimeout\(clear, NOTICE_TIMEOUT_MS\)/)
  assert.match(source, /clearTimeout\(timer\)/)
})

test('failures and unsupported states stay on screen', () => {
  // The persistent render sites: a failure names what broke and the user still
  // has to act on it, so no timer may clear these.
  for (const site of ["state.kind === 'failed'", "open.kind === 'failed'", "copy === 'failed'", "state.kind === 'unsupported'", "open.kind === 'unsupported'"]) {
    assert.ok(source.includes(site), `the persistent notice ${site} must keep rendering`)
  }
})