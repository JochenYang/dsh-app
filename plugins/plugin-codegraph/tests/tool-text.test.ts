/**
 * What the model actually reads, asserted on real rendered text.
 *
 * Why a suite of its own. The three renderers used to be closures inside
 * `defineTool`, so the only assertion available was a regular expression over the
 * SOURCE — which proves a template is gone, never that the sentence is right. Both
 * defects this file exists for were invisible to that kind of check:
 *
 *   - `impact` warned about truncation only when the REFERENCES list was cut. A
 *     symbol whose imports list was cut at 40 printed 40 paths with no count and no
 *     warning, under a heading that reads as the complete set. The `truncated`
 *     boolean was true; the text said nothing.
 *   - every relationship group was headed "implements this" unless it was `extends`
 *     or `type_refs`. `exports` rows are FILES (the edge starts at the module that
 *     publishes the symbol), so a reader debugging a type hierarchy was told a module
 *     "implements" it.
 *
 * The renderers are pure (`src/tool-text.ts`), so each case below builds the canonical
 * value a tool returns and asserts on the string the model receives.
 *
 * @module plugin-codegraph/tests/tool-text
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  relationLabel,
  renderContext,
  renderFind,
  renderImpact,
} from '../src/tool-text.ts'
import type { ContextResult, FindResult, ImpactResult, ListMeta, RelatedGroup, Referrer } from '../src/query.ts'

/** The text of the one block a renderer returns. */
function text(blocks: { type: 'text', text: string }[]): string {
  assert.equal(blocks.length, 1, 'one text block')
  assert.equal(blocks[0]?.type, 'text')
  return blocks[0].text
}

/** A referrer at a path and line. */
const ref = (path: string, line: number, name?: string): Referrer => ({ path, line, kind: 'references', name })

/** A relationship group. */
const group = (kind: string, rows: Referrer[], over: { total?: number, truncated?: boolean } = {}): RelatedGroup => ({
  kind, rows, truncated: over.truncated ?? false, ...(over.total === undefined ? {} : { total: over.total }),
})

/** A resolved impact answer, with every list reporting its own cut. */
function impact(over: Partial<ImpactResult> = {}, lists: { references?: ListMeta, imports?: ListMeta } = {}): ImpactResult {
  const referencing = over.referencing ?? [ref('src/a.ts', 3, 'alpha')]
  const imports = over.imports ?? ['src/lib.ts']
  const references: ListMeta = lists.references ?? { shown: referencing.length, total: over.total ?? referencing.length, truncated: over.truncated ?? false }
  const importMeta: ListMeta = lists.imports ?? { shown: imports.length, total: imports.length, truncated: false }
  return {
    freshness: 'current',
    note: undefined,
    target: { id: 'src/util.ts#function:shared', name: 'shared', kind: 'function', path: 'src/util.ts', line: 9, parent: undefined },
    referencing,
    imports,
    related: [],
    truncated: false,
    total: referencing.length,
    candidates: [],
    ...over,
    lists: { references, imports: importMeta },
  }
}

describe('renderImpact — truncation is per list', () => {
  it('says the references list is a sample when IT was cut', () => {
    const answer = impact(
      { referencing: Array.from({ length: 40 }, (_, i) => ref(`src/f${String(i)}.ts`, i + 1)), total: 664, truncated: true },
      { references: { shown: 40, total: 664, truncated: true } },
    )
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    assert.match(rendered, /referenced from 664 reference\(s\) — 40 shown/u)
    assert.match(rendered, /624 more reference\(s\) exist/u)
    assert.match(rendered, /SAMPLE, not the complete list/u)
  })

  it('says the IMPORTS list is a sample when references were not cut', () => {
    // THE CASE THE OLD TEXT MISSED ENTIRELY. `truncated` is true, the render only
    // looked at `references`, and 40 import paths were printed as if that were the
    // file's whole dependency set. A reader acting on that misses the module that
    // creates the cycle.
    const answer = impact(
      { imports: Array.from({ length: 40 }, (_, i) => `src/dep${String(i)}.ts`) },
      { imports: { shown: 40, total: 300, truncated: true } },
    )
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    assert.match(rendered, /its file imports \(40 of 300\)/u)
    assert.match(rendered, /the imports list is a sample/u)
    assert.match(rendered, /260 more import\(s\) exist/u)
    // And the references list, which was NOT cut, still reads as a complete count.
    assert.match(rendered, /referenced from 1 reference\(s\) across 1 file\(s\)/u)
    assert.doesNotMatch(rendered, /more reference\(s\) exist/u)
  })

  it('keeps the two cuts apart when BOTH lists were cut', () => {
    // A single "truncated" flag cannot express this, which is why the counts are
    // separate: 664 references and 300 imports is not "something was cut".
    const answer = impact(
      { referencing: Array.from({ length: 40 }, (_, i) => ref(`src/f${String(i)}.ts`, i + 1)), imports: Array.from({ length: 40 }, (_, i) => `src/dep${String(i)}.ts`), total: 664 },
      { references: { shown: 40, total: 664, truncated: true }, imports: { shown: 40, total: 300, truncated: true } },
    )
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    assert.match(rendered, /624 more reference\(s\)/u)
    assert.match(rendered, /260 more import\(s\)/u)
  })

  it('warns about a cut relationship group, naming its kind', () => {
    // The group cut at 40 rows with 300 behind it used to print "implements this (40):"
    // with no total and no warning — a sample presented as the set, in the list a
    // reader consults before changing an interface.
    const answer = impact({
      related: [group('implements', Array.from({ length: 40 }, (_, i) => ref(`src/c${String(i)}.ts`, i + 1)), { total: 300, truncated: true })],
      truncated: true,
    })
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    assert.match(rendered, /implements this \(40 of 300\)/u)
    assert.match(rendered, /this "implements" list is a sample — 260 more exist/u)
  })

  it('reports a complete list as complete, with no warning', () => {
    const answer = impact({ related: [group('extends', [ref('src/sub.ts', 2)])] })
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    assert.match(rendered, /derived from this \(subclasses\) \(1\):/u)
    assert.doesNotMatch(rendered, /TRUNCATED/u)
    assert.doesNotMatch(rendered, /of 1\)/u, 'a complete list prints its size, not "1 of 1"')
  })
})

describe('renderImpact — one relation, one label', () => {
  it('labels each relationship kind with what it actually means', () => {
    // Four kinds, four sentences. The old render collapsed `exports` into
    // "implements this" — and an `exports` edge starts at a FILE node, so the answer
    // said "a module implements this".
    assert.match(relationLabel('extends'), /derived from this/u)
    assert.match(relationLabel('implements'), /implements this/u)
    assert.match(relationLabel('type_refs'), /mentioned in a signature/u)
    assert.match(relationLabel('exports'), /exported from this module/u)
  })

  it('does not read an unknown kind as "implements this"', () => {
    // A kind added later must not silently inherit a meaning it does not have. The
    // fallback names the relation it does not know instead of borrowing another's.
    const label = relationLabel('documents')
    assert.doesNotMatch(label, /implements/u)
    assert.match(label, /documents/u, 'the unknown kind is named, so a reader can see it is one')
    assert.doesNotMatch(relationLabel(''), /implements/u, 'and an empty kind is not a relationship claim either')
  })

  it('renders all four kinds present in one answer under their own headings', () => {
    const answer = impact({
      related: [
        group('extends', [ref('src/a.ts', 1)]),
        group('implements', [ref('src/b.ts', 2)]),
        group('type_refs', [ref('src/c.ts', 3)]),
        group('exports', [ref('src/index.ts', 4)]),
      ],
    })
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    for (const expected of ['derived from this (subclasses)', 'implements this', 'mentioned in a signature', 'exported from this module']) {
      assert.ok(rendered.includes(expected), `missing heading: ${expected}`)
    }
    assert.equal(rendered.match(/implements this/gu)?.length, 1, 'exactly one group is an "implements" relationship')
  })
})

describe('renderImpact — an ambiguous name', () => {
  it('does not claim the edges are missing, and asks for one id', () => {
    // The sentence this replaces: "so no reference edges were built for it". That
    // stopped being true when `linkTargets` began linking to every declaration of a
    // shared name (up to ten). Telling a model the edges do not exist teaches it to
    // conclude "nothing calls this", which is the wrong conclusion this tool exists to
    // prevent.
    const answer = impact({
      target: undefined,
      referencing: [],
      imports: [],
      total: 0,
      candidates: [
        { id: 'src/faux.ts#function:stream', name: 'stream', kind: 'function', path: 'src/faux.ts', line: 4, parent: undefined },
        { id: 'test/harness.ts#function:stream', name: 'stream', kind: 'function', path: 'test/harness.ts', line: 7, parent: undefined },
      ],
      ambiguity: 2,
    })
    const rendered = text(renderImpact({ symbol: 'stream' }, answer))
    assert.match(rendered, /"stream" is declared 2 time\(s\)/u)
    assert.doesNotMatch(rendered, /no reference edges were built/u)
    assert.match(rendered, /the reference edges exist, but they belong to several distinct declarations/u)
    assert.match(rendered, /src\/faux\.ts#function:stream/u, 'both ids are printed, because "impact one of them" needs a selector')
    assert.match(rendered, /test\/harness\.ts#function:stream/u)
    assert.match(rendered, /An ambiguous name is not an absent one/u)
  })

  it('says plainly when nothing is declared under the name', () => {
    const answer = impact({ target: undefined, referencing: [], imports: [], total: 0, candidates: [], ambiguity: 0 })
    const rendered = text(renderImpact({ symbol: 'nowhere' }, answer))
    assert.match(rendered, /no symbol named that in this project/u)
  })
})

describe('renderImpact — an empty reference list', () => {
  it('never reads as "safe to change"', () => {
    const answer = impact({ referencing: [], imports: [], total: 0 })
    const rendered = text(renderImpact({ symbol: 'shared' }, answer))
    assert.match(rendered, /No direct callers found/u)
    assert.match(rendered, /NOT "safe to change"/u)
    assert.match(rendered, /dynamic dispatch/u, 'and why name resolution produces that answer')
  })
})

describe('renderFind', () => {
  it('carries the call-site count and the cheaper-than-searching advice', () => {
    const answer: FindResult = {
      freshness: 'current',
      note: undefined,
      truncated: false,
      symbols: [
        { id: 'src/a.ts#function:cheap', name: 'cheap', kind: 'function', path: 'src/a.ts', line: 1, parent: undefined, references: 2 },
        { id: 'src/b.ts#function:busy', name: 'busy', kind: 'function', path: 'src/b.ts', line: 1, parent: undefined, references: 482 },
      ],
    }
    const rendered = text(renderFind(answer))
    assert.match(rendered, /2 call site\(s\)/u)
    assert.match(rendered, /482 call site\(s\)/u)
    assert.match(rendered, /`codegraph_impact\("src\/b\.ts#function:busy"\)` is cheaper than searching/u)
    assert.equal(rendered.match(/is cheaper than searching/gu)?.length, 1, 'the cheap symbol does not get the advice')
  })

  it('flags a cut match list', () => {
    const answer: FindResult = { freshness: 'stale', note: 'older', truncated: true, symbols: [] }
    const rendered = text(renderFind(answer))
    assert.match(rendered, /truncated/u)
    assert.match(rendered, /note: older/u)
  })
})

describe('renderContext', () => {
  it('prints an id per declaration, so "pass any id above" is followable', () => {
    // The outline is the list a reader expands FROM. It carried kind, name, line and a
    // call count — and then said "pass any id above", with no id on any row. The id is
    // also what disambiguates two same-named methods, which a name cannot.
    const answer: ContextResult = {
      freshness: 'current',
      note: undefined,
      siblings: [],
      calls: [],
      calledBy: [],
      imports: [],
      documents: [],
      truncated: false,
      file: {
        path: 'src/util.ts',
        symbols: [{
          id: 'src/util.ts#function:shared', name: 'shared', kind: 'function', path: 'src/util.ts',
          line: 9, parent: undefined, references: 40, exported: true,
        }],
        reExports: [],
      },
    }
    const rendered = text(renderContext(answer, 40))
    assert.match(rendered, /\(id: src\/util\.ts#function:shared\)/u)
    assert.match(rendered, /\[exported\]/u)
  })

  it('prints an id per hub in the overview, and names how to expand one', () => {
    const answer: ContextResult = {
      freshness: 'current',
      note: undefined,
      siblings: [],
      calls: [],
      calledBy: [],
      imports: [],
      documents: [],
      truncated: false,
      overview: {
        files: 3,
        symbols: 5,
        edges: 2,
        truncated: false,
        byLanguage: [{ lang: 'typescript', files: 3 }],
        entryCandidates: [{ path: 'src/cli.ts', symbols: 1, symbol: undefined }],
        hubs: [{ symbol: { id: 'src/util.ts#function:shared', name: 'shared', kind: 'function', path: 'src/util.ts', line: 9, parent: undefined }, references: 40 }],
      },
    }
    const rendered = text(renderContext(answer, 40))
    assert.match(rendered, /^- src\/util\.ts#function:shared — 40 call site\(s\)$/mu)
    assert.match(rendered, /Pass one of those ids as `symbol`/u)
  })

  it('says a symbol answer is a sample when any list was cut', () => {
    const answer: ContextResult = {
      freshness: 'current',
      note: undefined,
      symbol: { id: 'src/a.ts#function:f', name: 'f', kind: 'function', path: 'src/a.ts', line: 1, parent: undefined },
      siblings: [],
      calls: [],
      calledBy: [],
      imports: [],
      documents: [],
      truncated: true,
    }
    const rendered = text(renderContext(answer, 40))
    assert.match(rendered, /TRUNCATED: at least one list was cut at 40 rows/u)
  })
})
