/**
 * The overview block that reaches the model before it plans.
 *
 * This text is the answer to the failure that motivated it: a real session had a
 * current graph and a correct tool description, wrote "I should use
 * codegraph_find / codegraph_context" in its reasoning, and then planned `glob` +
 * `read` eight times. A description is an instruction; this is the answer, and it
 * arrives before the plan is made.
 *
 * The tests below pin the two properties that decide whether that works: the block
 * must say NOTHING when the graph cannot back it up (an empty or still-indexing
 * graph), and it must stay inside a context budget while naming enough to orient a
 * reader.
 *
 * @module plugin-codegraph/tests/prompt
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { overviewContextText, renderOverviewContext } from '../src/prompt.ts'
import type { ProjectOverview } from '../src/query.ts'

/** A project with enough shape to be worth naming. */
function overview(over: Partial<ProjectOverview> = {}): ProjectOverview {
  return {
    files: 120,
    symbols: 900,
    edges: 2400,
    truncated: false,
    byLanguage: [{ lang: 'typescript', files: 100 }, { lang: 'javascript', files: 20 }],
    entryCandidates: [
      { path: 'src/cli.ts', symbols: 4, symbol: { id: 'src/cli.ts#function:run', name: 'run', kind: 'function', path: 'src/cli.ts', line: 12, parent: undefined } },
      { path: 'src/index.ts', symbols: 1, symbol: undefined },
    ],
    hubs: [
      { symbol: { id: 'src/util.ts#function:shared', name: 'shared', kind: 'function', path: 'src/util.ts', line: 3, parent: undefined }, references: 40 },
    ],
    ...over,
  }
}

describe('renderOverviewContext', () => {
  it('names the counts, the entry candidates and the hubs', () => {
    const text = renderOverviewContext(overview(), 'current', undefined)
    assert.match(text, /120 files/u)
    assert.match(text, /900 symbols/u)
    assert.match(text, /typescript 100/u)
    assert.match(text, /src\/cli\.ts/u)
    assert.match(text, /starts at function run/u)
    assert.match(text, /shared/u)
  })

  it('says nothing for a project with no graph yet', () => {
    // "0 files" would be a statement about the project rather than about the pass,
    // and a model that reads it concludes the project is empty.
    assert.equal(renderOverviewContext(undefined, 'current', undefined), '')
    assert.equal(renderOverviewContext(overview({ files: 0 }), 'current', undefined), '')
  })

  it('says nothing while the graph is still being built', () => {
    // The pass has no shape to report mid-flight; the tools answer `indexing`.
    assert.equal(renderOverviewContext(overview(), 'indexing', undefined), '')
  })

  it('carries the freshness sentence when the graph is behind', () => {
    const text = renderOverviewContext(overview(), 'stale', 'the graph is older than the working tree')
    assert.match(text, /older than the working tree/u)
  })

  it('stays inside the context budget no matter how large the project is', () => {
    // Five entry candidates and five hubs, whatever the lists hold: this text is
    // spent on EVERY turn, and an unbounded list would cost more than the reading
    // it saves.
    const many = overview({
      entryCandidates: Array.from({ length: 40 }, (_, i) => ({ path: `src/e${String(i)}.ts`, symbols: 1, symbol: undefined })),
      hubs: Array.from({ length: 40 }, (_, i) => ({
        symbol: { id: `src/h${String(i)}.ts#function:h`, name: `h${String(i)}`, kind: 'function', path: `src/h${String(i)}.ts`, line: 1, parent: undefined },
        references: 100 - i,
      })),
      byLanguage: Array.from({ length: 12 }, (_, i) => ({ lang: `lang${String(i)}`, files: 10 - i })),
    })
    const lines = renderOverviewContext(many, 'current', undefined).split('\n')
    // 1 headline + 1 entries heading + 5 entries + 1 hubs heading + 5 hubs
    // + 1 trigger heading + 3 triggers = 17. The trigger block is at the END on
    // purpose: the CodeCompass study moved its checklist there and raised graph-tool
    // adoption from 0/30 to 31/31 on structural tasks.
    assert.ok(lines.length <= 18, `expected at most 18 lines, got ${String(lines.length)}:\n${lines.join('\n')}`)
    assert.equal(lines.filter(line => /^- src\/e/u.test(line)).length, 5, 'five entry candidates')
    assert.equal(lines.filter(line => /^- function h/u.test(line)).length, 5, 'five hubs')
  })

  it('ends with the concrete triggers, not a generic suggestion', () => {
    // A sentence that names the QUESTION is one the model can match against the task
    // in front of it; "consider using codegraph" is not. The three triggers are the
    // questions keyword search structurally cannot answer.
    const lines = renderOverviewContext(overview(), 'current', undefined).split('\n')
    const tail = lines.slice(-4).join('\n')
    assert.match(tail, /who calls this/u)
    assert.match(tail, /what does this file define/u)
    assert.match(tail, /codegraph_impact/u)
  })
})

describe('overviewContextText — the state matrix', () => {
  /** The inputs for one state, with sensible defaults for the rest. */
  const inputs = (over: Partial<Parameters<typeof overviewContextText>[0]> = {}) => ({
    state: 'current' as const,
    failure: undefined,
    overview: overview(),
    truncated: false,
    removalSkipped: false,
    ...over,
  })

  it('reports the shape when the graph is current and complete', () => {
    const text = overviewContextText(inputs())
    assert.match(text, /120 files/u)
    assert.doesNotMatch(text, /older than the working tree/u)
    assert.doesNotMatch(text, /file budget/u)
  })

  it('says nothing while indexing, because there is no shape yet', () => {
    // "0 files" would be a statement about the project rather than about the pass.
    assert.equal(overviewContextText(inputs({ state: 'indexing', overview: undefined })), '')
    assert.equal(overviewContextText(inputs({ state: 'indexing' })), '')
  })

  it('announces a failed pass with its reason, and reports no shape', () => {
    // The state is terminal until a human retries, so a shape left by it has no
    // bounded age. Saying nothing would drop the only surface that explains why;
    // asserting the shape would be the one claim this plugin must never make.
    const text = overviewContextText(inputs({ state: 'failed', failure: 'EPERM: root unreadable' }))
    assert.match(text, /FAILED/u)
    assert.match(text, /EPERM: root unreadable/u, 'the recorded reason is carried, not swallowed')
    assert.doesNotMatch(text, /120 files/u, 'and no shape is asserted')
  })

  it('announces a failed pass even when no reason was recorded', () => {
    const text = overviewContextText(inputs({ state: 'failed', failure: undefined }))
    assert.match(text, /FAILED/u)
    assert.doesNotMatch(text, /Reason:/u, 'an empty reason is omitted rather than printed as "undefined"')
  })

  it('says the graph is behind when the queue says stale', () => {
    const text = overviewContextText(inputs({ state: 'stale' }))
    assert.match(text, /120 files/u, 'a stale graph is still worth reporting')
    assert.match(text, /older than the working tree/u)
  })

  it('carries what the last pass recorded about its own completeness', () => {
    // Either fact alone must reach the text: the block asserts a shape, so it has to
    // say when that shape is partial.
    assert.match(overviewContextText(inputs({ truncated: true })), /file budget/u)
    assert.match(overviewContextText(inputs({ removalSkipped: true })), /could not verify deletions/u)
    // And both together produce both sentences, not one overriding the other.
    const both = overviewContextText(inputs({ truncated: true, removalSkipped: true }))
    assert.match(both, /file budget/u)
    assert.match(both, /could not verify deletions/u)
  })

  it('combines stale with a partial pass', () => {
    const text = overviewContextText(inputs({ state: 'stale', truncated: true }))
    assert.match(text, /older than the working tree/u)
    assert.match(text, /file budget/u)
  })

  it('says nothing for a stale graph that has no shape to report', () => {
    // A stale marker with no graph behind it would be a claim with nothing in it.
    assert.equal(overviewContextText(inputs({ state: 'stale', overview: undefined })), '')
  })
})
