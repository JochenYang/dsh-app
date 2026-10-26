/**
 * The kernel's REAL schema validation, on the answers the tools actually produce.
 *
 * `tool-output.test.ts` proves the answers survive `snapshotJsonValue`, which is the
 * step that rejects a value holding `undefined`. It does NOT prove they satisfy the
 * declared output schema — and this round added three new fields to `codegraph_impact`
 * (`lists`, plus `total`/`truncated` per relationship group), each of which is a way to
 * fail the whole answer: the registry's `additionalProperties: false` turns one
 * undeclared or missing property into `INVALID_TOOL_OUTPUT`, which the model sees as a
 * broken tool rather than as a wrong number.
 *
 * So this suite drives the tool through the REAL `defineTool` + the installed
 * `validateJsonSchemaValue`, on the four shapes that matter: a resolved target, an
 * ambiguous name, a cut imports list, and a cut relationship group. Nothing here
 * hand-writes a schema: the schema under test is the one the plugin registered.
 *
 * @module plugin-codegraph/tests/schema-validation
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

/** Scratch roots this suite created, removed on the way out. */
const scratch: string[] = []
const previousHome = process.env.DSH_HOME

after(() => {
  for (const dir of scratch.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** A registered tool as `apply` left it: the compiled schema plus the real executor. */
interface RegisteredTool {
  readonly name: string
  readonly output: { readonly schema: JsonSchemaNode }
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
}

/** The minimal Context `apply` reads. */
function fakeContext() {
  const tools = new Map<string, RegisteredTool>()
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    tools: {
      register(tool: RegisteredTool): () => void {
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
  }
  return { ctx, tools, emit: ctx.emit, dispose: async () => { for (const dispose of disposers.splice(0)) await dispose() } }
}

/** A temp project plus a DSH home of its own. */
function fixture(): { root: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cg-schema-'))
  scratch.push(base)
  const root = join(base, 'project')
  mkdirSync(join(root, 'src'), { recursive: true })
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

/**
 * Run one tool and assert its answer against the schema IT declared.
 *
 * The assertion is the point: `validateJsonSchemaValue` is the function the registry
 * itself uses, so an empty list here means the registry would have accepted this value.
 * A non-empty list is printed whole, because a schema failure names the property.
 */
async function callAndValidate(
  tools: Map<string, RegisteredTool>,
  name: string,
  args: unknown,
  cwd: string,
): Promise<Record<string, unknown>> {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, `${name} is registered`)
  const value = await tool.execute(args, { agent: { session: { header: { cwd } } } })
  // `undefined`-valued keys are dropped at the tool boundary, exactly as the kernel's
  // snapshot step requires; the schema is validated on THAT shape.
  const json = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  const problems = validateJsonSchemaValue(tool.output.schema, json)
  assert.deepEqual(problems, [], `${name} output must satisfy its own declared schema:\n${problems.join('\n')}\nvalue: ${JSON.stringify(json).slice(0, 2000)}`)
  return json
}

describe('the registered output schemas accept the real answers', () => {
  it('codegraph_impact: a resolved target with every list present', async () => {
    // The shape the schema change is about. `lists` is a NEW optional object and each
    // relationship group gained two optional fields; an undeclared one fails the WHOLE
    // answer, so this is where a schema/type drift shows up as a broken tool.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'lib.ts'), [
      'export function shared(): number { return 1 }',
      'export function caller(): number { return shared() }',
    ].join('\n'))
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const value = await tools.get('codegraph_find')!.execute({ query: 'shared' }, { agent: { session: { header: { cwd: root } } } })
        return value.freshness === 'current' && (value.symbols as unknown[]).length > 0
      }, 'the first pass to settle')

      const impact = await callAndValidate(tools, 'codegraph_impact', { symbol: 'shared' }, root)
      assert.notEqual(impact.target, undefined, 'the name resolves')
      // The per-list metadata the schema now declares must be THERE, not merely allowed:
      // the render reads it, and a missing `lists` would silently fall back to guesses.
      const lists = impact.lists as { references: { shown: number, truncated: boolean }, imports: { shown: number, truncated: boolean } }
      assert.equal(typeof lists.references.shown, 'number')
      assert.equal(typeof lists.references.truncated, 'boolean')
      assert.equal(typeof lists.imports.shown, 'number')
      assert.equal(typeof lists.imports.truncated, 'boolean')
    } finally {
      await dispose()
    }
  })

  it('codegraph_impact: an ambiguous name (candidates, no target)', async () => {
    // The branch with the fewest fields and the most optionality: `target` absent,
    // `candidates` populated, `ambiguity` a number. It used to render "no reference
    // edges were built"; the schema has to accept the new answer shape too.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function dup(): number { return 1 }\n')
    writeFileSync(join(root, 'src', 'b.ts'), 'export function dup(): number { return 2 }\n')
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const value = await tools.get('codegraph_find')!.execute({ query: 'dup' }, { agent: { session: { header: { cwd: root } } } })
        return value.freshness === 'current' && (value.symbols as unknown[]).length === 2
      }, 'both declarations to be indexed')

      const impact = await callAndValidate(tools, 'codegraph_impact', { symbol: 'dup' }, root)
      assert.equal(impact.target, undefined, 'an ambiguous name resolves to no target')
      assert.equal((impact.candidates as unknown[]).length, 2)
      assert.equal(impact.ambiguity, 2)
    } finally {
      await dispose()
    }
  })

  it('codegraph_impact: a CUT imports list and a CUT relationship group', async () => {
    // The two cuts this round added metadata for. Built by hand at the query layer's
    // limit — 45 imports and 45 implementers — so both `lists.imports.truncated` and the
    // group's own `total`/`truncated` are exercised through the REAL execute path.
    const { root } = fixture()
    // 45 modules the target file imports, and 45 classes implementing one interface.
    const imports = Array.from({ length: 45 }, (_, index) => `import { v${String(index)} } from './dep${String(index)}'`).join('\n')
    writeFileSync(join(root, 'src', 'target.ts'), `${imports}\nexport interface Contract { run(): void }\n`)
    for (let index = 0; index < 45; index += 1) {
      writeFileSync(join(root, 'src', `dep${String(index)}.ts`), `export const v${String(index)} = ${String(index)}\n`)
      writeFileSync(join(root, 'src', `impl${String(index)}.ts`), [
        "import type { Contract } from './target'",
        `export class C${String(index)} implements Contract { run(): void {} }`,
      ].join('\n'))
    }
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const value = await tools.get('codegraph_find')!.execute({ query: 'Contract' }, { agent: { session: { header: { cwd: root } } } })
        return value.freshness === 'current' && (value.symbols as unknown[]).length > 0
      }, 'the first pass to settle')

      const impact = await callAndValidate(tools, 'codegraph_impact', { symbol: 'Contract' }, root)
      const lists = impact.lists as { imports: { shown: number, total?: number, truncated: boolean } }
      assert.equal(lists.imports.truncated, true, '45 imports exceed the 40-row budget')
      assert.equal(lists.imports.shown, 40)
      assert.equal(lists.imports.total, 45)
      const groups = impact.related as { kind: string, total?: number, truncated: boolean }[]
      const implementsGroup = groups.find(group => group.kind === 'implements')
      assert.ok(implementsGroup !== undefined, 'the implements group is present')
      assert.equal(implementsGroup.truncated, true, '45 implementers exceed the budget')
      assert.equal(implementsGroup.total, 45)
      // The aggregate still says something was cut, which is what older consumers read.
      assert.equal(impact.truncated, true)
    } finally {
      await dispose()
    }
  })

  it('codegraph_find and codegraph_context still satisfy their schemas', async () => {
    // The two tools this round did not change the schema of. Included because a change
    // to a shared helper (`listMetaSchema`, `dropUndefined`) would land here first.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'lib.ts'), 'export function only(): number { return 1 }\n')
    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const value = await tools.get('codegraph_find')!.execute({ query: 'only' }, { agent: { session: { header: { cwd: root } } } })
        return value.freshness === 'current' && (value.symbols as unknown[]).length > 0
      }, 'the first pass to settle')

      await callAndValidate(tools, 'codegraph_find', { query: 'only' }, root)
      await callAndValidate(tools, 'codegraph_context', {}, root)
      await callAndValidate(tools, 'codegraph_context', { symbol: 'src/lib.ts' }, root)
      await callAndValidate(tools, 'codegraph_context', { symbol: 'only' }, root)
    } finally {
      await dispose()
    }
  })
})
