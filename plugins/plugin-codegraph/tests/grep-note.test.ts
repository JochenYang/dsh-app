/**
 * The search note and its per-session memory, on a real graph.
 *
 * The note rides on ANOTHER tool's output, so what is pinned here is what a wrong
 * note would break: it appears only when the pattern is one bare identifier the graph
 * declares exactly once; it carries the facts the model would otherwise read a file
 * for (path, line, signature, reference count, file count) plus the name of the next
 * call; it never exceeds its budget, whatever the path length; and the per-session
 * rule lets a second session ask the same name.
 *
 * @module plugin-codegraph/tests/grep-note
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { SEARCH_NOTE_MAX_CHARS, SearchNoteMemory, searchNote } from '../src/grep-note.ts'
import { fileNodeId, openGraph, replaceFile, type FileRecord, type SymbolRecord } from '../src/store.ts'
import { removeTree } from '../../../scripts/lib/remove-tree.mjs'

const scratch: string[] = []
const graphs: ReturnType<typeof openGraph>[] = []

after(async () => {
  // Graphs close BEFORE the tree goes: an open handle makes the removal fail on Windows.
  for (const graph of graphs.splice(0)) {
    try { graph.close() } catch { /* already closed */ }
  }
  for (const dir of scratch.splice(0)) await removeTree(dir)
})

function graph(): ReturnType<typeof openGraph> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cg-grepnote-'))
  scratch.push(dir)
  const opened = openGraph(join(dir, 'graph.db'))
  graphs.push(opened)
  return opened
}

const file = (path: string): FileRecord => ({ path, mtime: 1, size: 1, hash: 'h', lang: 'typescript' })

function sym(path: string, name: string, line = 1, signature = ''): SymbolRecord {
  return {
    id: `${path}#function:${name}`,
    path,
    name,
    kind: 'function',
    line,
    endLine: line,
    parent: undefined,
    signature,
  }
}

const SIGNATURE = 'export function uniqueThing(a: number, b: string): boolean'

/**
 * `uniqueThing` declared once (src/lib.ts:12, with a signature) and referenced
 * from three places in two files: twice from symbols in src/a.ts, once at file
 * scope in src/b.ts.
 */
function referenced(): ReturnType<typeof openGraph> {
  const g = graph()
  const target = sym('src/lib.ts', 'uniqueThing', 12, SIGNATURE)
  const first = sym('src/a.ts', 'first', 3)
  const second = sym('src/a.ts', 'second', 8)
  replaceFile(g.db, file('src/lib.ts'), [target], [])
  replaceFile(g.db, file('src/a.ts'), [first, second], [
    { from: first.id, to: target.id, kind: 'references', line: 3 },
    { from: second.id, to: target.id, kind: 'references', line: 9 },
  ])
  replaceFile(g.db, file('src/b.ts'), [], [
    { from: fileNodeId('src/b.ts'), to: target.id, kind: 'references', line: 20 },
  ])
  return g
}

describe('searchNote', () => {
  it('names the one declaration, its signature, the references, the files and the next call', () => {
    const note = searchNote(referenced(), 'uniqueThing')
    assert.equal(
      note,
      'codegraph: "uniqueThing" is declared once in this project — function at src/lib.ts:12'
      + ` (${SIGNATURE})`
      + ' — with 3 reference(s) from 2 file(s).'
      + ' `codegraph_impact("uniqueThing")` lists each reference with the function that contains it.',
    )
    assert.ok(note !== undefined && note.length <= SEARCH_NOTE_MAX_CHARS)
  })

  it('leaves the parenthetical out when the declaration has no signature', () => {
    // The schema-file scanners (Prisma, GraphQL, HCL, SQL) declare symbols with no
    // head to read, and the column is '' for them — not a gap the note should show.
    const g = graph()
    replaceFile(g.db, file('schema.graphql'), [sym('schema.graphql', 'Query', 4)], [])
    const note = searchNote(g, 'Query') ?? ''
    assert.match(note, /^codegraph: "Query" is declared once in this project — function at schema\.graphql:4 — with 0 reference\(s\) from 0 file\(s\)\. /u)
    assert.doesNotMatch(note, /\(:4/u, 'no empty parenthetical')
  })

  it('answers nothing for a name declared in more than one place', () => {
    // The ordinary case, not the exotic one: 71% of this repository's declarations
    // share a name. Picking one would describe the wrong symbol and look correct.
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'shared')], [])
    replaceFile(g.db, file('b.ts'), [sym('b.ts', 'shared')], [])
    assert.equal(searchNote(g, 'shared'), undefined)
  })

  it('answers nothing for a name the graph does not declare, and for an empty graph', () => {
    const empty = graph()
    assert.equal(searchNote(empty, 'anything'), undefined, 'a graph that declares nothing is not an error')
    const g = graph()
    replaceFile(g.db, file('a.ts'), [sym('a.ts', 'here')], [])
    assert.equal(searchNote(g, 'nowhere'), undefined)
  })

  it('matches the name as written, so another case is not the same identifier', () => {
    // `grep` is case-sensitive by default, so a note about `uniqueThing` under a
    // search for `UniqueThing` would describe a row the result does not contain.
    assert.equal(searchNote(referenced(), 'UniqueThing'), undefined)
  })

  it('answers nothing for a pattern that is not one bare identifier', () => {
    const g = referenced()
    const shapes = [
      'uniqueThing(', // a call
      'obj.uniqueThing', // a member access
      '*', // a wildcard
      'uniqueThing other', // words separated by a space
      'x|y', // an alternation
      '', // nothing
      '   ', // whitespace only
      'café', // outside the ASCII identifier the note promises
    ]
    for (const pattern of shapes) {
      assert.equal(searchNote(g, pattern), undefined, JSON.stringify(pattern))
    }
  })

  it('tolerates whitespace around the identifier', () => {
    const g = referenced()
    assert.equal(searchNote(g, '  uniqueThing \n'), searchNote(g, 'uniqueThing'))
    assert.notEqual(searchNote(g, '  uniqueThing \n'), undefined)
  })

  it('counts file-scope and symbol-scope references alike, each file once, recursion included', () => {
    // The count is the one `codegraph_find` and `codegraph_impact` report — every
    // `references` edge to the symbol — so a model comparing the three never sees
    // three numbers. Files are the distinct sources: two edges from one file are
    // one file, and a recursive call is an edge from the declaring file.
    const g = graph()
    const walk = sym('src/rec.ts', 'walk', 5)
    const go = sym('src/other.ts', 'go', 3)
    const stop = sym('src/other.ts', 'stop', 9)
    replaceFile(g.db, file('src/rec.ts'), [walk], [
      { from: walk.id, to: walk.id, kind: 'references', line: 6 },
      { from: fileNodeId('src/rec.ts'), to: walk.id, kind: 'references', line: 20 },
    ])
    replaceFile(g.db, file('src/other.ts'), [go, stop], [
      { from: go.id, to: walk.id, kind: 'references', line: 4 },
      { from: stop.id, to: walk.id, kind: 'references', line: 10 },
    ])
    // A source whose symbol row is gone (removed between two passes): the file is
    // still read off the id, the way `referencesTo` reads it.
    replaceFile(g.db, file('src/gone.ts'), [], [
      { from: 'src/gone.ts#function:ghost', to: walk.id, kind: 'references', line: 1 },
    ])
    const note = searchNote(g, 'walk')
    assert.ok(note !== undefined)
    assert.match(note, / — with 5 reference\(s\) from 3 file\(s\)\. /u)
  })

  it('drops the signature, then the closing pointer, then the note itself as the path grows', () => {
    // One declaration whose only variable is the length of its path. As it grows the
    // note must step down through exactly three shapes and then disappear — never
    // back, and never past the budget. The names are all the same length so the path
    // is the only thing that moves the count.
    const g = graph()
    const shapeOf = new Map<number, 'full' | 'no signature' | 'no pointer' | 'nothing'>()
    for (let length = 1; length <= 340; length++) {
      const path = `src/${'x'.repeat(length)}.ts`
      const name = `n${String(length).padStart(4, '0')}`
      replaceFile(g.db, file(path), [sym(path, name, 1, `export function ${name}(a: number): void`)], [])
      const note = searchNote(g, name)
      assert.ok(note === undefined || note.length <= SEARCH_NOTE_MAX_CHARS, `length ${String(length)}: ${String(note?.length)} characters`)
      const hasSignature = note?.includes('(export function') ?? false
      const hasPointer = note?.includes('`codegraph_impact(') ?? false
      shapeOf.set(length, note === undefined ? 'nothing' : hasSignature ? 'full' : hasPointer ? 'no signature' : 'no pointer')
    }
    const order = ['full', 'no signature', 'no pointer', 'nothing'] as const
    const firstAt = order.map(shape => [...shapeOf].find(([, seen]) => seen === shape)?.[0])
    assert.ok(firstAt.every(at => at !== undefined), `every shape is reached; the first path length of each: ${JSON.stringify(firstAt)}`)
    assert.ok(
      firstAt[0]! < firstAt[1]! && firstAt[1]! < firstAt[2]! && firstAt[2]! < firstAt[3]!,
      `the shapes come in the order the budget dictates: ${JSON.stringify(firstAt)}`,
    )
    // Once a shape is left it never comes back: a shorter candidate always fits
    // where the longer one before it did not.
    let rank = 0
    for (const shape of shapeOf.values()) {
      const next = order.indexOf(shape)
      assert.ok(next >= rank, `the shape went back to "${shape}" after "${order[rank] ?? ''}"`)
      rank = next
    }
    // One example of each shape, stated in the terms a reader of the note sees.
    const at = (shape: (typeof order)[number]): string | undefined => {
      const length = firstAt[order.indexOf(shape)]
      return length === undefined ? undefined : searchNote(g, `n${String(length).padStart(4, '0')}`)
    }
    const full = at('full') ?? ''
    assert.match(full, /\(export function n/u)
    assert.match(full, /`codegraph_impact\("/u)
    const noSignature = at('no signature') ?? ''
    assert.doesNotMatch(noSignature, /\(export function/u)
    assert.match(noSignature, /`codegraph_impact\("/u, 'the pointer outlives the signature')
    const noPointer = at('no pointer') ?? ''
    assert.match(noPointer, /file\(s\)\.$/u, 'the counts are the last thing to go')
    assert.doesNotMatch(noPointer, /codegraph_impact/u)
    assert.equal(at('nothing'), undefined)
  })
})

describe('SearchNoteMemory', () => {
  it('answers true once per session and name, and false ever after', () => {
    const memory = new SearchNoteMemory()
    const session = {}
    assert.equal(memory.shouldNote(session, 'uniqueThing'), true)
    assert.equal(memory.shouldNote(session, 'uniqueThing'), false)
    assert.equal(memory.shouldNote(session, 'uniqueThing'), false)
    assert.equal(memory.shouldNote(session, 'other'), true, 'the rule is per name')
  })

  it('keeps sessions apart', () => {
    const memory = new SearchNoteMemory()
    const one = {}
    const two = {}
    assert.equal(memory.shouldNote(one, 'shared'), true)
    assert.equal(memory.shouldNote(two, 'shared'), true, 'a second session has not been told yet')
    assert.equal(memory.shouldNote(one, 'shared'), false)
  })

  it('gives every undefined session one shared entry', () => {
    const memory = new SearchNoteMemory()
    assert.equal(memory.shouldNote(undefined, 'shared'), true)
    assert.equal(memory.shouldNote(undefined, 'shared'), false, 'with no object to tell them apart, the second ask is a repeat')
    assert.equal(memory.shouldNote({}, 'shared'), true, 'and a real session is still its own')
  })

  it('stops remembering after 200 names but keeps answering true for new ones', () => {
    const memory = new SearchNoteMemory()
    const session = {}
    for (let i = 0; i < 200; i++) assert.equal(memory.shouldNote(session, `name${String(i)}`), true)
    assert.equal(memory.shouldNote(session, 'name0'), false, 'the first two hundred are remembered')
    assert.equal(memory.shouldNote(session, 'late'), true, 'the 201st is not remembered')
    assert.equal(memory.shouldNote(session, 'late'), true, 'so asking again is still a first ask')
  })

  it('treats surrounding whitespace as the same identifier', () => {
    const memory = new SearchNoteMemory()
    const session = {}
    assert.equal(memory.shouldNote(session, '  uniqueThing \n'), true)
    assert.equal(memory.shouldNote(session, 'uniqueThing'), false)
  })

  it('refuses a pattern that is not a bare identifier without spending a slot on it', () => {
    // A session can grep hundreds of patterns like `import .* from` before it asks
    // about one identifier; recording those would silently end the once-per-session
    // rule for every identifier that follows.
    const memory = new SearchNoteMemory()
    const session = {}
    for (const pattern of ['a.b', 'foo(', 'x|y', '']) assert.equal(memory.shouldNote(session, pattern), false, JSON.stringify(pattern))
    for (let i = 0; i < 200; i++) assert.equal(memory.shouldNote(session, `name${String(i)}`), true)
    assert.equal(memory.shouldNote(session, 'name0'), false, 'the cap went to identifiers only')
  })
})
