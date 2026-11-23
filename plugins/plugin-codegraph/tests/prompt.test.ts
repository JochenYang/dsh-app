/**
 * The overview block that reaches the model before it plans.
 *
 * This text is the answer to the failure that motivated it: a real session had a
 * current graph and a correct tool description, wrote "I should use
 * codegraph_find / codegraph_context" in its reasoning, and then planned `glob` +
 * `read` eight times. A description is an instruction; this is the answer, and it
 * arrives before the plan is made.
 *
 * The tests below pin the three properties that decide whether that works: the
 * block must say NOTHING when the graph cannot back it up (an empty or
 * still-indexing graph), it must stay inside a context budget while naming enough
 * to orient a reader, and — because the kernel re-appends the whole snapshot on
 * any byte change and retires nothing — it must stay BYTE-IDENTICAL across an
 * edit that did not change the project's shape. Measured on 234 real sessions:
 * 35 re-pushed this block 354 times, 280 of them because this text changed.
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
      { symbol: { id: 'src/util.ts#function:shared', name: 'shared', kind: 'function', path: 'src/util.ts', line: 3, parent: undefined }, references: 40, sourceReferences: 40 },
    ],
    ...over,
  }
}

/** A hub row as `projectOverview` hands it over: the symbol plus its two edge counts (source defaults to the total). */
function hub(id: string, references: number, source = references): ProjectOverview['hubs'][number] {
  const [path, rest] = id.split('#') as [string, string]
  const [kind, name] = rest.split(':') as [string, string]
  return { symbol: { id, name, kind, path, line: 1, parent: undefined }, references, sourceReferences: source }
}

/** The hub rows of a rendered block: the `- ` rows that carry a symbol id. */
function hubRows(text: string): string[] {
  return text.split('\n').filter(line => /^- \S+#\w+:\S+ — /u.test(line))
}

/** The block with its hub rows removed, for "nothing else moved" comparisons. */
function withoutHubRows(text: string): string {
  return text.split('\n').filter(line => !/^- \S+#\w+:\S+ — /u.test(line)).join('\n')
}

describe('renderOverviewContext', () => {
  it('names the counts, the entry candidates and the hubs', () => {
    const text = renderOverviewContext(overview(), 'current', undefined)
    assert.match(text, /~100 files/u)
    assert.match(text, /~1k symbols/u)
    assert.match(text, /typescript ~100/u)
    assert.match(text, /src\/cli\.ts/u)
    // The starting SYMBOL, and no line number: the line moved on every edit above it
    // and re-sent the whole snapshot (82 of 274 measured re-pushes were entry rows),
    // while `codegraph_context("<path>")` hands the outline with every line in one call.
    assert.match(text, /^- src\/cli\.ts \(starts at function run\)$/mu)
    assert.doesNotMatch(text, /run:\d+/u, 'the row carries no line to go stale')
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
        sourceReferences: 100 - i,
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
    assert.match(text, /^- src\/util\.ts#function:shared — ~50 source call site\(s\)$/mu,
      'the hub row leads with the full symbol id, which is what the tool accepts')
    assert.doesNotMatch(text, /pass any id above/iu, 'the instruction now matches what the rows carry')
    // And the entry rows stay queryable by path — no id needed, because a path is
    // itself a valid `codegraph_context` selector (it answers the file's outline).
    assert.match(text, /^- src\/cli\.ts/mu)
    assert.match(text, /codegraph_context\("<path>"\)/u, 'the entry heading names how to query its own column')
  })

  it('prints a hub nothing in source references with its total, said to be tests only', () => {
    // "0 source call site(s)" on a row under "most referenced" contradicts itself,
    // and in a project made of tests every row would say it.
    const mixed = renderOverviewContext(overview({
      hubs: [hub('src/env.ts#function:getOrThrow', 282, 15), hub('src/faux.ts#function:fauxMessage', 664, 0)],
    }), 'current', undefined)
    assert.match(mixed, /^Most-referenced symbols in source files/mu)
    assert.match(mixed, /^- src\/env\.ts#function:getOrThrow — ~20 source call site\(s\)$/mu)
    assert.match(mixed, /^- src\/faux\.ts#function:fauxMessage — ~500 call site\(s\), tests only$/mu, 'ranked below the one source does reference')
    const testsOnly = renderOverviewContext(overview({ hubs: [hub('src/faux.ts#function:fauxMessage', 664, 0)] }), 'current', undefined)
    assert.match(testsOnly, /^Most-referenced symbols, referenced from tests only/mu)
    assert.doesNotMatch(testsOnly, /source call site/u)
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
    assert.match(text, /~100 files/u)
    assert.doesNotMatch(text, /older than the working tree/u)
    assert.doesNotMatch(text, /file budget/u)
  })

  it('says the index is being built, and asserts no shape', () => {
    // "0 files" would be a statement about the project rather than about the pass;
    // a silent block was the other wrong answer, because it reads as "no graph here".
    for (const inputsUnderTest of [inputs({ state: 'indexing', overview: undefined }), inputs({ state: 'indexing' })]) {
      const text = overviewContextText(inputsUnderTest)
      assert.match(text, /being built/u)
      assert.doesNotMatch(text, /~100 files/u, 'and no shape is asserted while it builds')
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
    assert.doesNotMatch(text, /~100 files/u, 'and no shape is asserted')
  })

  it('announces a failed pass even when no reason was recorded', () => {
    const text = overviewContextText(inputs({ state: 'failed', failure: undefined }))
    assert.match(text, /FAILED/u)
    assert.doesNotMatch(text, /Reason:/u, 'an empty reason is omitted rather than printed as "undefined"')
  })

  it('says the graph is behind when the queue says stale', () => {
    const text = overviewContextText(inputs({ state: 'stale' }))
    assert.match(text, /~100 files/u, 'a stale graph is still worth reporting')
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

describe('the counts are 1–2–5 rungs, so an edit does not re-push the block', () => {
  // The kernel appends a whole runtime-context snapshot whenever ANY byte of the
  // joined text changes and retires nothing (the older copies stay in context),
  // so a count that moves by one after every edit costs a full snapshot — this
  // block plus the cwd, the policy and the task state — per edit. Measured on a
  // real session here: 351 of 435 snapshots differed only in these numbers.
  //
  // Two significant digits was the first fix and was not enough: at the tens
  // scale every unit moves the digit (`~440` → `~450`), and the headline's counts
  // account for 229 of the 274 measured re-pushes. A rung moves only when a
  // project changes size by a factor, which is the moment the number is worth it.
  const headline = (text: string): string => text.split('\n')[0] ?? ''

  it('snaps to the nearest rung in log distance, with a tilde, and prints values below 5 exactly', () => {
    const text = renderOverviewContext(overview({ files: 430, symbols: 7700, edges: 27000 }), 'current', undefined)
    assert.match(headline(text), /\(~500 files, ~10k symbols, ~20k edges/u)
    const tiny = renderOverviewContext(overview({ files: 3, symbols: 4, edges: 5 }), 'current', undefined)
    // Below 5 the exact value IS the bucket; 5 is the first rung and reads as one.
    assert.match(headline(tiny), /\(3 files, 4 symbols, ~5 edges/u)
  })

  it('reads the ladder at its representative points', () => {
    // One render per value, each through the symbol count so one assertion pins
    // one rung: 4 is exact, 5 and 7 are the `5` rung, 8 rounds UP to 10, and the
    // geometric midpoints (7.07, 14.1, 31.6, 316, 3162, 1.41M) take the LOWER rung.
    const symbolCount = (value: number): string => {
      const match = /\(~\S+ files, (~?\S+) symbols,/u.exec(headline(renderOverviewContext(overview({ symbols: value }), 'current', undefined)))
      return match?.[1] ?? ''
    }
    assert.equal(symbolCount(0), '0', 'a zero count is exact, like every value below 5')
    assert.equal(symbolCount(4), '4')
    assert.equal(symbolCount(5), '~5')
    assert.equal(symbolCount(7), '~5')
    assert.equal(symbolCount(8), '~10')
    assert.equal(symbolCount(152), '~200')
    assert.equal(symbolCount(430), '~500')
    assert.equal(symbolCount(7700), '~10k')
    assert.equal(symbolCount(27000), '~20k')
    assert.equal(symbolCount(1_500_000), '~2M', 'log-nearest: 1.5M is closer to 2M (0.288) than to 1M (0.405)')
  })

  it('is byte-identical while the counts stay inside their rung', () => {
    const before = renderOverviewContext(overview({ files: 430, symbols: 7700, edges: 27000 }), 'current', undefined)
    const afterEdit = renderOverviewContext(overview({ files: 431, symbols: 7750, edges: 27400 }), 'current', undefined)
    assert.equal(afterEdit, before,
      'one edited file must not change the text: the snapshot would be re-appended for nothing')
  })

  it('does move when the project changes magnitude, which is worth telling', () => {
    const before = renderOverviewContext(overview({ files: 430 }), 'current', undefined)
    const grown = renderOverviewContext(overview({ files: 4800 }), 'current', undefined)
    assert.notEqual(grown, before)
    assert.match(grown, /~5k files/u)
  })
})

describe('the block is stable across an edit that did not change the shape', () => {
  // The second half of the same measurement: of the 274 re-pushed diffs, 138 were
  // hub rows (a reorder or `~34` → `~35`), 82 were entry rows (a line shift or a
  // new file), 32 were the indexing status flipping in and out. Each row is built
  // so the common edit changes nothing; what does change is worth re-reading.
  const render = (over: Partial<ProjectOverview>): string => renderOverviewContext(overview(over), 'current', undefined)

  it('keeps the hub text when two hubs swap counts inside one rung', () => {
    const before = render({ hubs: [hub('src/x.ts#function:a', 34), hub('src/y.ts#function:b', 35)] })
    const swapped = render({ hubs: [hub('src/x.ts#function:a', 35), hub('src/y.ts#function:b', 34)] })
    assert.equal(swapped, before, 'both are ~50; the order is the id, not the count')
    assert.match(before, /^- src\/x\.ts#function:a — ~50 source call site\(s\)$/mu)
    assert.match(before, /^- src\/y\.ts#function:b — ~50 source call site\(s\)$/mu)
  })

  it('orders hubs by rung then id, so a count inside a rung cannot reorder them', () => {
    // Delivered in count-descending order, as `projectOverview` does; the text must
    // not inherit it. Both are in the 100 rung, so the lower id leads whatever the
    // counts say. A hub row is the one carrying a `#`: the entry rows above it share
    // the `- src/` prefix.
    const text = render({ hubs: [hub('src/z.ts#function:late', 120), hub('src/a.ts#function:early', 90)] })
    assert.deepEqual(hubRows(text), ['- src/a.ts#function:early — ~100 source call site(s)', '- src/z.ts#function:late — ~100 source call site(s)'])
    // Below 5 every value is its own rung and prints exactly, so the larger one
    // still leads and neither is rounded up to `~5`.
    const small = render({ hubs: [hub('src/b.ts#function:three', 3), hub('src/a.ts#function:four', 4)] })
    assert.deepEqual(hubRows(small), ['- src/a.ts#function:four — 4 source call site(s)', '- src/b.ts#function:three — 3 source call site(s)'])
  })

  it('changes only the hub list when the next candidate crosses a rung into the budget', () => {
    // Seven candidates for a six-row budget: the seventh sits in the 50 rung and is
    // cut. When it gains enough call sites to cross into the 100 rung, its id sorts
    // first and it displaces the last row. The set changes and nothing else does —
    // compared as SETS, because inserting a row shifts every row below it, and as
    // whole text with the hub rows removed.
    const base = [
      hub('src/m.ts#function:h1', 100), hub('src/n.ts#function:h2', 100), hub('src/o.ts#function:h3', 100),
      hub('src/p.ts#function:h4', 100), hub('src/q.ts#function:h5', 100), hub('src/r.ts#function:h6', 100),
    ]
    const before = render({ hubs: [...base, hub('src/a.ts#function:h7', 60)] })
    assert.deepEqual(hubRows(before), base.map(row => `- ${row.symbol.id} — ~100 source call site(s)`),
      'a 50-rung symbol stays below six 100-rung ones')
    const after = render({ hubs: [...base, hub('src/a.ts#function:h7', 90)] })
    assert.deepEqual(hubRows(after), [
      '- src/a.ts#function:h7 — ~100 source call site(s)',
      ...base.slice(0, 5).map(row => `- ${row.symbol.id} — ~100 source call site(s)`),
    ], 'the newcomer leads its rung by id, and the last row is the one displaced')
    assert.equal(withoutHubRows(after), withoutHubRows(before), 'every other line of the block is unchanged')
  })

  it('keeps the entry text when a line is inserted above the start symbol', () => {
    const before = render({})
    const shifted = render({
      entryCandidates: [
        { path: 'src/cli.ts', symbols: 4, symbol: { id: 'src/cli.ts#function:run', name: 'run', kind: 'function', path: 'src/cli.ts', line: 13, parent: undefined } },
        { path: 'src/index.ts', symbols: 1, symbol: undefined },
      ],
    })
    assert.equal(shifted, before, 'a line shift is not a change to the project')
  })

  it('adds exactly one line when a file enters the entry list', () => {
    const before = render({})
    const grown = render({
      entryCandidates: [
        ...overview().entryCandidates,
        { path: 'src/new.ts', symbols: 1, symbol: undefined },
      ],
    })
    const grownLines = grown.split('\n')
    const added = grownLines.findIndex(line => line === '- src/new.ts')
    assert.ok(added >= 0, 'the new entry row is present')
    grownLines.splice(added, 1)
    assert.equal(grownLines.join('\n'), before, 'and nothing else in the block moved')
  })

  it('ignores a symbol count change on an entry row, which the row no longer prints', () => {
    const before = render({})
    const recount = render({
      entryCandidates: [
        { path: 'src/cli.ts', symbols: 40, symbol: { id: 'src/cli.ts#function:run', name: 'run', kind: 'function', path: 'src/cli.ts', line: 12, parent: undefined } },
        { path: 'src/index.ts', symbols: 10, symbol: undefined },
      ],
    })
    assert.equal(recount, before)
  })
})

describe('the top-level layout line', () => {
  const layoutLine = (text: string): string | undefined => text.split('\n').find(line => line.startsWith('Top-level layout'))

  it('is absent without a layout, with one directory, or for a flat project', () => {
    // One directory says nothing about a project's shape, and a flat one has no
    // directories to name — both are the case where the line would be noise.
    assert.equal(layoutLine(renderOverviewContext(overview(), 'current', undefined)), undefined)
    assert.equal(layoutLine(renderOverviewContext(overview(), 'current', undefined, [{ dir: 'src', files: 300 }])), undefined)
    assert.equal(layoutLine(renderOverviewContext(overview(), 'current', undefined, [])), undefined)
  })

  it('names up to five directories, by rung descending then name ascending', () => {
    // `test` at 80 rounds UP to the 100 rung, so it leads the three 60-file
    // directories; those share the 50 rung and are ordered by name, not by their
    // exact counts — which is the point, since 60/61/62 would otherwise reorder.
    const text = renderOverviewContext(overview(), 'current', undefined, [
      { dir: 'src', files: 62 }, { dir: 'test', files: 80 }, { dir: 'docs', files: 60 },
      { dir: 'plugins', files: 500 }, { dir: 'scripts', files: 61 }, { dir: 'extra', files: 1 },
    ])
    assert.equal(
      layoutLine(text),
      'Top-level layout (indexed files): plugins ~500, test ~100, docs ~50, scripts ~50, src ~50.',
    )
  })

  it('sits right after the coverage line and does not move the rest of the block', () => {
    const without = renderOverviewContext(overview(), 'current', undefined)
    const withLayout = renderOverviewContext(overview(), 'current', undefined, [{ dir: 'src', files: 100 }, { dir: 'test', files: 20 }])
    const lines = withLayout.split('\n')
    const index = lines.findIndex(line => line.startsWith('Top-level layout'))
    assert.match(lines[index - 1] ?? '', /^Covers the project/u, 'the layout follows what the counts cover')
    assert.match(lines[index + 1] ?? '', /^Files nothing else imports/u, 'and precedes the lists')
    lines.splice(index, 1)
    assert.equal(lines.join('\n'), without)
  })

  it('counts inside a directory as one rung, so adding a file changes nothing', () => {
    const before = renderOverviewContext(overview(), 'current', undefined, [{ dir: 'src', files: 430 }, { dir: 'test', files: 80 }])
    const after = renderOverviewContext(overview(), 'current', undefined, [{ dir: 'src', files: 431 }, { dir: 'test', files: 81 }])
    assert.equal(after, before)
  })
})
