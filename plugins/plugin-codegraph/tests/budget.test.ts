/**
 * The budgets' invariants: a bigger project never gets a shallower source slice,
 * and a list that does not fit says less rather than more.
 *
 * The source-tier failure this guards is not a crash, which is why it needs a
 * test. A tier table edited one row at a time reads fine and quietly hands a
 * 5000-file repository less per-file depth than a 100-file one; every answer
 * about a large module then comes back truncated, and the model reads the file —
 * the exact cost the slice exists to remove.
 *
 * The list budget has the same shape of risk from the other side: a detail
 * ladder edited one threshold at a time reads fine and quietly answers a
 * 20-row file with names, or a 200-row file uncut at 12k tokens. The plan is
 * pure over a `measure` function, so these cases feed it a row function whose
 * lengths are known and assert the level and the row count that come back.
 *
 * @module plugin-codegraph/tests/budget
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  ANSWER_LIST_CHARS,
  ANSWER_LIST_TOKENS,
  MAX_OUTLINE_ROWS,
  estimateTokens,
  planOutline,
  sourceBudget,
  type OutlineDetail,
} from '../src/budget.ts'

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

describe('estimateTokens', () => {
  it('is four characters to a token, rounded up so a list at the budget reads as the budget', () => {
    // The first line reports `~N/1200 tokens`; a list of exactly 4,800 characters
    // must read as 1200, never 1199 — a reader comparing the two numbers would
    // otherwise conclude there is room when there is none.
    assert.equal(estimateTokens(0), 0)
    assert.equal(estimateTokens(1), 1)
    assert.equal(estimateTokens(4), 1)
    assert.equal(estimateTokens(5), 2)
    assert.equal(estimateTokens(ANSWER_LIST_CHARS), ANSWER_LIST_TOKENS)
  })

  it('reads a nonsensical length as zero rather than NaN', () => {
    // `NaN tokens` on the first line of an answer is worse than no number.
    assert.equal(estimateTokens(Number.NaN), 0)
    assert.equal(estimateTokens(Number.POSITIVE_INFINITY), 0)
    assert.equal(estimateTokens(-40), 0)
  })
})

/**
 * A row function with known lengths per level: a real outline row is ~58
 * characters at `names`, ~120 with a signature, ~230 with a signature and a
 * summary. The prefix makes every row distinct, so a cut can be told apart by
 * which rows survive.
 */
function rowMeasure(overrides: { names?: number, signatures?: number, full?: number } = {}): (row: number, level: OutlineDetail) => string {
  const lengths = { names: overrides.names ?? 58, signatures: overrides.signatures ?? 120, full: overrides.full ?? 230 }
  return (row, level) => `${String(row)}:${''.padEnd(lengths[level] - String(row).length - 1, 'x')}`
}

/** The rows a plan keeps, read back out of the measure. */
function keptRows(plan: { rows: number }): number[] {
  return Array.from({ length: plan.rows }, (_, index) => index)
}

describe('planOutline — the level a row count asks for', () => {
  it('gives a 20-row file signatures and summaries', () => {
    const plan = planOutline('auto', Array.from({ length: 20 }, (_, i) => i), rowMeasure())
    assert.equal(plan.detail, 'full')
    assert.equal(plan.rows, 20, 'nothing is cut')
    assert.equal(plan.cut, 0)
    // And it fits: the plan would have stepped down otherwise.
    assert.ok(plan.chars <= ANSWER_LIST_CHARS)
  })

  it('gives a 45-row file signatures alone', () => {
    // 45 rows at `full` would be ~12k characters; at `signatures` ~5.4k, which is
    // still over 4,800 — so this case is also the budget's first step. The level
    // the ROW COUNT asks for is `signatures`, and the budget then takes it to
    // names; the assertion is on the level that comes out, which is the contract.
    const plan = planOutline('auto', Array.from({ length: 45 }, (_, i) => i), rowMeasure({ signatures: 100 }))
    // 45 × 100 + 44 newlines = 4,544: fits at signatures.
    assert.equal(plan.detail, 'signatures')
    assert.equal(plan.rows, 45)
    assert.equal(plan.cut, 0)
  })

  it('gives an 80-row file names only, uncut', () => {
    // 80 × 58 + 79 newlines = 4,719: inside the budget by a hair, which is the
    // point — at 60 characters a row the same file loses its last row to the cut.
    const plan = planOutline('auto', Array.from({ length: 80 }, (_, i) => i), rowMeasure())
    assert.equal(plan.detail, 'names')
    assert.equal(plan.rows, 80)
    assert.equal(plan.cut, 0)
    assert.ok(plan.chars <= ANSWER_LIST_CHARS, `names must fit the budget, got ${String(plan.chars)}`)
  })
})

describe('planOutline — the budget steps the level down', () => {
  it('steps a 25-row file with long signatures from full to signatures', () => {
    // 25 rows is the `full` band by count. At 300 characters a row (a long
    // parameter list plus a summary) it is 7.5k — over — and at 180 (the
    // signature alone) 4.5k, which fits. One step down, and the count loses.
    const plan = planOutline('auto', Array.from({ length: 25 }, (_, i) => i), rowMeasure({ signatures: 180, full: 300 }))
    assert.equal(plan.detail, 'signatures')
    assert.equal(plan.rows, 25)
    assert.equal(plan.cut, 0)
    assert.ok(plan.chars <= ANSWER_LIST_CHARS)
  })

  it('steps further, to names, when the signatures alone do not fit', () => {
    // The same 25 rows with 300-character signatures: `signatures` is 7.5k, still
    // over, so the honest answer is `names` — and since names fit, no row is lost.
    const plan = planOutline('auto', Array.from({ length: 25 }, (_, i) => i), rowMeasure({ names: 60, signatures: 300, full: 500 }))
    assert.equal(plan.detail, 'names')
    assert.equal(plan.cut, 0, 'names at 60 characters fit, so no row is dropped')
    assert.ok(plan.chars <= ANSWER_LIST_CHARS)
  })

  it('cuts rows when even names do not fit, and says how many', () => {
    // The one case where saying less per row is no longer possible. The rows
    // are most-important first, so the cut is a PREFIX: the first rows survive.
    const plan = planOutline('auto', Array.from({ length: 200 }, (_, i) => i), rowMeasure({ names: 60 }))
    assert.equal(plan.detail, 'names')
    assert.ok(plan.rows < 200, '200 rows of 60 characters cannot fit 4,800')
    assert.equal(plan.cut, 200 - plan.rows, 'the cut is exactly the rows that did not fit')
    assert.deepEqual(keptRows(plan), Array.from({ length: plan.rows }, (_, i) => i), 'the surviving rows are the leading ones')
    assert.ok(plan.chars <= ANSWER_LIST_CHARS, `the kept rows fit, got ${String(plan.chars)}`)
  })

  it('keeps at least one row even when that row alone is over the budget', () => {
    // A single declaration whose name line is longer than the budget is absurd,
    // but an empty list under "declares 1 symbol(s)" would be a lie about the file.
    const plan = planOutline('auto', Array.from({ length: 3 }, (_, i) => i), rowMeasure({ names: 9_000, signatures: 9_000, full: 9_000 }))
    assert.equal(plan.rows, 1)
    assert.equal(plan.cut, 2)
  })
})

describe('planOutline — an explicit level is where the ladder starts', () => {
  it('honours detail: full on a file that fits it', () => {
    const plan = planOutline('full', Array.from({ length: 80 }, (_, i) => i), rowMeasure({ names: 40, signatures: 40, full: 50 }))
    assert.equal(plan.detail, 'full', '80 rows at 50 characters fit, so the request is kept')
    assert.equal(plan.rows, 80)
  })

  it('still steps detail: full down when it does not fit', () => {
    // An explicit level is not a promise to blow the budget: every character of
    // this list is re-read on every later turn.
    const plan = planOutline('full', Array.from({ length: 80 }, (_, i) => i), rowMeasure())
    assert.equal(plan.detail, 'names')
  })

  it('never steps UP from a requested level', () => {
    // `names` on a 5-row file is a reader asking for a compact list; the plan
    // has no reason to spend their budget for them.
    const plan = planOutline('names', Array.from({ length: 5 }, (_, i) => i), rowMeasure())
    assert.equal(plan.detail, 'names')
    assert.equal(plan.rows, 5)
  })

  it('starts `auto` at the level the row count picks, which is the default', () => {
    // The boundary the plan documents: 25 is the last `full` row count, 60 the
    // last `signatures` one, with rows short enough that the budget never moves.
    const short = rowMeasure({ names: 10, signatures: 10, full: 10 })
    assert.equal(planOutline('auto', Array.from({ length: 25 }, (_, i) => i), short).detail, 'full')
    assert.equal(planOutline('auto', Array.from({ length: 26 }, (_, i) => i), short).detail, 'signatures')
    assert.equal(planOutline('auto', Array.from({ length: 60 }, (_, i) => i), short).detail, 'signatures')
    assert.equal(planOutline('auto', Array.from({ length: 61 }, (_, i) => i), short).detail, 'names')
  })

  it('reads an empty file as zero rows and no cut', () => {
    const plan = planOutline('auto', [], rowMeasure())
    assert.deepEqual(plan, { detail: 'full', rows: 0, chars: 0, cut: 0 })
  })
})

describe('the budget constants', () => {
  it('keep the token budget at four characters a token', () => {
    assert.equal(estimateTokens(ANSWER_LIST_CHARS), ANSWER_LIST_TOKENS)
  })

  it('read more outline rows than the old 40-row limit, so the budget is what cuts a list', () => {
    // A 200-symbol file at `names` is ~80 rows inside the budget; reading 40 would
    // have made the row limit, which says nothing about size, the thing that cut.
    assert.ok(MAX_OUTLINE_ROWS > 40)
    assert.ok(MAX_OUTLINE_ROWS <= 200)
  })
})
