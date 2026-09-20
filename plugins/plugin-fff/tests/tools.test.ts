/**
 * Unit tests for the three FFF tools over a stub registrar and a stub finder:
 * the workspace fence (the root comes from the session, never from input),
 * the stable zh-CN failure values, the result shapes the renderers read, and
 * the renderers' own narrowing (an unrecognized value renders as no match
 * instead of throwing inside the client).
 *
 * @module @dsh-app/plugin-fff/tests/tools
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerFffTools } from '../src/tools.ts'

/** Capture the tool definitions as they register, like plugin-memory's stub. */
function stubCtx(): { ctx: never, tools: Map<string, ToolDef> } {
  const tools = new Map<string, ToolDef>()
  const ctx = {
    tools: {
      register(definition: ToolDef): () => void {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  return { ctx: ctx as never, tools }
}

interface ToolDef {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): { type: string, text: string }[] }
}

/** A finder whose three engines answer fixed results, or a fixed failure. */
function stubFinder(overrides: Record<string, unknown> = {}) {
  return {
    mixedSearch: () => ({
      ok: true,
      value: {
        totalMatched: 3,
        items: [
          { type: 'file', item: { relativePath: 'src/a.ts', fileName: 'a.ts', size: 12, modified: 1 } },
          { type: 'directory', item: { relativePath: 'src/', dirName: 'src' } },
        ],
      },
    }),
    grep: () => ({
      ok: true,
      value: {
        totalMatched: 1,
        nextCursor: null,
        totalFilesSearched: 7,
        items: [{
          relativePath: 'src/a.ts',
          fileName: 'a.ts',
          lineNumber: 42,
          col: 5,
          lineContent: 'const needle = 1',
          contextBefore: ['before line'],
          contextAfter: ['after line'],
        }],
      },
    }),
    glob: () => ({ ok: true, value: { totalMatched: 2, items: [{ relativePath: 'src/a.ts' }, { relativePath: 'src/b.ts' }] } }),
    ...overrides,
  }
}

/** A picker that hands the stub finder out for any workspace. */
function stubPicker(finder: unknown, result: { ok: boolean, error?: string } = { ok: true }) {
  return {
    acquire: (_key: string) => result.ok
      ? Promise.resolve({ ok: true, held: { finder, key: 'D:\\work', done: () => undefined } })
      : Promise.resolve({ ok: false, error: result.error ?? 'picker down' }),
  } as never
}

const EXEC = { agent: { session: { header: { cwd: 'D:\\work' } } } }
const NO_WORKSPACE = { agent: { session: { header: {} } } }

function registered(overrides?: { finder?: unknown, pickerResult?: { ok: boolean, error?: string } }) {
  const { ctx, tools } = stubCtx()
  registerFffTools(ctx, stubPicker(overrides?.finder ?? stubFinder(), overrides?.pickerResult), 5)
  return tools
}

interface Ok { ok: boolean, reason?: string, items?: unknown[], total?: number, basePath?: string }
const execOf = (tools: Map<string, ToolDef>, name: string) => tools.get(name)!.execute

test('all three tools register under their published names', () => {
  const tools = registered()
  assert.deepEqual([...tools.keys()].sort(), ['fff-glob', 'fffind', 'ffgrep'])
})

test('the workspace root comes from the session, never from arguments', async () => {
  const tools = registered()
  const find = await execOf(tools, 'fffind')({ query: 'a', cwd: '/etc' }, NO_WORKSPACE) as Ok
  assert.equal(find.ok, false)
  assert.match(find.reason ?? '', /工作区/u)
  // A session WITH a workspace reaches the finder; an argument naming another
  // directory is ignored by construction.
  const found = await execOf(tools, 'fffind')({ query: 'a', cwd: '/etc' }, EXEC) as Ok
  assert.equal(found.ok, true)
  assert.equal(found.basePath, 'D:\\work')
})

test('an empty query is a stable failure, not a thrown error', async () => {
  const tools = registered()
  for (const [name, args] of [['fffind', { query: '   ' }], ['ffgrep', { query: '' }], ['fff-glob', { pattern: ' ' }]] as const) {
    const res = await execOf(tools, name)(args, EXEC) as Ok
    assert.equal(res.ok, false, name)
    assert.equal(typeof res.reason, 'string')
    assert.ok((res.reason ?? '').length > 0, name)
  }
})

test('fffind maps the engine result and the renderer prints one line per match', async () => {
  const tools = registered()
  const value = await execOf(tools, 'fffind')({ query: 'a' }, EXEC)
  const result = value as Ok
  assert.equal(result.ok, true)
  assert.equal(result.total, 3)
  assert.equal(result.items?.length, 2)
  // A directory match renders with the `d` marker and no trailing slash.
  const text = tools.get('fffind')!.output.render({}, value)[0].text
  assert.equal(text.split('\n')[0], '[f] src/a.ts')
  assert.equal(text.split('\n')[1], '[d] src/')
  // `total > items.length` is what `truncated` says, and the renderer says so.
  assert.match(text, /还有更多匹配/u)
})

test('ffgrep renders the match line with context and clamps a runaway line', async () => {
  const tools = registered()
  const value = await execOf(tools, 'ffgrep')({ query: 'needle' }, EXEC)
  const result = value as Ok & { filesSearched?: number }
  // The engine's non-cursor fields travel through the narrowing untouched.
  assert.equal(result.filesSearched, 7)
  const text = tools.get('ffgrep')!.output.render({}, value)[0].text
  assert.equal(text.split('\n')[0], 'src/a.ts:42:5 const needle = 1')
  assert.equal(text.split('\n')[1], '      before line')
  assert.equal(text.split('\n')[2], '      after line')

  // A 400-character line is cut at 200 with an ellipsis, and the remainder is gone.
  const long = stubFinder({ grep: () => ({ ok: true, value: { totalMatched: 1, nextCursor: null, totalFilesSearched: 1, items: [{ relativePath: 'x', fileName: 'x', lineNumber: 1, col: 1, lineContent: 'y'.repeat(400) }] } }) })
  const longTools = registered({ finder: long })
  const longText = longTools.get('ffgrep')!.output.render({}, await execOf(longTools, 'ffgrep')({ query: 'y' }, EXEC))[0].text
  assert.equal(longText.split('x:1:1 ')[1], 'y'.repeat(200) + '…')
})

test('ffgrep says so when the engine has more matches than the page', async () => {
  // `nextCursor !== null` is what the tool reports as `more`; a kernel line
  // renaming that field would silently drop the hint (the fffind/fff-glob
  // truncation hints have their own coverage — this is ffgrep's).
  const paged = stubFinder({
    grep: () => ({
      ok: true,
      value: {
        totalMatched: 40,
        nextCursor: 'cursor-1',
        totalFilesSearched: 12,
        items: [{ relativePath: 'src/a.ts', fileName: 'a.ts', lineNumber: 1, col: 1, lineContent: 'needle' }],
      },
    }),
  })
  const tools = registered({ finder: paged })
  const value = await execOf(tools, 'ffgrep')({ query: 'needle' }, EXEC)
  assert.equal((value as { more?: boolean }).more, true)
  const text = tools.get('ffgrep')!.output.render({}, value)[0].text
  assert.match(text, /还有更多匹配（total 40）/u)
})

test('fff-glob reports truncation and renders bare relative paths', async () => {  const tools = registered()
  const value = await execOf(tools, 'fff-glob')({ pattern: '**/*.ts' }, EXEC)
  const result = value as Ok
  assert.equal(result.total, 2)
  assert.equal(result.truncated, false)
  assert.equal(tools.get('fff-glob')!.output.render({}, value)[0].text, 'src/a.ts\nsrc/b.ts')
  // Fewer items than the engine counted: truncated.
  const bounded = stubFinder({ glob: () => ({ ok: true, value: { totalMatched: 9, items: [{ relativePath: 'src/a.ts' }] } }) })
  const boundedTools = registered({ finder: bounded })
  const boundedText = boundedTools.get('fff-glob')!.output.render({}, await execOf(boundedTools, 'fff-glob')({ pattern: '**/*.ts' }, EXEC))[0].text
  assert.match(boundedText, /还有更多匹配/u)
})

test('a finder failure becomes an actionable reason with the engine detail', async () => {
  const tools = registered({ finder: stubFinder({ mixedSearch: () => ({ ok: false, error: 'index busy' }) }) })
  const res = await execOf(tools, 'fffind')({ query: 'a' }, EXEC) as Ok
  assert.equal(res.ok, false)
  assert.match(res.reason ?? '', /搜索失败/)
  assert.match(res.reason ?? '', /index busy/)
})

test('an engine failure on acquire never reaches the finder', async () => {
  const tools = registered({ pickerResult: { ok: false, error: 'scan timed out' } })
  const res = await execOf(tools, 'ffgrep')({ query: 'x' }, EXEC) as Ok
  assert.equal(res.ok, false)
  assert.match(res.reason ?? '', /scan timed out/)
})

test('the renderers narrow unknown values instead of throwing', () => {
  // A value the kernel hands the client that is not a result — a future line
  // changing the shape, or a different producer — renders as no match.
  for (const name of ['fffind', 'ffgrep', 'fff-glob']) {
    for (const value of [null, 'plain string', 42, { ok: false, reason: 'x' }, { ok: true }, { ok: true, items: 'not an array' }, { ok: true, items: [null, 7, 'x'] }]) {
      const text = registered().get(name)!.output.render({}, value)[0].text
      assert.equal(text, '无匹配', `${name} on ${JSON.stringify(value)}`)
    }
  }
  // Malformed items are dropped, valid ones survive.
  const mixed = registered().get('fffind')!.output.render({}, {
    ok: true, basePath: 'w', query: 'a', total: 9, truncated: true,
    items: [{ relativePath: 'keep.ts', isDir: false }, { isDir: true }, 'nope'],
  })[0].text
  assert.equal(mixed.split('\n')[0], '[f] keep.ts')
  assert.match(mixed, /还有更多匹配/u)
})
