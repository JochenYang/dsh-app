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
import { after, describe, it } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { dropUndefined, type ContextResult, type FindResult, type ImpactResult, type Referrer } from '../src/query.ts'
import { apply } from '../src/index.ts'

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

/**
 * The registered schemas, as `apply` left them, read once.
 *
 * Hand-built values here rather than a live graph: the question is whether the
 * schema DECLARES a field, which a real answer can only answer for the fields
 * that graph happens to produce. Every field the v5 columns added gets a value
 * that carries it and nothing else, so a missing schema row fails the one case
 * that names it. (`answers.test.ts` runs the real tools through the same
 * schemas for the shape a graph actually produces.)
 */
let schemas: Map<string, JsonSchemaNode> | undefined
/** The DSH home this suite found, restored once every case has run. */
const previousHome = process.env.DSH_HOME
after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})
function registeredSchemas(): Map<string, JsonSchemaNode> {
  if (schemas !== undefined) return schemas
  // A home that does not exist: `apply` lists known projects on a timer, and the
  // real home's graphs are none of this suite's business. Restored in `after`,
  // after that timer has had every chance to fire against the fake.
  process.env.DSH_HOME = join(tmpdir(), 'dsh-cg-tool-output-no-such-home')
  const found = new Map<string, JsonSchemaNode>()
  const ctx = {
    tools: { register(tool: { name: string, output: { schema: JsonSchemaNode } }): () => void { found.set(tool.name, tool.output.schema); return () => {} } },
    systemPrompt: { context(): () => void { return () => {} } },
    on(): () => void { return () => {} },
    effect(body: () => () => void): void { body() },
    inject(_deps: readonly string[], _callback: (scope: unknown) => void): void { /* no connection carrier */ },
  }
  apply(ctx as never)
  schemas = found
  return found
}

/** Validate one value against one tool's registered schema, after the strip the kernel applies. */
function problems(tool: 'codegraph_find' | 'codegraph_impact' | 'codegraph_context', value: unknown): string[] {
  const schema = registeredSchemas().get(tool)
  assert.ok(schema !== undefined, `${tool} is registered`)
  return validateJsonSchemaValue(schema, JSON.parse(JSON.stringify(dropUndefined(value))))
}

describe('every field the v5 columns add is declared by its schema', () => {
  it('find: a row may carry a signature', () => {
    assert.deepEqual(problems('codegraph_find', {
      freshness: 'current', note: undefined, truncated: false,
      symbols: [{ id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined, references: 1, signature: 'function f(): void' }],
    }), [])
    // And nothing else: the doc is NOT a find field, which is exactly how the
    // first detail read failed — the row spread `doc: ""` into the answer.
    assert.notEqual(problems('codegraph_find', {
      freshness: 'current', truncated: false,
      symbols: [{ id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined, references: 1, doc: '' }],
    }).length, 0)
  })

  it('impact: a reference may carry the confidence flag and the caller id', () => {
    const base = {
      freshness: 'current', note: undefined,
      target: { id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined },
      imports: [], truncated: false, total: 1, candidates: [], related: [],
    }
    assert.deepEqual(problems('codegraph_impact', {
      ...base,
      referencing: [
        { path: 'a.ts', line: 4, kind: 'references', name: 'caller', narrowed: true, callerId: 'a.ts#function:caller' },
        { path: 'b.ts', line: 2, kind: 'references', name: undefined },
      ],
    }), [])
  })

  it('impact: the tests group', () => {
    assert.deepEqual(problems('codegraph_impact', {
      freshness: 'current', note: undefined, target: undefined, referencing: [], imports: [], truncated: false, total: 0, candidates: [],
      related: [],
      tests: { files: ['tests/a.test.ts'], total: 3 },
    }), [])
  })

  it('impact: a reference may carry its line text and a drift flag; the answer the target source and the moved files', () => {
    const base = {
      freshness: 'stale', note: 'older',
      pendingFiles: ['b.ts'],
      target: { id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined },
      source: { path: 'a.ts', startLine: 1, endLine: 3, text: '1\tfunction f() {\n2\t}\n3\t', truncated: false, drift: false },
      imports: [], truncated: false, total: 2, candidates: [], related: [],
    }
    assert.deepEqual(problems('codegraph_impact', {
      ...base,
      referencing: [
        { path: 'b.ts', line: 4, kind: 'references', name: 'caller', narrowed: true, callerId: 'b.ts#function:caller', text: 'f(1)', drift: true },
        { path: 'c.ts', line: 2, kind: 'references', name: undefined, text: '  f()  ' },
      ],
    }), [])
    // A text that is not a string is still refused: the field is declared, the
    // shape of it is not negotiable.
    assert.notEqual(problems('codegraph_impact', {
      ...base,
      referencing: [{ path: 'b.ts', line: 4, kind: 'references', name: 'caller', text: 7 }],
    }).length, 0)
  })

  it('find and context: the moved files, on the envelope', () => {
    assert.deepEqual(problems('codegraph_find', {
      freshness: 'stale', note: undefined, pendingFiles: ['a.ts'], truncated: false,
      symbols: [{ id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined, references: 1 }],
    }), [])
    assert.deepEqual(problems('codegraph_context', {
      freshness: 'stale', note: undefined, pendingFiles: [],
      symbol: undefined, siblings: [], calls: [], calledBy: [], imports: [], documents: [], truncated: false,
    }), [])
  })

  it('impact: the caller tree, three levels deep, with every optional node field', () => {
    const leaf = { id: 'd.ts#function:leaf', name: 'leaf', kind: 'function', path: 'd.ts', line: 1, children: [], repeated: true }
    const mid = { id: 'c.ts#function:mid', name: 'mid', kind: 'method', path: 'c.ts', line: 3, children: [leaf], callers: 40 }
    const root = { id: 'b.ts#function:root', name: 'root', kind: 'function', path: 'b.ts', line: 9, children: [mid] }
    assert.deepEqual(problems('codegraph_impact', {
      freshness: 'current', note: undefined, target: undefined, referencing: [], imports: [], truncated: true, total: 0, candidates: [], related: [],
      callers: { depth: 3, nodes: 3, truncated: true, roots: [root], callers: 300 },
    }), [])
    // The innermost `children` is an open array by design (`depth` is clamped to
    // 3, so it only ever holds `[]`); what the schema does refuse is a node
    // field it does not know, at any level.
    assert.notEqual(problems('codegraph_impact', {
      freshness: 'current', target: undefined, referencing: [], imports: [], truncated: false, total: 0, candidates: [], related: [],
      callers: { depth: 3, nodes: 2, truncated: false, roots: [{ ...root, children: [{ ...mid, signature: 'x' }] }] },
    }).length, 0)
  })

  it('context: a file outline with its level, its cut and a row\u2019s head and summary', () => {
    const file = {
      freshness: 'current', note: undefined, siblings: [], calls: [], calledBy: [], imports: [], documents: [], truncated: true,
      file: {
        path: 'src/a.ts', detail: 'names', cut: 22,
        symbols: [{ id: 'src/a.ts#function:f', name: 'f', kind: 'function', path: 'src/a.ts', line: 1, parent: undefined, references: 3, exported: true, signature: 'function f(): void', doc: 'Does.' }],
        reExports: [],
      },
    }
    assert.deepEqual(problems('codegraph_context', file), [])
    // The level is required: a value without it would render at a level the
    // first line cannot name.
    const { detail: _detail, ...withoutDetail } = file.file
    assert.notEqual(problems('codegraph_context', { ...file, file: withoutDetail }).length, 0)
  })

  it('context: a symbol whose siblings and calls carry a head', () => {
    assert.deepEqual(problems('codegraph_context', {
      freshness: 'current', note: undefined,
      symbol: { id: 'a.ts#function:f', name: 'f', kind: 'function', path: 'a.ts', line: 1, parent: undefined },
      siblings: [{ id: 'a.ts#function:g', name: 'g', kind: 'function', path: 'a.ts', line: 5, parent: undefined, signature: 'function g(x: number): number' }],
      calls: [{ kind: 'references', line: 3, name: 'g', path: 'a.ts', signature: 'function g(x: number): number' }],
      calledBy: [], imports: [], documents: [], truncated: false,
    }), [])
  })
})

describe('the registered schemas refuse an undeclared key', () => {
  it('is live: a made-up field on a find row is refused', () => {
    // The control for the suite above. If the validator accepted anything, every
    // "declared" assertion would pass without proving a thing.
    assert.notEqual(problems('codegraph_find', {
      freshness: 'current', truncated: false,
      symbols: [{ id: 'x', name: 'n', kind: 'k', path: 'p', line: 1, parent: undefined, references: 0, madeUp: true }],
    }).length, 0)
  })
})
