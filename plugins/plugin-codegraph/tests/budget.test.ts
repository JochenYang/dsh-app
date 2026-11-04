/**
 * The source budget's one invariant: a bigger project never gets a shallower slice.
 *
 * The failure this guards is not a crash, which is why it needs a test. A tier table
 * edited one row at a time reads fine and quietly hands a 5000-file repository less
 * per-file depth than a 100-file one; every answer about a large module then comes
 * back truncated, and the model reads the file — the exact cost the slice exists to
 * remove.
 *
 * @module plugin-codegraph/tests/budget
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { sourceBudget } from '../src/budget.ts'

/** Every tier boundary, plus the ends of the range a graph can report. */
const SIZES = [0, 1, 149, 150, 499, 500, 1_000, 20_000, 1_000_000]

describe('sourceBudget', () => {
  it('never shrinks per-file depth as the project grows', () => {
    let previous = sourceBudget(0)
    for (const files of SIZES) {
      const budget = sourceBudget(files)
      assert.ok(budget.maxLines >= previous.maxLines,
        `${String(files)} files must not get fewer lines per declaration than the previous tier (${String(budget.maxLines)} < ${String(previous.maxLines)})`)
      assert.ok(budget.maxChars >= previous.maxChars,
        `${String(files)} files must not get fewer characters than the previous tier`)
      previous = budget
    }
  })

  it('grows at least once, so the tiers are not one tier written three times', () => {
    assert.ok(sourceBudget(20_000).maxLines > sourceBudget(0).maxLines)
    assert.ok(sourceBudget(20_000).maxChars > sourceBudget(0).maxChars)
  })

  it('reads a nonsensical count as the smallest project rather than throwing', () => {
    // A tool answer must not fail because a caller read the wrong quantity, and the
    // smallest tier is the safe direction (less context spent, not more).
    assert.deepEqual(sourceBudget(Number.NaN), sourceBudget(0))
    assert.deepEqual(sourceBudget(-5), sourceBudget(0))
    assert.deepEqual(sourceBudget(Number.POSITIVE_INFINITY), sourceBudget(0))
  })
})
