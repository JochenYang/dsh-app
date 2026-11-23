/**
 * The request prefetch, on a real graph: what a request has to name to earn a
 * pack, how strictly a name is resolved, what the pack says, and where its
 * budget cuts.
 *
 * The fixtures go through the plugin's own `openGraph` / `replaceFile`, so every
 * resolution is the SQL that ships: an exact `files.path`, the unique-suffix
 * `LIKE`, a `symbols.name` with exactly one row, the `exports` and `references`
 * counts. Hand-written rows keep each case to the fact it pins — a shared name,
 * two files with one basename, a document — without a parse in between.
 *
 * @module plugin-codegraph/tests/prefetch
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PREFETCH_MAX_CHARS, buildPrefetchPack, requestTokens } from '../src/prefetch.ts'
import { fileNodeId, openGraph, replaceFile, type EdgeRecord, type FileRecord, type Graph, type SymbolKind, type SymbolRecord } from '../src/store.ts'
import { removeTree } from '../../../scripts/lib/remove-tree.mjs'

const scratch: string[] = []
const graphs: Graph[] = []

after(async () => {
  // Closed before the removal: an open handle makes a delete fail on Windows.
  for (const graph of graphs.splice(0)) {
    try { graph.close() } catch { /* already closed */ }
  }
  for (const dir of scratch.splice(0)) await removeTree(dir)
})

function graph(): Graph {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cg-pf-'))
  scratch.push(dir)
  const opened = openGraph(join(dir, 'graph.db'))
  graphs.push(opened)
  return opened
}

const file = (path: string, lang = 'typescript'): FileRecord => ({ path, mtime: 1, size: 1, hash: 'h', lang })

interface Decl {
  readonly line?: number
  readonly parent?: string
  readonly kind?: SymbolKind
  readonly signature?: string
}

/** A declaration row with the id shape the parser mints; a method's kind follows its parent. */
function decl(path: string, name: string, options: Decl = {}): SymbolRecord {
  const kind = options.kind ?? (options.parent === undefined ? 'function' : 'method')
  const id = options.parent === undefined ? `${path}#${kind}:${name}` : `${path}#${kind}:${options.parent}.${name}`
  const line = options.line ?? 1
  return { id, path, name, kind, line, endLine: line, parent: options.parent, signature: options.signature ?? '' }
}

const ref = (from: string, to: string, line = 1): EdgeRecord => ({ from, to, kind: 'references', line })
const exp = (path: string, to: string, line = 1): EdgeRecord => ({ from: fileNodeId(path), to, kind: 'exports', line })

/** A head near the parser's 200-character ceiling, so eight rows of them overflow the budget. */
const LONG_HEAD = `function head(x: ${'a'.repeat(180)}): void`

/** The lines of a pack that are a declaration row. */
const rows = (text: string): string[] => text.split('\n').filter(line => line.startsWith('- '))

/** Every line that is neither the framing nor a row: the file headers and the symbol lines. */
const HEADS = /^(?:\S+ \(\d+ declarations; `codegraph_context\("[^"]*"\)` gives the outline\):|symbol `[^`]+` — )/u

describe('requestTokens', () => {
  it('normalises a path: a leading ./ goes and backslashes become slashes', () => {
    assert.deepEqual(requestTokens(String.raw`see ./a\b.ts and .\x\y.md`), ['a/b.ts', 'x/y.md'])
  })

  it('finds the five shapes — path, camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE — in first-mention order', () => {
    assert.deepEqual(
      requestTokens('src/a.ts docs/guide.md plugins/x/package.json fooBar MyStore foo_bar MAX_RETRIES'),
      ['src/a.ts', 'docs/guide.md', 'plugins/x/package.json', 'fooBar', 'MyStore', 'foo_bar', 'MAX_RETRIES'],
    )
  })

  it('takes a SCREAMING_SNAKE constant for a name, and a lone capital word for prose', () => {
    // `LEDGER_DAY_LIMIT` is how a constant or a configuration key is written; `Store`
    // and `The` are words, and the calibration pattern leaves them out on purpose.
    assert.deepEqual(requestTokens('raise LEDGER_DAY_LIMIT; keep Store and The'), ['LEDGER_DAY_LIMIT'])
  })

  it('stays linear on a hump word with no end boundary, so a pasted line cannot stall the kernel', { timeout: 2_000 }, () => {
    // A hump that could absorb capitals (`[a-zA-Z0-9]*`) let the engine re-partition
    // `AAAA…` on every failure: 580 ms at 26 letters, hours at forty. A capital now
    // always opens the next hump, so the word has one parse and yields nothing. The
    // clock is asserted because a test timeout cannot interrupt a synchronous match.
    const word = `a${'A'.repeat(80)}_`
    const started = performance.now()
    assert.deepEqual(requestTokens(word), [])
    assert.deepEqual(requestTokens(`Aa${'A'.repeat(80)}_`), [])
    assert.ok(performance.now() - started < 500, `two scans of the worst family took ${String(performance.now() - started)} ms`)
  })

  it('deduplicates on the normalised form and keeps the first mention', () => {
    assert.deepEqual(requestTokens('b.ts a.ts ./b.ts b.ts'), ['b.ts', 'a.ts'])
  })

  it('looks at the first 14 tokens of a request and no more', () => {
    const names = Array.from({ length: 20 }, (_, index) => `tok${String.fromCharCode(65 + Math.floor(index / 26))}${String(index)}Var`)
    assert.deepEqual(requestTokens(names.join(' ')), names.slice(0, 14))
  })

  it('drops product names the patterns match and no project declares', () => {
    assert.deepEqual(requestTokens('DeepSeek GitHub PowerShell TypeScript JavaScript OpenAI'), [])
  })

  it('takes the callee of a call, without its parentheses or its arguments', () => {
    assert.deepEqual(requestTokens('fooBar(a, b) and MyStore.create(x) and foo()'), ['fooBar', 'MyStore'])
  })

  it('yields nothing for Chinese prose, English prose or blank input', () => {
    assert.deepEqual(requestTokens('\u8bf7\u4fee\u590d\u767b\u5f55\u6d41\u7a0b\uff0c\u518d\u52a0\u4e00\u4e2a\u6d4b\u8bd5'), [])
    assert.deepEqual(requestTokens('please fix the login flow and add a test'), [])
    assert.deepEqual(requestTokens(''), [])
    assert.deepEqual(requestTokens('  \n\t '), [])
  })

  it('does not read a project-relative path out of an absolute one or a URL', () => {
    assert.deepEqual(requestTokens(String.raw`/home/u/p/src/a.ts C:\p\src\a.ts C:/p/src/a.ts D:/p/src/a.ts https://x.test/src/a.ts`), [])
  })

  it('keeps a ../ path as a token; resolution is what refuses it', () => {
    assert.deepEqual(requestTokens('../src/a.ts'), ['../src/a.ts'])
  })

  it('finds a path beside punctuation, a #L anchor, a :line suffix and a scoped package name', () => {
    assert.deepEqual(
      requestTokens(String.raw`(src/a.ts) ` + '`src/a.ts#L12`' + String.raw` src\a.ts:12 @dsh-app/plugin-x/src/prefetch.ts`),
      ['src/a.ts', 'dsh-app/plugin-x/src/prefetch.ts'],
    )
  })
})

describe('buildPrefetchPack: the gate', () => {
  it('attaches a pack for a file the graph holds', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    const pack = buildPrefetchPack(g, 'please look at src/a.ts')
    assert.ok(pack !== undefined, 'a held file earns a pack')
    assert.equal(pack.files, 1)
    assert.equal(pack.symbols, 0)
    assert.match(pack.text, /^src\/a\.ts \(1 declarations; /mu)
  })

  it('attaches a pack for an identifier with exactly one declaration', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    const pack = buildPrefetchPack(g, 'please make doThing faster')
    assert.ok(pack !== undefined, 'a unique name earns a pack')
    assert.equal(pack.files, 0)
    assert.equal(pack.symbols, 1)
    assert.match(pack.text, /^symbol `doThing` — function at src\/a\.ts:7 /mu)
  })

  it('carries both parts for a request that names a file and a name', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    replaceFile(g.db, file('src/b.ts'), [decl('src/b.ts', 'otherThing', { line: 2 })], [])
    const pack = buildPrefetchPack(g, 'src/a.ts calls otherThing, check it')
    assert.ok(pack !== undefined)
    assert.equal(pack.files, 1)
    assert.equal(pack.symbols, 1)
    assert.match(pack.text, /^src\/a\.ts \(1 declarations; /mu)
    assert.match(pack.text, /^symbol `otherThing` — function at src\/b\.ts:2 /mu)
  })

  it('attaches nothing for a name declared in several places', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'runTask', { line: 1 })], [])
    replaceFile(g.db, file('src/b.ts'), [decl('src/b.ts', 'runTask', { line: 1 })], [])
    assert.equal(buildPrefetchPack(g, 'fix runTask please'), undefined)
  })

  it('attaches nothing for a request with no code-shaped token', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    assert.equal(buildPrefetchPack(g, '\u8bf7\u628a\u767b\u5f55\u6d41\u7a0b\u4fee\u4e00\u4e0b'), undefined)
    assert.equal(buildPrefetchPack(g, 'the login page is broken, please fix it'), undefined)
  })

  it('attaches nothing for an empty request, whitespace, or an empty graph', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    assert.equal(buildPrefetchPack(g, ''), undefined)
    assert.equal(buildPrefetchPack(g, '  \n '), undefined)
    assert.equal(buildPrefetchPack(graph(), 'src/a.ts and doThing'), undefined)
  })
})

describe('buildPrefetchPack: resolution', () => {
  it('matches an exact path first, and a bare name through a unique suffix', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'one', { line: 1 })], [])
    replaceFile(g.db, file('lib/deep/a.ts'), [decl('lib/deep/a.ts', 'two', { line: 1 })], [])

    const exact = buildPrefetchPack(g, 'src/a.ts')
    assert.ok(exact !== undefined)
    assert.equal(exact.files, 1)
    assert.match(exact.text, /^src\/a\.ts /mu)

    const bare = buildPrefetchPack(g, 'src/b.ts is gone, what about deep/a.ts?')
    assert.equal(bare, undefined, 'a suffix two files share is ambiguity')

    replaceFile(g.db, file('src/only.ts'), [decl('src/only.ts', 'three', { line: 1 })], [])
    const unique = buildPrefetchPack(g, 'open only.ts')
    assert.ok(unique !== undefined, 'one file ends in /only.ts')
    assert.match(unique.text, /^src\/only\.ts /mu)
  })

  it('does not count a document, by exact path or by suffix', () => {
    const g = graph()
    replaceFile(g.db, file('docs/guide.md', 'document'), [], [])
    assert.equal(buildPrefetchPack(g, 'read docs/guide.md'), undefined)
    assert.equal(buildPrefetchPack(g, 'read guide.md'), undefined)
  })

  it('does not resolve an absolute path, a drive path or a ../ path, though the file is in the graph', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    assert.equal(buildPrefetchPack(g, '/home/u/p/src/a.ts'), undefined)
    assert.equal(buildPrefetchPack(g, String.raw`C:\p\src\a.ts`), undefined)
    assert.equal(buildPrefetchPack(g, 'C:/p/src/a.ts'), undefined)
    assert.equal(buildPrefetchPack(g, '../src/a.ts'), undefined)
  })

  it('resolves a path-shaped token as a file only, never also as a name', () => {
    const g = graph()
    replaceFile(g.db, file('src/foo_bar.ts'), [decl('src/foo_bar.ts', 'inside', { line: 1 })], [])
    replaceFile(g.db, file('lib/x.ts'), [decl('lib/x.ts', 'foo_bar', { line: 1 })], [])
    const pack = buildPrefetchPack(g, 'look at foo_bar.ts')
    assert.ok(pack !== undefined)
    assert.equal(pack.files, 1)
    assert.equal(pack.symbols, 0, 'the token named the file; the same spelling elsewhere is not looked up')
  })

  it('counts a file once when the request names it twice', () => {
    const g = graph()
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    const pack = buildPrefetchPack(g, 'src/a.ts, and a.ts too')
    assert.ok(pack !== undefined)
    assert.equal(pack.files, 1)
  })

  it('lets a file with no declarations take no slot', () => {
    const g = graph()
    replaceFile(g.db, file('src/empty.ts'), [], [])
    replaceFile(g.db, file('src/a.ts'), [decl('src/a.ts', 'doThing', { line: 7 })], [])
    assert.equal(buildPrefetchPack(g, 'look at empty.ts'), undefined)
    const pack = buildPrefetchPack(g, 'empty.ts and a.ts')
    assert.ok(pack !== undefined)
    assert.equal(pack.files, 1)
    assert.doesNotMatch(pack.text, /empty\.ts/u)
  })
})

describe('buildPrefetchPack: limits and budget', () => {
  it('keeps the first three files and the first three symbols of a request that names more', () => {
    const g = graph()
    for (let index = 1; index <= 6; index += 1) {
      replaceFile(g.db, file(`src/f${String(index)}.ts`), [decl(`src/f${String(index)}.ts`, `file${String(index)}Fn`, { line: 1 })], [])
    }
    const names = ['symOne', 'symTwo', 'symThree', 'symFour', 'symFive', 'symSix', 'symSeven', 'symEight']
    replaceFile(g.db, file('lib/s.ts'), names.map((name, index) => decl('lib/s.ts', name, { line: index + 1 })), [])

    const request = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', ...names].join(' ')
    const pack = buildPrefetchPack(g, request)
    assert.ok(pack !== undefined)
    assert.equal(pack.files, 3)
    assert.equal(pack.symbols, 3)
    for (const kept of ['src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'symOne', 'symTwo', 'symThree']) assert.match(pack.text, new RegExp(kept.replace(/\./gu, '\\.'), 'u'))
    for (const dropped of ['src/f4.ts', 'src/f5.ts', 'src/f6.ts', 'symFour', 'symFive', 'symSix', 'symSeven', 'symEight']) assert.doesNotMatch(pack.text, new RegExp(dropped, 'u'))
    assert.ok(pack.text.length <= PREFETCH_MAX_CHARS)
  })

  it('shows at most eight rows of a file, and says how many declarations it has', () => {
    const g = graph()
    const many = Array.from({ length: 12 }, (_, index) => decl('src/many.ts', `entry${String(index)}`, { line: index + 1 }))
    replaceFile(g.db, file('src/many.ts'), many, [])
    const pack = buildPrefetchPack(g, 'what does src/many.ts declare?')
    assert.ok(pack !== undefined)
    assert.match(pack.text, /^src\/many\.ts \(12 declarations; /mu)
    assert.equal(rows(pack.text).length, 8)
  })

  it('cuts rows before it drops an item', () => {
    const g = graph()
    const big = Array.from({ length: 8 }, (_, index) => decl('src/big.ts', `big${String(index)}`, { line: index + 1, signature: LONG_HEAD }))
    replaceFile(g.db, file('src/big.ts'), big, [])
    const pack = buildPrefetchPack(g, 'src/big.ts')
    assert.ok(pack !== undefined)
    assert.equal(pack.files, 1, 'the one item is kept')
    assert.equal(pack.symbols, 0)
    assert.equal(rows(pack.text).length, 5, 'eight heads near 200 characters do not fit; five do')
    assert.match(pack.text, /function head\(x: a{180}\): void :5 /u)
    assert.doesNotMatch(pack.text, /:6 /u)
    assert.ok(pack.text.length <= PREFETCH_MAX_CHARS)
  })

  it('drops the last item once rows cannot go lower, a symbol before any file', () => {
    const g = graph()
    for (const name of ['f1', 'f2', 'f3']) {
      replaceFile(
        g.db,
        file(`src/${name}.ts`),
        ['Alpha', 'Beta', 'Gamma'].map((suffix, index) => decl(`src/${name}.ts`, `${name}${suffix}`, { line: index + 1, signature: LONG_HEAD })),
        [],
      )
    }
    const names = ['symOne', 'symTwo', 'symThree']
    replaceFile(g.db, file('lib/s.ts'), names.map((name, index) => decl('lib/s.ts', name, { line: index + 1, signature: LONG_HEAD })), [])

    const pack = buildPrefetchPack(g, 'f1.ts f2.ts f3.ts symOne symTwo symThree')
    assert.ok(pack !== undefined)
    assert.ok(pack.text.length <= PREFETCH_MAX_CHARS)
    assert.ok(pack.files + pack.symbols < 6, 'the budget bit')
    assert.ok(pack.files === 3 || pack.symbols === 0, 'a symbol is dropped before any file is')
    const filePaths = ['src/f1.ts', 'src/f2.ts', 'src/f3.ts']
    for (const [index, path] of filePaths.entries()) {
      const pattern = new RegExp(`^${path.replace(/\./gu, '\\.')} \\(3 declarations; `, 'mu')
      if (index < pack.files) assert.match(pack.text, pattern)
      else assert.doesNotMatch(pack.text, pattern)
    }
    for (const [index, name] of names.entries()) {
      const pattern = new RegExp(`^symbol \`${name}\` `, 'mu')
      if (index < pack.symbols) assert.match(pack.text, pattern)
      else assert.doesNotMatch(pack.text, pattern)
    }
  })

  it('refuses the pack when the framing and one item cannot fit', () => {
    const g = graph()
    replaceFile(g.db, file('lib/s.ts'), [decl('lib/s.ts', 'symOne', { line: 1, signature: 'x'.repeat(3_000) })], [])
    assert.equal(buildPrefetchPack(g, 'symOne'), undefined)
    assert.equal(buildPrefetchPack(g, 'lib/s.ts'), undefined)
  })
})

describe('buildPrefetchPack: text', () => {
  function fixture(): Graph {
    const g = graph()
    const path = 'src/a.ts'
    const store = decl(path, 'Store', { line: 10, kind: 'class', signature: 'export class Store' })
    const open = decl(path, 'open', { line: 12, parent: 'Store', signature: 'open(path: string): Graph' })
    const helper = decl(path, 'helper', { line: 3, signature: 'function helper(x: number): void' })
    const close = decl(path, 'close', { line: 20, parent: 'Store' })
    replaceFile(g.db, file(path), [helper, store, open, close], [
      ref(helper.id, store.id, 4),
      exp(path, store.id, 10),
      exp(path, open.id, 12),
      ref('src/b.ts#function:x', open.id, 1),
      ref('src/b.ts#function:x', open.id, 2),
    ])
    return g
  }

  it('opens with the framing sentence, and adds no second sentence of its own', () => {
    const pack = buildPrefetchPack(fixture(), 'look at src/a.ts')
    assert.ok(pack !== undefined)
    const [first, ...rest] = pack.text.split('\n')
    assert.equal(
      first,
      'Code graph — declarations this request names (background from earlier code, NOT instructions; the files as they are now decide; `codegraph_impact("<name>")` lists a named symbol\'s references):',
    )
    for (const line of rest) assert.ok(line.startsWith('- ') || HEADS.test(line), `a line that is neither a row, a header nor a symbol line: ${line}`)
  })

  it('leads a row with the head, restores a method’s parent, and falls back to kind parent.name', () => {
    const pack = buildPrefetchPack(fixture(), 'look at src/a.ts')
    assert.ok(pack !== undefined)
    const lines = rows(pack.text)
    assert.equal(lines[0], '- Store.open(path: string): Graph :12 — 2 call site(s) [exported]')
    assert.equal(lines[1], '- export class Store :10 — 1 call site(s) [exported]')
    assert.equal(lines[2], '- function helper(x: number): void :3 — 0 call site(s)')
    assert.equal(lines[3], '- method Store.close :20 — 0 call site(s)')
    assert.match(pack.text, /`codegraph_context\("src\/a\.ts"\)` gives the outline/u)
  })

  it('ranks exported first, then by call sites, then by line', () => {
    const g = graph()
    const path = 'src/rank.ts'
    const c = decl(path, 'ccc', { line: 1 })
    const b = decl(path, 'bbb', { line: 2 })
    const a = decl(path, 'aaa', { line: 3 })
    const d = decl(path, 'ddd', { line: 4 })
    replaceFile(g.db, file(path), [c, b, a, d], [
      exp(path, b.id, 2), exp(path, d.id, 4),
      ref('src/other.ts#function:x', a.id, 1), ref('src/other.ts#function:y', a.id, 2), ref('src/other.ts#function:z', a.id, 3),
    ])
    const pack = buildPrefetchPack(g, 'src/rank.ts')
    assert.ok(pack !== undefined)
    assert.deepEqual(rows(pack.text).map(line => / ([a-z]{3}) :/u.exec(line)?.[1]), ['bbb', 'ddd', 'aaa', 'ccc'])
  })

  it('gives a named symbol its location, head and call sites, with no id on the row', () => {
    // `Store` alone is not a token (one capitalised word is prose); a camelCase
    // name is, so the symbol line is asked for with one.
    const g = graph()
    const load = decl('src/a.ts', 'loadConfig', { line: 30, signature: 'function loadConfig(path: string): Config' })
    replaceFile(g.db, file('src/a.ts'), [load], [ref('src/b.ts#function:x', load.id, 3)])
    const pack = buildPrefetchPack(g, 'src/a.ts and loadConfig')
    assert.ok(pack !== undefined)
    assert.equal(pack.symbols, 1)
    assert.equal(
      pack.text.split('\n').at(-1),
      'symbol `loadConfig` — function at src/a.ts:30 — function loadConfig(path: string): Config — 1 call site(s)',
      'no id on the row: the name is unique by construction, and the framing sentence names the call',
    )
    assert.match(pack.text.split('\n')[0] ?? '', /`codegraph_impact\("<name>"\)` lists a named symbol's references/u)
  })
})
