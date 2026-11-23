/**
 * The pushed overview, wired: what `apply` mounts, driven against a real project
 * on disk and the real queue.
 *
 * `prompt.test.ts` pins how one block renders and `overview-state.test.ts` pins
 * the rule that decides which text a session gets. This is the seam between them
 * and the plugin: that the provider feeds the stabilizer the right KIND of text,
 * reads the layout, counts a change, and keeps a session's block still through a
 * re-index that changed the project. A wrong mapping here (a `stale` state handed
 * over as `status`, the layout never read) would pass both of those suites.
 *
 * The DSH home is redirected to a scratch directory for the whole file: the
 * plugin derives its storage root from it, and a test must never create a graph
 * under the user's real one.
 *
 * @module plugin-codegraph/tests/overview-wiring
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { apply } from '../src/index.ts'
import { removeTree } from '../src/remove-tree.ts'
import { ROUTE_PREFIX } from '../src/routes.ts'

const scratch: string[] = []
const previousHome = process.env.DSH_HOME

before(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cg-home-'))
  scratch.push(home)
  process.env.DSH_HOME = home
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  // The sanctioned walker, not a sync recursive delete: this fixture holds a
  // SQLite graph, and `test/recursive-delete-guard.test.mjs` audits every
  // `rmSync({ recursive: true })` under `plugins/*/tests/` by count.
  for (const dir of scratch.splice(0)) {
    try { await removeTree(dir) } catch { /* best effort */ }
  }
})

/** A small project: two directories, so the layout line has something to say. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cg-proj-'))
  scratch.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'src', 'util.ts'), 'export function helper(value: number): number {\n  return value + 1\n}\n')
  writeFileSync(join(root, 'src', 'main.ts'), "import { helper } from './util'\nexport function run(): number {\n  return helper(1)\n}\n")
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\nRun `main.ts`.\n')
  return root
}

/** The minimal Context `apply` reads, with the two registrations this file observes. */
function host() {
  const definitions = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const routes: ConnectionFetchRoute[] = []
  const contexts = new Map<string, { text: (assembly: unknown) => string, interpolate: boolean | undefined }>()
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    tools: {
      register(tool: never): () => void {
        definitions.set((tool as { name: string }).name, tool as never)
        return () => undefined
      },
    },
    connection: {
      fetch: {
        register(route: ConnectionFetchRoute): () => Promise<void> {
          routes.push(route)
          return async () => undefined
        },
      },
    },
    systemPrompt: {
      context(spec: { name: string, text: (assembly: unknown) => string, interpolate?: boolean }): () => void {
        contexts.set(spec.name, { text: spec.text, interpolate: spec.interpolate })
        return () => undefined
      },
    },
    on(event: string, listener: (...args: never[]) => void): () => void {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => undefined
    },
    inject(_deps: readonly string[], callback: (scope: unknown) => void): void { callback(this) },
    effect(body: () => (() => void) | (() => Promise<void>)): void { disposers.push(body()) },
  }
  return { ctx, definitions, routes, contexts, listeners, dispose: async () => { for (const dispose of disposers.splice(0)) await dispose() } }
}

interface StatusRow {
  readonly cwd: string
  readonly state: string
  readonly indexedAt: number
  readonly usage: Record<string, number>
}

/** The project's status row, read through the route the settings page uses. */
async function statusRow(routes: readonly ConnectionFetchRoute[], cwd: string): Promise<StatusRow | undefined> {
  const route = routes.find(candidate => candidate.path === `${ROUTE_PREFIX}/status`)
  assert.ok(route !== undefined, 'the status route is registered')
  const response = await route.fetch(new Request('dsh-app://app/x'))
  const body = await response.json() as { value?: { projects?: StatusRow[] } }
  return body.value?.projects?.find(row => row.cwd === cwd)
}

/** Wait until the project's graph settles after a change (≤ `ms`). */
async function settled(routes: readonly ConnectionFetchRoute[], cwd: string, ms = 20_000): Promise<StatusRow> {
  const until = Date.now() + ms
  let last: StatusRow | undefined
  while (Date.now() < until) {
    last = await statusRow(routes, cwd)
    if (last?.state === 'current') return last
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  assert.fail(`the graph of ${cwd} did not settle: last state ${String(last?.state)}`)
}

describe('the pushed overview, wired', () => {
  it('feeds the stabilizer, reads the layout, takes a first change at once and holds the second inside the interval', async () => {
    const cwd = project()
    const h = host()
    apply(h.ctx as never)
    try {
      const agent = { session: { header: { cwd } } }
      h.listeners.get('session/created')?.[0]?.({ header: { cwd } } as never)
      await settled(h.routes, cwd)

      const text = h.contexts.get('dsh-app:codegraph:overview')?.text
      assert.ok(text !== undefined, 'the overview context is registered')
      // Before any session asked: the queue may still report the first pass.
      const first = text({ agent })
      assert.match(first, /^Code graph for this project \(/u, 'a settled project gets its shape, not a status sentence')
      assert.match(first, /Top-level layout \(indexed files\): src 2, docs 1\./u, 'the layout line is read from the graph')
      assert.match(first, /^- src\/main\.ts \(starts at function run\)$/mu, 'an entry row carries no line number')
      assert.equal(text({ agent }), first, 'the same session, the same text')
      // Both contexts are literal text: a path with `{{name}}` in it must reach the
      // model as a path, not as a prompt variable the renderer throws on.
      assert.equal(h.contexts.get('dsh-app:codegraph:overview')?.interpolate, false, 'the overview is not interpolated')
      assert.equal(h.contexts.get('dsh-app:codegraph:request')?.interpolate, false, 'nor is the request pack')

      // A RE-INDEX that changes the project, waited for by `indexedAt`: the state
      // stays `current` through the debounce, so waiting on the state proves
      // nothing. The FIRST change of a session is taken at once (the interval
      // measures between changes, `overview-state.test.ts`); the second, inside
      // the interval, is held.
      const edited = async (name: string): Promise<void> => {
        const before = (await statusRow(h.routes, cwd))?.indexedAt
        writeFileSync(join(cwd, 'src', name), `export const ${name.slice(0, -3)} = 1\n`)
        h.listeners.get('tools/result')?.[0]?.({ name: 'write', agent } as never)
        const until = Date.now() + 20_000
        while (Date.now() < until) {
          const row = await statusRow(h.routes, cwd)
          if (row !== undefined && row.state === 'current' && row.indexedAt !== before) return
          await new Promise(resolve => setTimeout(resolve, 40))
        }
        assert.fail(`the re-index after ${name} did not land`)
      }
      await edited('extra.ts')
      const afterFirst = text({ agent })
      assert.notEqual(afterFirst, first, 'the first real change of a session is taken at once')
      assert.match(afterFirst, /Top-level layout \(indexed files\): src 3, docs 1\./u, 'and it is the new shape')
      assert.equal((await statusRow(h.routes, cwd))?.usage.overviewChanges, 1)
      await edited('more.ts')
      assert.equal(text({ agent }), afterFirst, 'a second change inside the interval is held')
      assert.equal((await statusRow(h.routes, cwd))?.usage.overviewChanges, 1, 'nothing was adopted, so nothing was counted')

      // The tools count, through the same `/status` row.
      const find = h.definitions.get('codegraph_find')
      assert.ok(find !== undefined)
      await find.execute({ query: 'helper' }, { agent } as never)
      assert.equal((await statusRow(h.routes, cwd))?.usage.find, 1)
    } finally {
      await h.dispose()
    }
  })
})
