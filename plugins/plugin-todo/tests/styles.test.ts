/**
 * Guards for the stylesheet itself.
 *
 * Two failures have already cost this plugin a round each, and both are invisible to
 * `tsc` because the sheet is a template string:
 *
 * 1. A backtick inside a CSS comment ends the template early. What is left becomes
 *    JavaScript, and the build only complains when that remainder does not parse — the
 *    second time it parsed fine and shipped as a client bundle that threw on import.
 * 2. A component token read but never declared (`--dshTodo-s5` and friends) resolves to
 *    nothing, so the property silently falls back to a browser default. That is exactly
 *    how the day dialog lost its padding.
 *
 * @module @dsh-app/plugin-todo/tests/styles
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CSS } from '../src/client/styles.ts'

test('the stylesheet carries no template delimiter of its own', () => {
  assert.equal(CSS.includes('`'), false, 'a backtick inside the sheet ends the template early')
  assert.equal(CSS.includes('${'), false, 'an interpolation inside the sheet would be evaluated')
})

test('every block in the stylesheet is closed', () => {
  const open = (CSS.match(/\{/gu) ?? []).length
  const close = (CSS.match(/\}/gu) ?? []).length
  assert.equal(open, close, `${String(open)} opening braces against ${String(close)} closing`)
})

test('every component token a rule reads is declared in the token block', () => {
  const declared = new Set(
    [...CSS.matchAll(/--dshTodo-[a-z0-9-]+(?=\s*:)/gu)].map(match => match[0]),
  )
  const read = new Set(
    [...CSS.matchAll(/var\((--dshTodo-[a-z0-9-]+)/gu)].map(match => match[1] ?? ''),
  )
  const missing = [...read].filter(name => !declared.has(name)).sort()
  assert.deepEqual(missing, [], `undeclared: ${missing.join(', ')}`)
})
