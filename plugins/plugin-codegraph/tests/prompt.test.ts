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

  it('says the index is being built rather than nothing at all', () => {
    // The pass has no shape to report mid-flight, and it used to contribute '' — a
    // silence a model reads as "this project has no graph", in exactly the window a
    // session asks its first orientation question (a first pass on a real repository
    // takes tens of seconds).
    //
    // What it must NOT do is name a number: "0 files" would be a fact about the pass
    // reported as a fact about the project, and any partly-filled count is worse.
    const text = renderOverviewContext(overview(), 'indexing', undefined)
    assert.equal(text, '', 'the shape branch still refuses to invent a shape')
    const indexing = overviewContextText({
      state: 'indexing', failure: undefined, overview: undefined, truncated: false, removalSkipped: false,
    })
    assert.match(indexing, /being built/u)
    assert.match(indexing, /incomplete/u, 'the reader is told an empty answer means "not yet"')
    assert.doesNotMatch(indexing, /\b\d+\s+files\b/u, 'no count is invented for a pass that has not finished')
    assert.ok(indexing.length < 600, `the status must stay bounded, got ${String(indexing.length)} chars`)
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
    // The list budget SCALES with the project (see `rowBudget`): a fixed five named
    // a tenth of a 1771-file monorepo, and more than a 20-file library has. The
    // ceiling is what keeps this text — spent on every turn — bounded.
    const entries = lines.filter(line => /^- src\/e/u.test(line)).length
    const hubs = lines.filter(line => /^- src\/h\d+\.ts#/u.test(line)).length
    assert.ok(entries >= 5 && entries <= 12, `entry candidates within the 5..12 budget, got ${String(entries)}`)
    assert.equal(hubs, entries, 'both lists use the same budget')
    // 1 headline + 1 coverage line + 1 entries heading + N entries + 1 hubs heading
    // + N hubs + 1 trigger heading + 3 triggers, one line each.
    const ceiling = 8 + 2 * 12
    assert.ok(lines.length <= ceiling, `expected at most ${String(ceiling)} lines, got ${String(lines.length)}`)
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

  it('prints a copyable id for every hub, so "expand one of these" is followable', () => {
    // The defect: the block said "pass any id above", and the hub rows printed a
    // KIND, a NAME, a path and a line — no id. `resolveSymbol` accepts an id or a
    // UNIQUE name, and `projectOverview`'s hub query admits names declared twice (it
    // only excludes more than two), so the instruction was unfollowable exactly on
    // the rows it pointed at.
    const text = renderOverviewContext(overview(), 'current', undefined)
    assert.match(text, /^- src\/util\.ts#function:shared — 40 call site\(s\)$/mu,
      'the hub row leads with the full symbol id, which is what the tool accepts')
    assert.doesNotMatch(text, /pass any id above/iu, 'the instruction now matches what the rows carry')
    // And the entry rows stay queryable by path — no id needed, because a path is
    // itself a valid `codegraph_context` selector (it answers the file's outline).
    assert.match(text, /^- src\/cli\.ts/mu)
    assert.match(text, /codegraph_context\("<path>"\)/u, 'the entry heading names how to query its own column')
  })

  it('states what the counts cover and where static name resolution stops', () => {
    // Without this, a symbol count reads as "the whole project" and a graph of names
    // reads as a type checker. Both wrong assumptions change how a model acts on the
    // numbers, and one line is enough to prevent both.
    const text = renderOverviewContext(overview(), 'current', undefined)
    assert.match(text, /indexed files/u, 'the scope of the counts is stated')
    assert.match(text, /imports, calls, extends\/implements, signature type references/u, 'the relations it holds')
    assert.match(text, /no type inference, no dynamic dispatch/u, 'and the boundary of name resolution')
    assert.match(text, /read the source and the tests/u, 'plus what to do about it')
    // It is ONE line: this text is spent on every turn.
    assert.equal(text.split('\n').filter(line => /no type inference/u.test(line)).length, 1)
  })

  it('does not couple the plugin to a memory tool', () => {
    // The block used to end with "save with `memory_save`". This plugin owns no
    // memory behaviour, and the suite ships with and without that plugin; naming a
    // tool another plugin provides is how one plugin starts failing when the other
    // is absent — the model calls a tool nothing registered.
    const text = renderOverviewContext(overview(), 'current', undefined)
    assert.doesNotMatch(text, /memory_save|memory/u)
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

  it('says the index is being built, and asserts no shape', () => {
    // "0 files" would be a statement about the project rather than about the pass;
    // a silent block was the other wrong answer, because it reads as "no graph here".
    for (const inputsUnderTest of [inputs({ state: 'indexing', overview: undefined }), inputs({ state: 'indexing' })]) {
      const text = overviewContextText(inputsUnderTest)
      assert.match(text, /being built/u)
      assert.doesNotMatch(text, /120 files/u, 'and no shape is asserted while it builds')
      assert.doesNotMatch(text, /\b0 files\b/u, 'nor a shape-shaped zero')
    }
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
