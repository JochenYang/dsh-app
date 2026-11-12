/**
 * The masking boundary: what the client may see, and what a save means.
 *
 * These cases exist because the page shows ONE REMOVABLE CHIP PER KEY. The
 * earlier design collapsed a whole list into one placeholder, and the design
 * before this one reconstructed it positionally — which silently deletes the
 * wrong key as soon as the chips are not a prefix of the stored list. Every
 * case below is a user action that would be wrong under positional expansion.
 *
 * @module plugin-websearch/tests/keymask
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { keyRefOf, maskEngines, unmaskEngines } from '../src/keymask.ts'
import { isStoredKeyToken, WebSearchValidationError, type EngineEntry } from '../src/wire.ts'

/** A stored `exa` row with the given key list. */
const stored = (apiKeys: string[]): EngineEntry => ({ id: 'exa', enabled: true, priority: 0, apiKeys })

/** The placeholders of one masked row, in order. */
function placeholders(entry: { readonly apiKeys?: readonly string[] }): string[] {
  return [...entry.apiKeys ?? []]
}

/** Round-trip one client payload through the store, returning what would be saved. */
function roundTrip(clientKeys: string[], existing: EngineEntry[]): string[] {
  const merged = unmaskEngines([{ id: 'exa', apiKeys: clientKeys }], existing) as { apiKeys: string[] }[]
  return merged[0].apiKeys
}

describe('maskEngines', () => {
  it('gives each literal key its own placeholder and keeps $ENV references readable', () => {
    const [masked] = maskEngines([stored(['sk-one', '$ENV:EXA_KEY', 'sk-two'])])
    const keys = placeholders(masked)
    assert.equal(keys.length, 3)
    assert.ok(isStoredKeyToken(keys[0]), 'a literal becomes a placeholder')
    assert.equal(keys[1], '$ENV:EXA_KEY', 'a reference is not a secret and stays readable')
    assert.ok(isStoredKeyToken(keys[2]))
    assert.notEqual(keys[0], keys[2], 'different values get different references')
  })

  it('leaks no fragment of the value', () => {
    const [masked] = maskEngines([stored(['sk-super-secret-value'])])
    const serialized = JSON.stringify(masked)
    assert.equal(serialized.includes('super'), false)
    assert.equal(serialized.includes('secret'), false)
  })

  it('keeps the same reference for the same value, and drops the field when empty', () => {
    const [once] = maskEngines([stored(['sk-same'])])
    const [twice] = maskEngines([stored(['sk-same'])])
    assert.deepEqual(once.apiKeys, twice.apiKeys)
    assert.equal(maskEngines([{ id: 'exa', enabled: true, priority: 0 }])[0]?.apiKeys, undefined)
  })
})

describe('unmaskEngines', () => {
  const existing = [stored(['sk-one', 'sk-two', 'sk-three'])]
  const chips = placeholders(maskEngines(existing)[0]!)

  it('round-trips an untouched list byte for byte', () => {
    assert.deepEqual(roundTrip(chips, existing), ['sk-one', 'sk-two', 'sk-three'])
  })

  it('removes the key whose chip was removed, not the last one', () => {
    // The positional design failed exactly here: dropping the middle chip sent
    // [m, m], which reconstructed as ['sk-one','sk-two'] — the user deleted
    // sk-three and kept a key they had just removed.
    const withoutMiddle = [chips[0]!, chips[2]!]
    assert.deepEqual(roundTrip(withoutMiddle, existing), ['sk-one', 'sk-three'])
  })

  it('removes a specific key from a list interleaved with $ENV references', () => {
    // The visible failure of positional expansion: '[$ENV:X, m]' brought the
    // deleted literal back and dropped a different one.
    const mixed = [stored(['sk-one', '$ENV:EXA_KEY', 'sk-two'])]
    const mixedChips = placeholders(maskEngines(mixed)[0]!)
    assert.deepEqual(roundTrip([mixedChips[1]!, mixedChips[2]!], mixed), ['$ENV:EXA_KEY', 'sk-two'])
    assert.deepEqual(roundTrip([mixedChips[0]!, mixedChips[1]!], mixed), ['sk-one', '$ENV:EXA_KEY'])
  })

  it('appends a key typed beside the kept chips', () => {
    assert.deepEqual(
      roundTrip([chips[0]!, 'sk-new'], existing),
      ['sk-one', 'sk-new'],
    )
  })

  it('keeps a new key at the position the user put it', () => {
    // The chip row is the order the chain will try, so a new key inserted before
    // a stored one has to stay there.
    assert.deepEqual(roundTrip(['sk-new', ...chips], existing), ['sk-new', 'sk-one', 'sk-two', 'sk-three'])
  })

  it('clears the list when the client sends no keys', () => {
    assert.deepEqual(roundTrip([], existing), [])
  })

  it('refuses a placeholder the store cannot honour', () => {
    assert.throws(() => roundTrip([chips[0]!], []), WebSearchValidationError)
    // A stale chip from a panel that outlived the store: the reference is well
    // formed but names nothing.
    assert.throws(
      () => roundTrip([`••••••#${keyRefOf('sk-deleted-elsewhere')}`], existing),
      WebSearchValidationError,
    )
  })

  it('passes a body with no placeholders through untouched', () => {
    const item = { id: 'exa', apiKeys: ['sk-new'] }
    assert.deepEqual(unmaskEngines([item], existing), [item])
    assert.deepEqual(unmaskEngines(undefined, existing), undefined)
  })
})
