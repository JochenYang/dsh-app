/**
 * The per-project counters behind `/status`, as a pure in-memory structure.
 *
 * @module plugin-codegraph/tests/usage
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { USAGE_KEYS, UsageCounters, emptyUsage } from '../src/usage.ts'

describe('UsageCounters', () => {
  it('answers a complete zero row for a project nothing was counted for', () => {
    const counters = new UsageCounters()
    assert.deepEqual(counters.row('D:/a'), emptyUsage())
    assert.equal(counters.all().size, 0, 'a project with no count is not listed')
  })

  it('counts per project and per key, and keeps every key present', () => {
    const counters = new UsageCounters()
    counters.bump('D:/a', 'find')
    counters.bump('D:/a', 'find')
    counters.bump('D:/a', 'overviewChanges', 3)
    counters.bump('D:/b', 'impact')
    assert.deepEqual(counters.row('D:/a'), { ...emptyUsage(), find: 2, overviewChanges: 3 })
    assert.equal(counters.row('D:/b').impact, 1)
    assert.deepEqual(Object.keys(counters.row('D:/a')).sort(), [...USAGE_KEYS].sort())
  })

  it('hands out copies, so a consumer cannot change the counters', () => {
    const counters = new UsageCounters()
    counters.bump('D:/a', 'context')
    const row = counters.row('D:/a')
    const listed = counters.all().get('D:/a')
    assert.ok(listed !== undefined)
    row.context = 99
    listed.context = 99
    assert.equal(counters.row('D:/a').context, 1)
  })

  it('ignores a count that is not a non-negative number', () => {
    const counters = new UsageCounters()
    counters.bump('D:/a', 'find', Number.NaN)
    counters.bump('D:/a', 'find', -1)
    counters.bump('D:/a', 'find', 1.9)
    assert.equal(counters.row('D:/a').find, 1, 'a fractional count floors; nothing else moves it')
  })
})
