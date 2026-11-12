/**
 * Key resolution: which stored entries become request credentials, and which
 * ones the page has to explain.
 *
 * The environment is passed in, so every case here is a real input rather than
 * a process-wide side effect.
 *
 * @module plugin-websearch/tests/keys
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveKeys, unresolvedKeyCount, type EnvLookup } from '../src/keys.ts'

/** An environment built from a plain object. */
const env = (values: Readonly<Record<string, string>>): EnvLookup => name => values[name]

describe('resolveKeys', () => {
  it('keeps literals in order and drops duplicates', () => {
    // Two equal keys would spend two attempts on one rejection.
    assert.deepEqual(resolveKeys({ id: 'exa', enabled: true, priority: 0, apiKeys: ['a', 'b', 'a'] }, env({})), ['a', 'b'])
  })

  it('reads $ENV:NAME at call time', () => {
    const entry = { id: 'exa', enabled: true, priority: 0, apiKeys: ['$ENV:EXA_KEY'] } as const
    assert.deepEqual(resolveKeys(entry, env({ EXA_KEY: 'sk-from-env' })), ['sk-from-env'])
  })

  it('drops a reference whose variable is unset or empty', () => {
    // Dropping is the only honest option: an empty credential would be sent as
    // a header and rejected as 401 with no explanation.
    const entry = { id: 'exa', enabled: true, priority: 0, apiKeys: ['$ENV:MISSING', '$ENV:EMPTY', 'sk-literal'] } as const
    assert.deepEqual(resolveKeys(entry, env({ EMPTY: '' })), ['sk-literal'])
  })

  it('answers an empty list when nothing is configured', () => {
    assert.deepEqual(resolveKeys({ id: 'exa', enabled: true, priority: 0 }, env({})), [])
  })
})

describe('unresolvedKeyCount', () => {
  it('counts nothing for a literal list', () => {
    assert.equal(unresolvedKeyCount({ id: 'exa', enabled: true, priority: 0, apiKeys: ['a', 'b'] }, env({})), 0)
  })

  it('counts each unset reference', () => {
    const entry = { id: 'exa', enabled: true, priority: 0, apiKeys: ['$ENV:ONE', '$ENV:TWO', 'sk-literal'] } as const
    assert.equal(unresolvedKeyCount(entry, env({ ONE: 'x' })), 1)
    assert.equal(unresolvedKeyCount(entry, env({})), 2)
  })

  it('does not blame a variable that IS set, even when two references collapse', () => {
    // `resolveKeys` dedupes by VALUE, so a stored-minus-resolved subtraction
    // would report one unresolved reference here and tell the user their
    // variable is unset when it is set.
    const entry = { id: 'exa', enabled: true, priority: 0, apiKeys: ['$ENV:A', '$ENV:B'] } as const
    assert.deepEqual(resolveKeys(entry, env({ A: 'same', B: 'same' })), ['same'])
    assert.equal(unresolvedKeyCount(entry, env({ A: 'same', B: 'same' })), 0)
  })

  it('counts a variable set to the empty string', () => {
    const entry = { id: 'exa', enabled: true, priority: 0, apiKeys: ['$ENV:EMPTY'] } as const
    assert.equal(unresolvedKeyCount(entry, env({ EMPTY: '' })), 1)
  })
})
