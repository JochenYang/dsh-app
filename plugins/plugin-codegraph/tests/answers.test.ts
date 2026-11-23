/**
 * The three tools' answers on REAL files, from the real grammar to the text.
 *
 * `tool-text.test.ts` asserts sentences on hand-built values and `query.test.ts`
 * asserts the query layer on hand-built edges; neither proves that a signature
 * the parser extracted is the signature a row prints, that the level `execute`
 * chose is the level the first line names, or that a value carrying every v5
 * field survives the schema the kernel enforces on it. `e2e.test.ts` stops at the
 * query layer. This suite is the seam between the two: it writes a small project
 * in real TypeScript, lets `apply` index it with the real grammar, runs each
 * tool's `execute` and then its `render`, and reads the text the model would.
 *
 * The three files are sized to the detail ladder's bands (20, 45 and 80
 * declarations), so the level each one lands on is the rule working on real
 * rows, not a synthetic `measure`.
 *
 * @module plugin-codegraph/tests/answers
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { ANSWER_LIST_CHARS, ANSWER_LIST_TOKENS } from '../src/budget.ts'
import { removeTree } from '../../../scripts/lib/remove-tree.mjs'

/** Scratch roots this suite created, removed on the way out. */
const scratch: string[] = []
const previousHome = process.env.DSH_HOME

after(async () => {
  for (const dir of scratch.splice(0)) {
    try { await removeTree(dir) } catch { /* best effort */ }
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** One registered tool: its compiled schema, its renderer and its executor. */
interface ToolDef {
  readonly name: string
  readonly output: {
    readonly schema: JsonSchemaNode
    render(args: unknown, value: unknown): { type: 'text', text: string }[]
  }
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
}

/**
 * The minimal Context `apply` reads, recording every registration. The same
 * shape `freshness.test.ts` and `schema-validation.test.ts` drive the real
 * indexer with.
 */
function fakeContext() {
  const tools = new Map<string, ToolDef>()
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    tools: {
      register(tool: ToolDef): () => void {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
    },
    connection: { fetch: { register(): () => Promise<void> { return async () => {} } } },
    systemPrompt: { context(): () => void { return () => {} } },
    on(event: string, listener: (...args: never[]) => void): () => void {
      const list = listeners.get(event)
      if (list === undefined) listeners.set(event, [listener])
      else list.push(listener)
      return () => {
        const current = listeners.get(event) ?? []
        const at = current.indexOf(listener)
        if (at >= 0) current.splice(at, 1)
      }
    },
    emit(event: string, ...args: never[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    effect(body: () => (() => void) | (() => Promise<void>)): void {
      disposers.push(body())
    },
    /** Cordis's optional-injection door; every service exists in this fake. */
    inject(_deps: readonly string[], callback: (scope: unknown) => void): void {
      callback(this)
    },
  }
  return {
    ctx,
    tools,
    emit: ctx.emit,
    dispose: async () => { for (const dispose of disposers.splice(0)) await dispose() },
  }
}

/** A temp project directory plus a DSH home of its own. */
function fixture(): { root: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cg-answers-'))
  scratch.push(base)
  const root = join(base, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(base, 'home'), { recursive: true })
  process.env.DSH_HOME = join(base, 'home')
  return { root }
}

/** Wait until `check` answers true, or fail after a bounded time. */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 40_000): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
}

/** `count` documented, exported functions with a real signature, one per two lines. */
function functions(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => [
    `/** ${prefix}${String(index)} adds one. The rest is detail. */`,
    `export function ${prefix}${String(index)}(a: number): number {`,
    `  return a + ${String(index)}`,
    '}',
  ].join('\n')).join('\n')
}

/**
 * Write the project. Every file is real TypeScript the grammar reads: a chain
 * target <- caller <- outer (so `depth` has two levels to walk), a test file
 * that calls the target inside a declaration and another that calls it at top
 * level (both kinds of reference the tests group counts), a method inside a
 * class (a signature with no parent in it), and a name two files declare that a
 * third calls without importing (a call that resolves to two declarations).
 */
function writeProject(root: string): void {
  writeFileSync(join(root, 'src', 'target.ts'), '/** The shared helper. */\nfunction target(x: number): number {\n  return x\n}\n')
  writeFileSync(join(root, 'src', 'caller.ts'), [
    "import { target } from './target'",
    "import { dup } from './shared'",
    '/** Calls the target twice. */',
    'function caller(x: number): number {',
    '  return target(x) + target(dup())',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'outer.ts'), [
    "import { caller } from './caller'",
    'export function outer(): number {',
    '  return caller(1) + dup()',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'shared.ts'), 'function dup(): number {\n  return 1\n}\n')
  writeFileSync(join(root, 'src', 'also-shared.ts'), 'function dup(): number {\n  return 2\n}\n')
  writeFileSync(join(root, 'src', 'widget.ts'), [
    '/** A widget. */',
    'export class Widget {',
    '  /** Adds. */',
    '  add(x: number): number { return x }',
    '',
    '  remove(): void {}',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'tests', 'target.test.ts'), [
    "import { target } from '../src/target'",
    'export function checksTarget(): void {',
    '  target(1)',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'tests', 'top.test.ts'), "import { target } from '../src/target'\ntarget(2)\n")
  // The three sizes the detail ladder is written around.
  writeFileSync(join(root, 'src', 's.ts'), functions(20, 's'))
  writeFileSync(join(root, 'src', 'm.ts'), functions(45, 'm'))
  writeFileSync(join(root, 'src', 'l.ts'), functions(80, 'l'))
}

/** Run one tool, assert its answer against the schema IT declared, and render it. */
async function answer(
  tools: Map<string, ToolDef>,
  name: string,
  args: unknown,
  root: string,
): Promise<{ value: Record<string, unknown>, text: string }> {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, `${name} is registered`)
  const value = await tool.execute(args, { agent: { session: { header: { cwd: root } } } })
  const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  const problems = validateJsonSchemaValue(tool.output.schema, json)
  assert.deepEqual(problems, [], `${name} output must satisfy its own declared schema:\n${problems.join('\n')}`)
  const blocks = tool.output.render(args, json)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  return { value: json, text: blocks[0]!.text }
}

/** The first line's `~N/1200 tokens`, and the rows below it as text. */
function outlineFacts(text: string): { tokens: number, rows: string, lines: string[] } {
  const lines = text.split('\n')
  const head = lines[0] ?? ''
  const tokens = /~(\d+)\/1200 tokens$/u.exec(head)
  assert.ok(tokens !== null, `the first line ends with the size: ${head}`)
  const last = lines.indexOf('Pass any id above as `symbol` to expand it, or use `codegraph_impact` for what a change would touch.')
  assert.ok(last > 0, 'the outline closes with its invitation')
  const rows = lines.slice(1, last).filter(line => line.startsWith('- '))
  return { tokens: Number(tokens[1]), rows: rows.join('\n'), lines }
}

describe('the three answers on real files', () => {
  it('find leads a short list with the signature the parser extracted', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 'target' }, { agent: { session: { header: { cwd: root } } } })
        return found.freshness === 'current' && (found.symbols as unknown[]).length > 0
      }, 'the first pass to settle')

      const found = await answer(tools, 'codegraph_find', { query: 'target' }, root)
      const rows = (found.value.symbols as { signature?: string }[])
      assert.equal(rows.length, 1, 'one declaration of `target` in this project')
      assert.equal(rows[0]?.signature, 'function target(x: number): number', 'the head, body and comment stripped')
      assert.equal(found.text.split('\n')[1], '- function target(x: number): number — src/target.ts:2 — 3 call site(s) (id: src/target.ts#function:target)')
    } finally {
      await dispose()
    }
  })

  it('a 20-row outline lands on full, with signatures and summaries, inside the budget', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 's19' }, { agent: { session: { header: { cwd: root } } } })
        return found.freshness === 'current' && (found.symbols as unknown[]).length === 1
      }, 'the first pass to settle')

      const { value, text } = await answer(tools, 'codegraph_context', { symbol: 'src/s.ts' }, root)
      const file = value.file as { detail: string, cut?: number, symbols: { signature?: string, doc?: string }[] }
      assert.equal(file.detail, 'full')
      assert.equal(file.cut, undefined, '20 rows fit; nothing was dropped')
      assert.equal(file.symbols.length, 20)
      assert.ok(file.symbols.every(symbol => symbol.signature !== undefined && symbol.doc !== undefined), 'every row carries its head and its summary')
      const facts = outlineFacts(text)
      assert.match(facts.lines[0] ?? '', /^codegraph_context: src\/s\.ts declares 20 symbol\(s\) · detail: full · ~\d+\/1200 tokens$/u)
      assert.ok(facts.tokens <= ANSWER_LIST_TOKENS, `${String(facts.tokens)} tokens is over the budget`)
      assert.ok(facts.rows.length <= ANSWER_LIST_CHARS, `${String(facts.rows.length)} characters is over the budget`)
      assert.match(facts.rows, /^- function s0\(a: number\): number :2 — 0 call site\(s\) \[exported\] \(id: src\/s\.ts#function:s0\) — s0 adds one\.$/mu)
    } finally {
      await dispose()
    }
  })

  it('a 45-row outline lands on signatures, and an 80-row one on names', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 'l79' }, { agent: { session: { header: { cwd: root } } } })
        return found.freshness === 'current' && (found.symbols as unknown[]).length === 1
      }, 'the first pass to settle')

      const medium = await answer(tools, 'codegraph_context', { symbol: 'src/m.ts' }, root)
      const mediumFile = medium.value.file as { detail: string, cut?: number, symbols: { signature?: string, doc?: string }[] }
      assert.equal(mediumFile.detail, 'signatures')
      assert.equal(mediumFile.cut, undefined)
      assert.equal(mediumFile.symbols.length, 45)
      // The rows still carry the doc in the JSON — the level decides what is
      // PRINTED, and `detail: full` on the same file would print it.
      assert.ok(mediumFile.symbols.every(symbol => symbol.signature !== undefined && symbol.doc !== undefined))
      const mediumFacts = outlineFacts(medium.text)
      assert.match(mediumFacts.lines[0] ?? '', / · detail: signatures · ~\d+\/1200 tokens$/u)
      assert.match(mediumFacts.rows, /^- function m0\(a: number\): number :2 — 0 call site\(s\) \[exported\] \(id: src\/m\.ts#function:m0\)$/mu)
      assert.doesNotMatch(mediumFacts.rows, / adds one\. /u, 'no summary at this level')
      assert.ok(mediumFacts.tokens <= ANSWER_LIST_TOKENS)
      assert.ok(mediumFacts.rows.length <= ANSWER_LIST_CHARS)

      const large = await answer(tools, 'codegraph_context', { symbol: 'src/l.ts' }, root)
      const largeFile = large.value.file as { detail: string, cut?: number, symbols: unknown[] }
      assert.equal(largeFile.detail, 'names')
      assert.equal(largeFile.symbols.length, 80)
      const largeFacts = outlineFacts(large.text)
      assert.match(largeFacts.lines[0] ?? '', / · detail: names · ~\d+\/1200 tokens$/u)
      assert.match(largeFacts.rows, /^- function l0:2 \(id: src\/l\.ts#function:l0\)$/mu)
      assert.doesNotMatch(largeFacts.rows, /\(a: number\)/u)
      assert.ok(largeFacts.tokens <= ANSWER_LIST_TOKENS)

      // The requested level is honoured when it fits, and stepped down when not.
      const forced = await answer(tools, 'codegraph_context', { symbol: 'src/s.ts', detail: 'names' }, root)
      assert.equal((forced.value.file as { detail: string }).detail, 'names')
      const wanted = await answer(tools, 'codegraph_context', { symbol: 'src/l.ts', detail: 'full' }, root)
      assert.equal((wanted.value.file as { detail: string }).detail, 'names', '80 rows at full cannot fit, and the budget wins')
    } finally {
      await dispose()
    }
  })

  it('a symbol\u2019s siblings and calls carry heads; a shared callee keeps a bare row', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 'caller' }, { agent: { session: { header: { cwd: root } } } })
        return found.freshness === 'current' && (found.symbols as unknown[]).length === 1
      }, 'the first pass to settle')

      // `caller` imports both of its callees, so each resolves to one declaration.
      const { value, text } = await answer(tools, 'codegraph_context', { symbol: 'caller' }, root)
      const calls = value.calls as { name?: string, signature?: string }[]
      assert.equal(calls.find(edge => edge.name === 'target')?.signature, 'function target(x: number): number')
      assert.equal(calls.find(edge => edge.name === 'dup')?.signature, 'function dup(): number', 'the import clause picks one of the two `dup`s')
      assert.match(text, /^- target at line 5 — function target\(x: number\): number$/mu)
      assert.match(text, /^- dup at line 5 — function dup\(\): number$/mu)
      assert.match(text, /^same file \(1\):$/mu)
      assert.match(text, /^- function caller\(x: number\): number — src\/caller\.ts:4$/mu)

      // `outer` calls `dup` with no clause to say which one: two targets on the
      // same line as a call that DOES resolve, and only the unresolved one goes bare.
      const outer = await answer(tools, 'codegraph_context', { symbol: 'outer' }, root)
      const outerCalls = outer.value.calls as { name?: string, signature?: string }[]
      assert.equal(outerCalls.find(edge => edge.name === 'caller')?.signature, 'function caller(x: number): number')
      assert.equal(outerCalls.find(edge => edge.name === 'dup')?.signature, undefined, 'a name declared twice, called with no import, has no one signature')
      assert.match(outer.text, /^- caller at line 3 — function caller\(x: number\): number$/mu)
      assert.match(outer.text, /^- dup at line 3$/mu)

      // A class file: the method's row leads with `Widget.add`, the head the
      // grammar read inside the class, with the parent put back in front.
      const widget = await answer(tools, 'codegraph_context', { symbol: 'src/widget.ts' }, root)
      assert.match(widget.text, /^- Widget\.add\(x: number\): number :4 — 0 call site\(s\) \(id: src\/widget\.ts#method:Widget\.add\) — Adds\.$/mu)
      assert.match(widget.text, /^- class Widget :2 — 0 call site\(s\) \[exported\] \(id: src\/widget\.ts#class:Widget\) — A widget\.$/mu)
    } finally {
      await dispose()
    }
  })

  it('impact groups the tests, marks the resolved references and walks two levels when asked', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 'target' }, { agent: { session: { header: { cwd: root } } } })
        return found.freshness === 'current' && (found.symbols as unknown[]).length === 1
      }, 'the first pass to settle')

      // The default call: no tree, and the shape the model already knew.
      const plain = await answer(tools, 'codegraph_impact', { symbol: 'target' }, root)
      assert.equal('callers' in plain.value, false, 'depth 1 adds no tree')
      assert.doesNotMatch(plain.text, /Callers up to depth/u)
      assert.match(plain.text, /^Tests that reference this \(2 file\(s\)\) — run these first:$/mu)
      assert.match(plain.text, /^- tests\/target\.test\.ts$/mu)
      assert.match(plain.text, /^- tests\/top\.test\.ts$/mu, 'a top-level call in a test file counts too')
      assert.match(plain.text, /^- src\/caller\.ts:5 ✓$/mu, 'the import clause resolved this one')
      assert.match(plain.text, /^\(✓ = resolved by a same-file declaration or an import clause; unmarked rows are name matches\.\)$/mu)

      const deep = await answer(tools, 'codegraph_impact', { symbol: 'target', depth: 2 }, root)
      const tree = deep.value.callers as { depth: number, nodes: number, truncated: boolean, roots: { name: string, children: { name: string }[] }[] }
      assert.equal(tree.depth, 2)
      // Roots sit at the line of their first call: the test's at line 3, the
      // caller's at line 5.
      assert.deepEqual(tree.roots.map(rootNode => [rootNode.name, rootNode.children.map(child => child.name)]), [['checksTarget', []], ['caller', ['outer']]])
      assert.match(deep.text, /^Callers up to depth 2 \(3 node\(s\)\):$/mu)
      assert.match(deep.text, /^- tests\/target\.test\.ts:3 function checksTarget$/mu)
      assert.match(deep.text, /^- src\/caller\.ts:5 function caller$/mu)
      assert.match(deep.text, /^  - src\/outer\.ts:3 function outer$/mu)

      // Past the ceiling: clamped, not refused.
      const clamped = await answer(tools, 'codegraph_impact', { symbol: 'target', depth: 99 }, root)
      assert.equal((clamped.value.callers as { depth: number }).depth, 3)
    } finally {
      await dispose()
    }
  })
})
