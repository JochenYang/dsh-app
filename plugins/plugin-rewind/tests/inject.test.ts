/**
 * Tests for the client half's declared service dependencies.
 *
 * cordis answers a service property access ONLY when the service is named in the
 * plugin's `inject`; reading an undeclared one throws
 * `cannot get property "remote.commands" without inject`. That failure is
 * invisible to a type check and to a registration-only smoke test — the plugin
 * activates, the popup opens, and every pick then throws at click time. These
 * tests pin the declaration to the reads, so dropping one fails here.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(
  fileURLToPath(new URL('../src/client.ts', import.meta.url)),
  'utf8',
)

/** The declared inject list, as the module exports it. */
function declaredInject(): string[] {
  const match = source.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(match, 'inject export not found')
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test('remote is declared, because the command call path reads ctx.remote', () => {
  // `ctx.get('remote')` is the recall executor; without the declaration cordis
  // throws on the property read.
  assert.match(source, /ctx\.get\('remote'\)/)
  assert.ok(declaredInject().includes('remote'), `inject must name "remote": ${declaredInject().join(', ')}`)
})

test('the dotted sub-service is declared too, as the kernel names it', () => {
  // The error text names `remote.commands`, and the kernel's own ui-commands
  // declares both forms.
  assert.ok(declaredInject().includes('remote.commands'))
})

test('sessions is declared, because the projection lookup reads ctx.sessions', () => {
  assert.match(source, /ctx\.get\('sessions'\)/)
  assert.ok(declaredInject().includes('sessions'))
})

test('slots and locale stay declared', () => {
  const declared = declaredInject()
  assert.ok(declared.includes('slots'))
  assert.ok(declared.includes('locale'))
})

test('every ctx.get() service is covered by the declaration', () => {
  const reads = [...source.matchAll(/ctx\.get\('([^']+)'\)/g)].map((m) => m[1])
  const declared = new Set(declaredInject())
  for (const read of reads) {
    assert.ok(
      declared.has(read) || declared.has(read.split('.')[0]),
      `ctx.get('${read}') is not covered by inject: ${[...declared].join(', ')}`,
    )
  }
})

test('the composer face is read from uiSession, never from the raw binding', () => {
  // The two are different objects and the difference is invisible to every
  // other gate. `sessions.binding(id)` returns the raw Controller binding
  // (`session`, `eventSource`, no props); the composer's `inputActions` exists
  // only on the MATERIALIZED binding that `uiSession.materialize()` builds from
  // the `uiSession.provide` descriptors. Reading it off the raw one finds
  // nothing, the prefill silently does not happen, and the host's success
  // sentence about the composer becomes a lie — measured on a real machine as
  // "composer prefill skipped: the binding publishes no inputActions.setDraft".
  assert.ok(declaredInject().includes('uiSession'), 'inject must name "uiSession"')
  assert.match(source, /ctx\.get\('uiSession'\)/)
  assert.match(source, /uiSession\?\.bindingSource\?\.\(\{ sessionId, binding: owner \}\)/)
  // And the raw read must be gone: it is the read that silently returned
  // undefined instead of throwing.
  assert.doesNotMatch(source, /binding\.props\?\.inputActions/)
  assert.doesNotMatch(source, /binding\?\.props/)
})
