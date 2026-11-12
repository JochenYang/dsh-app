/**
 * The key ring: which key a search uses, and what a rejection does to it.
 *
 * These cases pin the three properties that make "several keys" worth having,
 * each of which a plausible implementation gets wrong:
 *
 * 1. A rejected key is swapped MID-ATTEMPT — the search does not fail and does
 *    not fall through to the next engine, it retries with the next key.
 * 2. Only quota/auth statuses are the key's fault. Rotating on a 500 or a
 *    timeout would turn one failure into N requests.
 * 3. A spent key list degrades to the anonymous call the provider also
 *    serves, because every keyed engine in the roster still answers without a
 *    key. Failing the search instead would be a regression against 0.2.x.
 *
 * @module plugin-websearch/tests/keyring
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  isKeyRejection,
  KEY_COOLDOWN_MS,
  Keyring,
  keyringFor,
  keyStatus,
  resetKeyrings,
  runWithKeys,
} from '../src/engines/keyring.ts'
import { HttpError } from '../src/engines/types.ts'

beforeEach(() => { resetKeyrings() })

/** A ring with an injectable clock, so the cooldown is testable in real time. */
function ring(keys: string[], clock: { now: number }): Keyring {
  return new Keyring('exa', keys, () => clock.now)
}

describe('isKeyRejection', () => {
  it('treats 401, 402 and 429 as the key being spent or wrong', () => {
    for (const status of [401, 402, 429]) assert.equal(isKeyRejection(new HttpError(status)), true)
  })

  it('does not rotate on a server fault, a timeout or a parse error', () => {
    // 403 is deliberately absent: it is as often a WAF as a quota, and rotating
    // a list into a blocking endpoint spends every key on the same refusal.
    for (const status of [400, 403, 404, 500, 503]) assert.equal(isKeyRejection(new HttpError(status)), false)
    assert.equal(isKeyRejection(new Error('HTTP 402')), false, 'a status parsed out of a message is not evidence')
    assert.equal(isKeyRejection(new Error('search timed out')), false)
  })
})

describe('Keyring', () => {
  it('serves the configured keys in order', () => {
    const ring1 = new Keyring('exa', ['a', 'b'])
    assert.deepEqual(ring1.available(), ['a', 'b'])
    assert.equal(ring1.indexOf('b'), 1)
  })

  it('takes a rejected key out of rotation and puts it back when the cooldown ends', () => {
    const clock = { now: 1_000 }
    const ring1 = ring(['a', 'b'], clock)
    ring1.markExhausted('a')
    assert.deepEqual(ring1.available(), ['b'])
    assert.equal(ring1.coolingCount(), 1)
    clock.now += KEY_COOLDOWN_MS + 1
    assert.deepEqual(ring1.available(), ['a', 'b'])
    assert.equal(ring1.coolingCount(), 0)
  })

  it('keeps a cooldown across a config save that re-sends the same keys', () => {
    // Saving an unrelated field must not hand a spent key back to the next
    // search — the quota did not come back just because the form was submitted.
    const clock = { now: 0 }
    const ring1 = ring(['a', 'b'], clock)
    ring1.markExhausted('a')
    ring1.setKeys(['a', 'b'])
    assert.deepEqual(ring1.available(), ['b'])
  })

  it('drops the state of a key that is no longer configured', () => {
    const clock = { now: 0 }
    const ring1 = ring(['a', 'b'], clock)
    ring1.markExhausted('a')
    ring1.setKeys(['b'])
    assert.deepEqual(ring1.available(), ['b'])
    // Re-adding it starts clean: the user may have topped up the account.
    ring1.setKeys(['a', 'b'])
    assert.deepEqual(ring1.available(), ['a', 'b'])
  })
})

describe('runWithKeys', () => {
  it('answers with the first usable key', async () => {
    const ring1 = new Keyring('exa', ['a', 'b'])
    const outcome = await runWithKeys(ring1, async key => `via ${String(key)}`)
    assert.equal(outcome.value, 'via a')
    assert.equal(outcome.keyIndex, 0)
  })

  it('swaps to the next key inside one attempt when the first is rejected', async () => {
    const ring1 = new Keyring('exa', ['spent', 'good'])
    const seen: (string | undefined)[] = []
    const outcome = await runWithKeys(ring1, async (key) => {
      seen.push(key)
      if (key === 'spent') throw new HttpError(402)
      return 'ok'
    })
    assert.deepEqual(seen, ['spent', 'good'])
    assert.equal(outcome.keyIndex, 1)
    // The rejected key must not be retried by the next call.
    assert.deepEqual(ring1.available(), ['good'])
  })

  it('falls back to the anonymous call when every key is spent', async () => {
    const ring1 = new Keyring('exa', ['one', 'two'])
    const seen: (string | undefined)[] = []
    const outcome = await runWithKeys(ring1, async (key) => {
      seen.push(key)
      if (key !== undefined) throw new HttpError(429)
      return 'anonymous'
    })
    assert.deepEqual(seen, ['one', 'two', undefined])
    assert.equal(outcome.value, 'anonymous')
    assert.equal(outcome.keyIndex, undefined)
    assert.equal(ring1.coolingCount(), 2)
  })

  it('stops rotating on a non-key failure but still tries anonymously', async () => {
    // Two questions, two answers: a 500 is not the key's fault, so the next KEY
    // is not tried — but the anonymous tier may still answer where this key
    // could not, and a configured key must never turn a working engine into a
    // failure.
    const ring1 = new Keyring('exa', ['one', 'two'])
    const seen: (string | undefined)[] = []
    const outcome = await runWithKeys(ring1, async (key) => {
      seen.push(key)
      if (key !== undefined) throw new HttpError(500)
      return 'anonymous'
    })
    assert.deepEqual(seen, ['one', undefined])
    assert.equal(outcome.value, 'anonymous')
    assert.equal(ring1.coolingCount(), 0, 'a server fault must not cool a key down')
  })

  it('says what was tried when the keys AND the anonymous tier fail', async () => {
    // A bare "HTTP 402" reads exactly like the keyless case it is no longer.
    const ring1 = new Keyring('exa', ['spent'])
    await assert.rejects(
      () => runWithKeys(ring1, async (key) => {
        throw new HttpError(key === undefined ? 429 : 402)
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : ''
        return message.includes('exa') && message.includes('402') && message.includes('anonymous')
      },
    )
  })

  it('reports the plain error when there were no keys to blame', async () => {
    const ring1 = new Keyring('bing', [])
    await assert.rejects(
      () => runWithKeys(ring1, async () => { throw new HttpError(503) }),
      /HTTP 503/,
    )
  })

  it('never swallows a caller cancellation', async () => {
    // A cancelled search must not walk the key list, let alone the anonymous
    // tier: the caller has already stopped waiting.
    const ring1 = new Keyring('exa', ['one', 'two'])
    const seen: (string | undefined)[] = []
    const abort = new Error('search timed out')
    abort.name = 'AbortError'
    await assert.rejects(
      () => runWithKeys(ring1, async (key) => {
        seen.push(key)
        throw abort
      }),
      /timed out/,
    )
    assert.deepEqual(seen, ['one'])
  })

  it('treats an engine with no configured keys as one anonymous call', async () => {
    const ring1 = new Keyring('bing', [])
    const seen: (string | undefined)[] = []
    const outcome = await runWithKeys(ring1, async (key) => {
      seen.push(key)
      return 'ok'
    })
    assert.deepEqual(seen, [undefined])
    assert.equal(outcome.value, 'ok')
  })

  it('reports the configured position even when earlier keys are cooling', async () => {
    const ring1 = new Keyring('exa', ['one', 'two'])
    ring1.markExhausted('one')
    const outcome = await runWithKeys(ring1, async () => 'ok')
    assert.equal(outcome.keyIndex, 1, 'key #2 answered, and the page must say so')
  })
})

describe('keyringFor', () => {
  it('returns one ring per engine and adopts the new key list', () => {
    const first = keyringFor('exa', ['a'])
    const second = keyringFor('exa', ['a', 'b'])
    assert.equal(first, second, 'the registry owns one ring per engine')
    assert.deepEqual(second.available(), ['a', 'b'])
    assert.notEqual(keyringFor('parallel', []), first)
  })

  it('reports key status without creating or re-seeding a ring', () => {
    // The settings page reads this on every GET. A read that mutated rotation
    // state could reorder it out from under an in-flight search.
    keyringFor('exa', ['a']).markExhausted('a')
    assert.deepEqual(keyStatus('exa', ['a']), { count: 1, cooling: 1 })
    assert.deepEqual(keyStatus('exa', ['a', 'b']), { count: 2, cooling: 1 })
    // An engine with no ring yet just reports its configured keys.
    assert.deepEqual(keyStatus('anysearch', ['x']), { count: 1, cooling: 0 })
  })
})
