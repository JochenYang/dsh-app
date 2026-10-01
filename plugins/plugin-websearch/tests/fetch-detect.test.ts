/**
 * The fake-IP canary decision table. The lookup seam is a fake, so these
 * assertions are about the verdict logic — the property under test is "which
 * resolver the next fetch uses", decided from evidence, not from the probe
 * host succeeding.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runCanary } from '../src/fetch/detect.ts'

/** A fake system resolver answering with a fixed address set, or failing. */
function lookupOf(addresses: readonly string[] | Error) {
  return async (): Promise<readonly string[]> => {
    if (addresses instanceof Error) throw addresses
    return addresses
  }
}

const FIXED_CLOCK = { clock: () => 1_700_000_000_000 }

describe('runCanary', () => {
  it('arms DoH when a canary address is non-public', async () => {
    const outcome = await runCanary({ lookup: lookupOf(['198.18.0.174']), ...FIXED_CLOCK })
    assert.equal(outcome.action, 'arm')
    assert.equal(outcome.verdict, 'poisoned')
    assert.equal(outcome.hits.length, 1)
    assert.deepEqual(outcome.hits[0].addresses, ['198.18.0.174'])
  })

  it('arms DoH when ANY address of the set is non-public', async () => {
    const outcome = await runCanary({ lookup: lookupOf(['93.184.216.34', '198.18.0.9']), ...FIXED_CLOCK })
    assert.equal(outcome.action, 'arm')
    assert.deepEqual(outcome.hits[0].addresses, ['198.18.0.9'])
  })

  it('keeps the system resolver when every address is public', async () => {
    const outcome = await runCanary({ lookup: lookupOf(['93.184.216.34', '2606:2800:220:1::1']), ...FIXED_CLOCK })
    assert.equal(outcome.action, 'system')
    assert.equal(outcome.verdict, 'clean')
    assert.equal(outcome.hits.length, 0)
  })

  it('arms DoH when the system resolver cannot answer at all', async () => {
    // A blind resolver beats a poisoned one: a machine whose system DNS
    // blackholes must not silently keep using it.
    const outcome = await runCanary({ lookup: lookupOf(new Error('EAI_AGAIN')), ...FIXED_CLOCK })
    assert.equal(outcome.action, 'arm')
    assert.equal(outcome.verdict, 'inconclusive')
    assert.match(outcome.failures[0], /EAI_AGAIN/)
  })

  it('records the check time the TTL window reads', async () => {
    const outcome = await runCanary({ lookup: lookupOf(['93.184.216.34']), ...FIXED_CLOCK })
    assert.equal(outcome.checkedAt, 1_700_000_000_000)
  })
})
