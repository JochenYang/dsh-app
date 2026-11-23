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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { ANSWER_LIST_CHARS, ANSWER_LIST_TOKENS } from '../src/budget.ts'
import { handlerId, routeId } from '../src/synthesis.ts'
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
  // The three pairings no parse sees (synthesis.ts): an IPC channel spelled as a
  // constant on both sides, an event on a bus, a route and the fetch of its path.
  writeFileSync(join(root, 'src', 'channels.ts'), "export const PLATFORM_IPC = { open: 'platform:open', localeChanged: 'platform:locale-changed' }\n")
  writeFileSync(join(root, 'src', 'ipc.ts'), [
    "import { ipcMain, BrowserWindow } from 'electron'",
    "import { PLATFORM_IPC } from './channels'",
    '/** Opens a platform view. */',
    'export function onOpen(event: unknown, page: unknown): void {',
    '  void event',
    '  void page',
    '}',
    'export function install(): void {',
    '  ipcMain.handle(PLATFORM_IPC.open, onOpen)',
    "  ipcMain.handle('platform:bounds', (event, bounds: unknown): void => {",
    '    void event',
    '    void bounds',
    '  })',
    '}',
    'export function notifyLocale(view: BrowserWindow): void {',
    '  view.webContents.send(PLATFORM_IPC.localeChanged)',
    '}',
    "  ipcMain.handle('open', (event: unknown): void => {",
    '    void event',
    '  })',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'preload.ts'), [
    "import { ipcRenderer } from 'electron'",
    "import { PLATFORM_IPC } from './channels'",
    'export function open(page: unknown): Promise<void> {',
    '  return ipcRenderer.invoke(PLATFORM_IPC.open, page)',
    '}',
    'export function bounds(value: unknown): void {',
    "  ipcRenderer.send('platform:bounds', value)",
    '}',
    'export function onLocaleChanged(): void {',
    '  ipcRenderer.on(PLATFORM_IPC.localeChanged, () => {',
    '    void 0',
    '  })',
    '}',
    'export function openBare(page: unknown): Promise<void> {',
    "  return ipcRenderer.invoke('open', page)",
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'handlers.ts'), [
    'export function onCreated(user: unknown): void {',
    '  void user',
    '}',
    'export function listUsers(): unknown[] {',
    '  return []',
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'bus.ts'), [
    "import { onCreated } from './handlers'",
    'export function wire(bus: EventEmitter): void {',
    "  bus.on('user:created', onCreated)",
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'api.ts'), [
    "import { listUsers } from './handlers'",
    'export function mount(app: unknown): void {',
    "  app.get('/users', listUsers)",
    '}',
    'export function signup(bus: EventEmitter): void {',
    "  bus.emit('user:created', {})",
    '}',
  ].join('\n'))
  writeFileSync(join(root, 'src', 'client.ts'), [
    'export async function loadUsers(): Promise<unknown> {',
    "  return fetch('/users')",
    '}',
  ].join('\n'))
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
      assert.match(plain.text, /^- `caller` — `src\/caller\.ts:5` ✓: `return target\(x\) \+ target\(dup\(\)\)`$/mu, 'the import clause resolved this one, and the row carries the call')
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

  it('impact answers the call in place: every site line, the target source, and the files that moved', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    const agent = { session: { header: { cwd: root } } }
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 'target' }, { agent })
        return found.freshness === 'current' && (found.symbols as unknown[]).length === 1
      }, 'the first pass to settle')

      // SUFFICIENT: the call lines come from the callers' files, the callee's
      // own declaration rides along, and nothing is flagged on a current graph.
      const { value, text } = await answer(tools, 'codegraph_impact', { symbol: 'target' }, root)
      const rows = value.referencing as { path: string, line: number, name?: string, text?: string, drift?: boolean }[]
      assert.ok(rows.length >= 2)
      assert.equal(rows.every(row => row.text !== undefined && row.text !== ''), true, 'every row carries its line on a current graph')
      assert.equal(rows.every(row => row.drift === undefined), true, 'and none is flagged')
      assert.match(text, /^source — src\/target\.ts:2-4 \(verbatim, line-numbered/mu, 'the target is three lines, so it rides along')
      assert.match(text, /^2\tfunction target\(x: number\): number \{$/mu)
      assert.doesNotMatch(text, /⚠/u)
      assert.equal(value.pendingFiles, undefined, 'a current answer names nothing')
      assert.ok(text.length < 2_500, `the whole answer stays small: ${String(text.length)} characters`)

      // STALE AND NAMED: a caller's file gains a line above the call. The next
      // answer describes the previous state, names that file, and flags the
      // row whose line number now counts the old bytes.
      const callerFile = join(root, 'src', 'caller.ts')
      writeFileSync(callerFile, `// inserted\n${readFileSync(callerFile, 'utf8')}`)
      emit('tools/result', { name: 'write', agent } as never)
      const stale = await answer(tools, 'codegraph_impact', { symbol: 'target' }, root)
      assert.equal(stale.value.freshness, 'stale')
      assert.deepEqual(stale.value.pendingFiles, ['src/caller.ts'], 'the one cited file that moved')
      const first = stale.text.split('\n')[0] ?? ''
      assert.match(first, /^⚠️ 1 file\(s\) this answer cites changed since it was indexed \(src\/caller\.ts\)/u)
      const moved = (stale.value.referencing as { path: string, drift?: boolean }[]).find(row => row.path === 'src/caller.ts')
      assert.equal(moved?.drift, true, 'the row says its line counts the old bytes')
      assert.match(stale.text, /⚠ file changed since it was indexed/u)

      // find and context say the same thing about the same file — the symbol
      // branch through its callers, the overview through its hubs (the caller is
      // one of the most-referenced symbols), and a deeper tree through its nodes.
      const found = await answer(tools, 'codegraph_find', { query: 'caller' }, root)
      assert.equal(found.value.freshness, 'stale')
      assert.deepEqual(found.value.pendingFiles, ['src/caller.ts'])
      const context = await answer(tools, 'codegraph_context', { symbol: 'target' }, root)
      assert.deepEqual(context.value.pendingFiles, ['src/caller.ts'], 'the symbol branch cites its callers too')
      const overview = await answer(tools, 'codegraph_context', {}, root)
      assert.deepEqual(overview.value.pendingFiles, ['src/caller.ts'], 'the overview cites its hubs')
      assert.match(overview.text, /^⚠️ 1 file\(s\) this answer cites changed since it was indexed \(src\/caller\.ts\)/u)
      const tree = await answer(tools, 'codegraph_impact', { symbol: 'target', depth: 2 }, root)
      assert.deepEqual(tree.value.pendingFiles, ['src/caller.ts'], 'the caller tree cites its nodes')
    } finally {
      await dispose()
    }
  })

  it('joins the two sides of a channel, an event and a route, and marks every join', async () => {
    const { root } = fixture()
    writeProject(root)
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    const agent = { session: { header: { cwd: root } } }
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const found = await tools.get('codegraph_find')!.execute({ query: 'onOpen' }, { agent })
        return found.freshness === 'current' && (found.symbols as unknown[]).length === 1
      }, 'the first pass to settle')

      // IPC: the preload's `invoke` is a caller of the main-process handler, by the
      // constant both files import; the dispatch line rides the row like any other.
      const open = await answer(tools, 'codegraph_impact', { symbol: 'onOpen' }, root)
      const rows = open.value.referencing as { path: string, line: number, name?: string, provenance?: string, narrowed?: boolean, text?: string }[]
      assert.deepEqual(rows.map(row => [row.name, row.path, row.line, row.provenance, row.narrowed]), [['open', 'src/preload.ts', 4, 'ipc', undefined]])
      assert.match(rows[0]?.text ?? '', /ipcRenderer\.invoke\(PLATFORM_IPC\.open, page\)/u)
      assert.match(open.text, /^- `open` — `src\/preload\.ts:4` ⇢ ipc: `/mu)
      assert.match(open.text, /^\(⇢ ipc = a SYNTHESIZED edge/mu)
      assert.doesNotMatch(open.text, / ✓/u, 'nothing here resolved a name')

      // The inline handler is a declaration now, findable by the id the route and
      // handler ids are made of, and the second channel reaches it.
      const inline = handlerId('src/ipc.ts', 'platform:bounds')
      const bounds = await answer(tools, 'codegraph_impact', { symbol: inline }, root)
      assert.deepEqual((bounds.value.referencing as { name?: string, path: string, provenance?: string }[]).map(row => [row.name, row.path, row.provenance]), [['bounds', 'src/preload.ts', 'ipc']])
      assert.equal((bounds.value.target as { kind: string }).kind, 'handler')
      assert.equal((bounds.value.source as { endLine: number }).endLine, 13, 'the declaration spans the registering call')

      // The reverse channel: a renderer-side listener, sent to from the main
      // process. And the depth-2 tree carries the same mark as the list.
      const locale = await answer(tools, 'codegraph_impact', { symbol: handlerId('src/preload.ts', 'PLATFORM_IPC.localeChanged') }, root)
      assert.deepEqual((locale.value.referencing as { name?: string, provenance?: string }[]).map(row => [row.name, row.provenance]), [['notifyLocale', 'ipc']])
      const deep = await answer(tools, 'codegraph_impact', { symbol: 'onOpen', depth: 2 }, root)
      const root0 = (deep.value.callers as { roots: { name: string, provenance?: string }[] }).roots[0]
      assert.deepEqual([root0?.name, root0?.provenance], ['open', 'ipc'])
      assert.match(deep.text, /^- src\/preload\.ts:4 function open ⇢ ipc$/mu)

      // A key that spells a real function's name: the synthesized handler is a
      // declaration `find` lists and an id resolves, but no NAME lookup sees it —
      // `impact('open')` is the function, not "declared twice".
      const found = await answer(tools, 'codegraph_find', { query: 'open' }, root)
      const exact = (found.value.symbols as { name: string, kind: string }[]).filter(row => row.name === 'open')
      assert.deepEqual(exact.map(row => row.kind).sort(), ['function', 'handler'], '`find` lists every kind, the synthesized one beside the parsed one')
      const byName = await answer(tools, 'codegraph_impact', { symbol: 'open' }, root)
      assert.equal((byName.value.target as { kind: string }).kind, 'function')
      const handlerByName = await answer(tools, 'codegraph_context', { symbol: handlerId('src/ipc.ts', 'open') }, root)
      assert.deepEqual((handlerByName.value.calledBy as { provenance?: string }[]).map(row => row.provenance), ['ipc'])
      // The `path` of a `calledBy` row is the caller's id for a symbol caller —
      // a pre-existing shape, left as it is; the mark is what this case is for.
      assert.match(handlerByName.text, /^called by:\n- src\/preload\.ts#function:openBare:15 ⇢ ipc$/mu, 'the context answer marks the same edge the impact answer does')
      assert.match(handlerByName.text, /\(⇢ ipc = a SYNTHESIZED edge/u)

      // The event pairs on the bus and the name; the route is a declaration the
      // fetch points at, and the route points at its handler.
      const created = await answer(tools, 'codegraph_impact', { symbol: 'onCreated' }, root)
      assert.deepEqual((created.value.referencing as { name?: string, provenance?: string }[]).map(row => [row.name, row.provenance]), [['signup', 'event']])
      const route = routeId('src/api.ts', 'get', '/users')
      const users = await answer(tools, 'codegraph_impact', { symbol: route }, root)
      assert.deepEqual((users.value.referencing as { name?: string, path: string, provenance?: string }[]).map(row => [row.name, row.path, row.provenance]), [['loadUsers', 'src/client.ts', 'route']])
      assert.equal((users.value.target as { kind: string, name: string }).kind, 'route')
      const listed = await answer(tools, 'codegraph_impact', { symbol: 'listUsers' }, root)
      assert.deepEqual((listed.value.referencing as { name?: string, provenance?: string }[]).map(row => [row.name, row.provenance]), [['GET /users', 'route']])
      assert.match(listed.text, /^- `GET \/users` — `src\/api\.ts:3` ⇢ route: `app\.get\('\/users', listUsers\)`$/mu)
    } finally {
      await dispose()
    }
  })
})
