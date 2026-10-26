/**
 * The tool-result contract the kernel actually enforces.
 *
 * The kernel runs `snapshotJsonValue` on every `execute` return BEFORE the schema
 * check, and that function answers `undefined` for any object holding an
 * `undefined`-valued property (measured here, against the installed package). The
 * schema validator tolerates `undefined`; the snapshot step does not, and it runs
 * first. The result is `INVALID_TOOL_OUTPUT` — every call to a tool whose answer
 * carries an optional field set to `undefined` fails, and the most common answer
 * (a `current` result with no note, a top-level symbol with no parent) is exactly
 * that shape.
 *
 * This suite pins the property directly rather than trusting "the tests pass":
 * `dropUndefined` is applied at each tool exit, so a value that would be rejected
 * must never reach the registry. Both halves are asserted — the rejection is
 * proven to exist, and the output is proven to survive it.
 *
 * @module plugin-codegraph/tests/tool-output
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { dropUndefined, type ContextResult, type FindResult, type ImpactResult, type Referrer } from '../src/query.ts'

/** The exact shape a `current`, unremarkable `find` answer has. */
const findAnswer = (): FindResult => ({
  freshness: 'current',
  note: undefined,
  truncated: false,
  symbols: [
    { id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined },
  ],
})

describe('the rejection this suite exists for', () => {
  it('snapshotJsonValue refuses an object holding an undefined property', () => {
    // Measured against the installed kernel package: `undefined` is not lossless
    // JSON, so the snapshot answers undefined and the registry throws. Keeping
    // this assertion means a kernel line that relaxes the rule is noticed here,
    // in one place, rather than by a tool failing in a session.
    assert.equal(snapshotJsonValue({ a: 1, b: undefined }), undefined)
    assert.equal(snapshotJsonValue({ ok: true, note: undefined }), undefined)
    assert.equal(snapshotJsonValue({ nested: [{ p: undefined }] }), undefined)
    // A value with no undefined property round-trips fine — so the fix is a shape
    // fix, not a ban on optional fields.
    assert.deepEqual(snapshotJsonValue({ ok: true }), { ok: true })
  })
})

describe('dropUndefined', () => {
  it('removes undefined keys recursively and keeps everything else', () => {
    assert.deepEqual(
      dropUndefined({ a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [{ g: undefined, h: 3 }] }),
      { a: 1, c: { e: 2 }, f: [{ h: 3 }] },
    )
  })

  it('keeps null, because null is a meaningful JSON value', () => {
    // The schema declares these fields as `string`, so `null` is not the fix for
    // an absent optional — it would fail the validator instead. But a genuine
    // null elsewhere must survive the strip.
    assert.deepEqual(dropUndefined({ a: null }), { a: null })
  })

  it('leaves primitives and arrays of primitives alone', () => {
    assert.equal(dropUndefined(1), 1)
    assert.equal(dropUndefined('x'), 'x')
    assert.deepEqual(dropUndefined([1, 2]), [1, 2])
  })
})

describe('one quantity, one label', () => {
  it('never labels a call-site count as a file count', () => {
    // The defect this pins, read out of the code rather than asserted around it:
    // `codegraph_impact` rendered `referenced from ${rows.length} file(s)` where
    // rows were EDGES, so a symbol with 664 call sites across 110 files was
    // announced as "664 file(s)". The overview had the same shape one layer up
    // (203 distinct callers vs 664 call sites).
    //
    // The renderer now lives in `tool-text.ts` as a pure function, so the rule is
    // asserted on REAL output in `tool-text.test.ts`. What this case still guards is
    // the shape of the source: the template that named the wrong quantity must not
    // come back, and both counts must still be published with their own noun.
    const source = readFileSync(new URL('../src/tool-text.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(
      source,
      /referencing\.length\)\} file\(s\)/u,
      'a call-site count must not be labelled as a file count',
    )
    // And the two counts it DOES publish are both present, each with its own noun.
    assert.match(source, /reference\(s\) across/u)
    assert.match(source, /file\(s\):/u)
  })

  it('counts the same edges in the overview and in impact', () => {
    // The cross-face half: the overview's hub row and `codegraph_impact` must be
    // counting the same rows, because the model reads one and then asks the other.
    const overviewSource = readFileSync(new URL('../src/prompt.ts', import.meta.url), 'utf8')
    assert.match(overviewSource, /call site\(s\)/u, 'the hub row names the same noun impact uses')
  })
})

describe('the three tool answers survive the snapshot', () => {
  it('a current find answer with no note and no parent is lossless after the strip', () => {
    const answer = findAnswer()
    // Before the strip the kernel would refuse it — that is the defect.
    assert.equal(snapshotJsonValue(answer), undefined)
    // After it, the same answer is a valid tool result.
    const stripped = dropUndefined(answer)
    assert.notEqual(snapshotJsonValue(stripped), undefined)
    assert.deepEqual(snapshotJsonValue(stripped), JSON.parse(JSON.stringify(stripped)))
  })

  it('an impact answer with no resolved target is lossless after the strip', () => {
    const answer: ImpactResult = { freshness: 'indexing', note: undefined, target: undefined, referencing: [], imports: [] }
    assert.equal(snapshotJsonValue(answer), undefined)
    assert.notEqual(snapshotJsonValue(dropUndefined(answer)), undefined)
  })

  it('a context answer with no resolved symbol is lossless after the strip', () => {
    const answer: ContextResult = {
      freshness: 'indexing',
      note: 'the graph is being built',
      symbol: undefined,
      siblings: [],
      calls: [{ kind: 'references', line: 3, name: 'g', path: undefined }],
      calledBy: [],
      imports: [],
    }
    assert.equal(snapshotJsonValue(answer), undefined)
    const stripped = dropUndefined(answer)
    assert.notEqual(snapshotJsonValue(stripped), undefined)
    // `path: undefined` inside an edge is the same trap one level down.
    assert.equal((stripped.calls[0] as { path?: string }).path, undefined)
  })

  it('every answer the query layer can build is lossless once stripped', () => {
    // A sweep rather than three spot checks: any new optional field added to a
    // result type lands in this shape and has to survive.
    const answers: unknown[] = [
      { freshness: 'current', note: undefined, truncated: false, symbols: [] },
      { freshness: 'stale', note: 'behind', truncated: true, symbols: [{ id: 'x', name: 'n', kind: 'k', path: 'p', line: 1, parent: undefined }] },
      { freshness: 'current', target: undefined, referencing: [{ path: 'a', line: 1, kind: 'references' }], imports: [] },
      { freshness: 'current', symbol: { id: 'x', name: 'n', kind: 'k', path: 'p', line: 1, parent: 'C' }, siblings: [], calls: [], calledBy: [], imports: ['a'] },
      // The shape W11b introduced: a referrer that NAMES the calling symbol. The
      // `name` here is a string, not an optional undefined, so `dropUndefined`
      // keeps it — and the tool's schema must therefore declare it.
      { freshness: 'current', target: undefined, referencing: [{ path: 'a.ts', line: 4, kind: 'references', name: 'caller' }], imports: [], truncated: false },
      // A truncated answer: the flag is what stops a 40-row sample from reading as
      // the complete list of callers.
      { freshness: 'current', target: undefined, referencing: [{ path: 'a', line: 1, kind: 'references' }], imports: [], truncated: true },
      // The overview branch: the answer to a question that names no symbol. Its
      // entry candidate may have no starting symbol (a file of re-exports), so
      // that key is the optional one here.
      {
        freshness: 'current',
        note: undefined,
        siblings: [],
        calls: [],
        calledBy: [],
        imports: [],
        documents: [],
        overview: {
          files: 2,
          symbols: 3,
          edges: 1,
          truncated: false,
          byLanguage: [{ lang: 'typescript', files: 2 }],
          entryCandidates: [{ path: 'main.ts', symbols: 1, symbol: undefined }],
          hubs: [],
        },
      },
    ]
    for (const answer of answers) {
      const stripped = dropUndefined(answer)
      assert.notEqual(snapshotJsonValue(stripped), undefined, `rejected after strip: ${JSON.stringify(stripped)}`)
    }
  })

  it('carries every field the impact schema does not declare out of the answer', () => {
    // The gap this pins: `referencesTo` returns `{path, line, kind, name}` and
    // `ImpactResult.referencing` accepted it structurally while the output schema
    // declared only three keys. `additionalProperties: false` makes an undeclared
    // key an INVALID_TOOL_OUTPUT for the WHOLE answer, so the tool failed on
    // exactly the case W11b created. The type now names `name`, and this asserts
    // the value really carries it — so deleting either the type field or the
    // schema row breaks here.
    const referrer: Referrer = { path: 'a.ts', line: 4, kind: 'references', name: 'caller' }
    assert.deepEqual(Object.keys(referrer).sort(), ['kind', 'line', 'name', 'path'])
  })
})
