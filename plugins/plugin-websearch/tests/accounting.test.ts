// The settings page's self-test answers "which engine actually answered, and was
// it a cache hit?" out of a box the provider fills in beside the seam's own
// result (the seam's shape is portable and owned upstream, so it has no room for
// chain accounting).
//
// On this kernel line `web_search` runs a LIST of queries through the seam at
// once, which is what turns a last-write-wins slot into a wrong answer: the
// self-test clears the box, searches once and reads back, and a call for another
// query that finishes in that window would have it name an engine the reader is
// not looking at. These cases pin the property that removes that — the box
// answers by query — plus the two neighbours it must not break: the same query
// twice (interchangeable), and clear().
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { AccountingBox } from '../src/accounting.ts'

const accounting = (engine: string, cached = false) => ({ engine, cached, attempts: 1, failed: [] })

describe('AccountingBox (the self-test\'s read path)', () => {
  it('answers the query that asked', () => {
    const box = new AccountingBox()
    box.set('alpha', accounting('bing'))
    assert.equal(box.get('alpha')?.engine, 'bing')
    assert.equal(box.get('alpha')?.cached, false)
  })

  it('refuses to answer with another query\'s accounting', () => {
    // The race this exists for: a call for `beta` completes while the reader of
    // `alpha` is between its own search and its read.
    const box = new AccountingBox()
    box.set('beta', accounting('exa', true))
    assert.equal(
      box.get('alpha'),
      undefined,
      'a different query must read as "no accounting", not as beta\'s engine and cache verdict',
    )
  })

  it('a concurrent call for the SAME query is interchangeable with ours', () => {
    // Same query means the same engines and the same cache key, so either answer
    // is the right one — the box does not have to tell the two calls apart.
    const box = new AccountingBox()
    box.set('alpha', accounting('parallel'))
    assert.equal(box.get('alpha')?.engine, 'parallel')
  })

  it('clear() drops whatever was held, so a self-test starts from nothing', () => {
    const box = new AccountingBox()
    box.set('alpha', accounting('bing'))
    box.clear()
    assert.equal(box.get('alpha'), undefined)
  })
})
