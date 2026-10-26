/**
 * The freshness promise, end to end: an uncommitted edit reaches the graph.
 *
 * This is the suite for the defect that motivated the whole round. `isStale`
 * compares Git HEAD, and a session's own edits do not move HEAD — so the graph kept
 * answering from before the edit while reporting `current`, the one failure mode that
 * looks authoritative. Nothing else in the suite could see it: `indexer.test.ts`
 * proves the stat comparison works when a pass RUNS, `queue.test.ts` proves the state
 * machine, and both are green while nothing ever starts the pass.
 *
 * So these cases drive the real `apply()` with the real indexer and the real grammar,
 * over a temp project that is NOT a git repository (the hardest case: no HEAD on
 * either side, so the HEAD comparison can never be the thing that notices). What is
 * asserted is what a model sees: the `freshness` field of a tool answer and the
 * symbol a query returns.
 *
 * @module plugin-codegraph/tests/freshness
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'

/** Scratch roots this suite created, removed on the way out. */
const scratch: string[] = []
/** The DSH home this suite pointed the plugin at, restored afterwards. */
const previousHome = process.env.DSH_HOME

after(() => {
  for (const dir of scratch.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** A tool definition as `defineTool` produced it, narrowed to what these cases call. */
interface ToolDef {
  readonly name: string
  execute(args: unknown, exec: { agent: { session: { header: { cwd: string } } } }): Promise<Record<string, unknown>>
}

/**
 * The minimal Context `apply` reads: tools, routes, the prompt context and the events
 * the plugin subscribes to. Every registration is recorded, and `emit` fires one
 * event at the listeners the plugin actually installed — which is what makes the
 * `tools/result` path testable at all.
 */
function fakeContext() {
  const tools = new Map<string, ToolDef>()
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const disposers: (() => void | Promise<void>)[] = []
  /** The registered routes, so the settings page's delete action is reachable. */
  const routes = new Map<string, { path: string, fetch: (request: Request) => Promise<Response> }>()
  const ctx = {
    tools: {
      register(tool: ToolDef): () => void {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
    },
    connection: {
      fetch: {
        register(route: { path: string, fetch: (request: Request) => Promise<Response> }): () => Promise<void> {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    systemPrompt: {
      context(): () => void { return () => {} },
    },
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
  return {
    ctx,
    tools,
    routes,
    emit: ctx.emit,
    dispose: async () => { for (const dispose of disposers.splice(0)) await dispose() },
  }
}

/** A temp project directory plus a DSH home of its own. */
function fixture(): { root: string, home: string } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-cg-fresh-'))
  scratch.push(base)
  const root = join(base, 'project')
  const home = join(base, 'home')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  return { root, home }
}

/** Wait until `check` answers true, or fail with the reason after a bounded time. */
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
}

/** A `tools/result` payload for one settled call in a session. */
function toolResult(name: string, cwd: string): { name: string, agent: { session: { header: { cwd: string } } } } {
  return { name, agent: { session: { header: { cwd } } } }
}

/** The project's own answer for one name. */
async function find(tools: Map<string, ToolDef>, cwd: string, query: string): Promise<Record<string, unknown>> {
  const tool = tools.get('codegraph_find')
  assert.ok(tool !== undefined, 'codegraph_find is registered')
  return await tool.execute({ query }, { agent: { session: { header: { cwd } } } })
}

/** The names a `find` answer carries. */
function names(answer: Record<string, unknown>): string[] {
  return (answer.symbols as { name: string }[]).map(symbol => symbol.name)
}

describe('freshness after an uncommitted edit', () => {
  it('indexes the edit a non-codegraph tool result reported, and returns to current', async () => {
    // THE SCENARIO. A session writes a file. HEAD does not move. Nothing else in the
    // pipeline knows the graph is behind: the stored `head` still matches, the file
    // comparison only runs inside a pass, and no pass is scheduled. So the graph keeps
    // answering `current` from the previous bytes — measured shape of the bug, and the
    // reason the tool result, not Git, has to be the trigger.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'lib.ts'), 'export function before(): number { return 1 }\n')

    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      // A session enters the project: `session/created` is what starts the first pass.
      emit('session/created', { header: { cwd: root } } as never)
      // Wait for the FIRST PASS TO SETTLE, not merely for a row to appear: a pass
      // writes symbols as it goes, so "the row is there" can be true while the entry is
      // still `indexing`. Editing in that window is a real scenario (and covered by the
      // compensating-pass case), but this case is about the settled state.
      await until(async () => {
        const answer = await find(tools, root, 'before')
        return answer.freshness === 'current' && names(answer).includes('before')
      }, 'the first pass to settle')

      // The edit. Same file, same directory, no commit, no tool that knows about the
      // graph — exactly what a `write` or `edit` call produces.
      writeFileSync(join(root, 'src', 'lib.ts'), 'export function after(): number { return 2 }\n')
      emit('tools/result', toolResult('write', root) as never)

      // The answer must NOT claim `current` from the moment the change is reported —
      // that is the whole defect. It may legitimately say `indexing` (a check proved the
      // change and a pass is running) or `stale` (the pass has not settled); what it must
      // never say is that a graph describing the old bytes is current.
      const immediate = await find(tools, root, 'after')
      assert.notEqual(immediate.freshness, 'current', 'a reported change must not be reported as current')

      // Then the debounced check runs, proves the change, and the pass indexes it.
      await until(async () => {
        const answer = await find(tools, root, 'after')
        return names(answer).includes('after') && answer.freshness === 'current'
      }, 'the edit to reach the graph')

      // The retired name is gone, which is what proves the file was re-parsed rather
      // than merely re-queried: an exact-name lookup for a removed declaration answers
      // nothing.
      assert.deepEqual(names(await find(tools, root, 'before')), [], 'the pre-edit declaration no longer exists')
    } finally {
      await dispose()
    }
  })

  it('treats any tool name as a possible write, not a list of writers', async () => {
    // The rule is "some tool settled in this project", not "this was a file write".
    // A `shell` command that ran a formatter, a `run_code` dispatch that wrote through
    // an ordinary Node call, and a plugin's own tool that renames files all change the
    // tree without being named `write` — a name-based trigger covers the three shapes
    // somebody thought of and misses the fourth.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function first(): number { return 1 }\n')

    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const answer = await find(tools, root, 'first')
        return answer.freshness === 'current' && names(answer).includes('first')
      }, 'the first pass')

      writeFileSync(join(root, 'src', 'a.ts'), 'export function second(): number { return 2 }\n')
      emit('tools/result', toolResult('shell', root) as never)
      assert.notEqual((await find(tools, root, 'first')).freshness, 'current', 'a shell result must not leave the graph claiming currency over changed bytes')

      await until(async () => names(await find(tools, root, 'second')).includes('second'), 'a non-write tool result to trigger the scan')
    } finally {
      await dispose()
    }
  })

  it('does not turn a current graph stale for read-only tool results', async () => {
    // THE DEFECT THIS SUITE EXISTS FOR NOW. A `Read`, a `Grep` and a passing test run are
    // all tool results, and the first implementation marked the project `stale` for every
    // one of them. Two costs, both real: the model was told the graph was behind when it
    // was not, and each query re-armed the same path, so a read-only session walked the
    // tree on every debounce window and reported work nobody did.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function stable(): number { return 1 }\n')

    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const answer = await find(tools, root, 'stable')
        return answer.freshness === 'current' && names(answer).includes('stable')
      }, 'the first pass to settle')

      // Twenty read-only results, the shape of a session that is reading and grepping.
      for (let index = 0; index < 20; index += 1) {
        emit('tools/result', toolResult('read', root) as never)
        // A query between results: it must not restart anything either.
        const answer = await find(tools, root, 'stable')
        assert.equal(answer.freshness, 'current', `answer ${String(index)} must stay current: nothing changed`)
      }
      // Past every debounce window and every check re-run.
      await new Promise(resolve => { setTimeout(resolve, 1500) })
      const settled = await find(tools, root, 'stable')
      assert.equal(settled.freshness, 'current', 'and it is still current after the checks ran')
      assert.deepEqual(names(settled), ['stable'])
    } finally {
      await dispose()
    }
  })

  it('does not report a current, complete graph when the project root cannot be read', async () => {
    // THE DEFECT THIS CASE EXISTS FOR. `scanProject` reports `rootUnreadable` when the
    // root's own `readdir` fails, and `projectChanged` used to answer `false` for it —
    // "unchanged" — so the queue kept the project `current` with no `removalSkipped` and
    // the model was told the graph had been checked and was complete. Neither half is
    // true: nothing was compared.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function anchored(): number { return 1 }\n')

    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const answer = await find(tools, root, 'anchored')
        return answer.freshness === 'current' && names(answer).includes('anchored')
      }, 'the first pass to settle')

      // The root disappears while the graph (which lives under DSH_HOME) stays open.
      rmSync(root, { recursive: true, force: true })
      emit('tools/result', toolResult('read', root) as never)

      // Whatever the answer is, it must NOT be an unqualified `current`: a check that
      // could not read the tree must not report the graph as verified and complete.
      const answer = await find(tools, root, 'anchored')
      assert.notEqual(answer.freshness, 'current', 'an unreadable root is not "unchanged"')
      if (answer.freshness === 'stale') {
        assert.match(String(answer.note ?? ''), /detected|re-index|previous state/u, 'and the note says why')
      } else {
        assert.equal(answer.freshness, 'indexing')
        assert.notEqual(answer.note, undefined, 'an incomplete answer carries a note')
      }

      // The pass that follows records the unreadable root and deletes nothing, so the
      // answer that eventually returns is a partial graph that SAYS it is partial.
      await new Promise(resolve => { setTimeout(resolve, 1200) })
      const settled = await find(tools, root, 'anchored')
      assert.equal(settled.freshness, 'current', 'the pass settles rather than looping')
      assert.match(String(settled.note ?? ''), /could not verify deletions/u,
        'and the answer carries the removalSkipped warning rather than nothing')
      assert.deepEqual(names(settled), ['anchored'], 'the existing graph survived the unreadable pass')
    } finally {
      await dispose()
    }
  })

  it('does not re-index because a codegraph tool answered', async () => {
    // THE LOOP. A codegraph answer is a tool result too. If it triggered a scan, every
    // query would start another pass and the graph would spend the session indexing —
    // and each answer would be served from a graph that is being rewritten.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function only(): number { return 1 }\n')

    const { ctx, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const answer = await find(tools, root, 'only')
        return answer.freshness === 'current' && names(answer).includes('only')
      }, 'the first pass to settle')

      // Ten of its own answers. Any of them scheduling a pass would flip the state to
      // `stale` (which `markStale` does synchronously) or to `indexing`.
      for (let index = 0; index < 10; index += 1) {
        const answer = await find(tools, root, 'only')
        assert.equal(answer.freshness, 'current', `answer ${String(index)} must not schedule a scan`)
        emit('tools/result', { name: 'codegraph_find', agent: { session: { header: { cwd: root } } } } as never)
      }
      // Give a wrongly-scheduled timer its window to fire, then confirm the state.
      await new Promise(resolve => { setTimeout(resolve, 700) })
      assert.equal((await find(tools, root, 'only')).freshness, 'current', 'no pass was started by the queries')
    } finally {
      await dispose()
    }
  })

  it('ignores a result with no session working directory', async () => {
    // The same boundary `requireCwd` enforces for a tool call: a call without a cwd is
    // not in a project. Throwing here would be an observer failure at best and would
    // surface as a logged warning per tool call at worst.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function only(): number { return 1 }\n')
    const { ctx, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      for (const payload of [
        { name: 'write' },
        { name: 'write', agent: {} },
        { name: 'write', agent: { session: { header: {} } } },
        { name: 'write', agent: { session: { header: { cwd: '' } } } },
      ]) {
        assert.doesNotThrow(() => { emit('tools/result', payload as never) })
      }
    } finally {
      await dispose()
    }
  })

  it('does not create a graph for a project it has never indexed', async () => {
    // A tool result can name any cwd a session touched. Scheduling a pass from one
    // would create a graph directory for every directory mentioned in a session —
    // `session/created` and the first tool call are the two places that decide a
    // project exists.
    const { root, home } = fixture()
    const { ctx, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('tools/result', toolResult('write', root) as never)
      await new Promise(resolve => { setTimeout(resolve, 700) })
      const projects = join(home, 'storages', 'dsh-app-plugin-codegraph', 'projects')
      const created = ((): string[] => {
        try { return readdirSync(projects) } catch { return [] }
      })()
      assert.deepEqual(created, [], 'no graph directory was created by a stray tool result')
    } finally {
      await dispose()
    }
  })

  it('starts no pass after unload', async () => {
    // The teardown closes every open graph. A timer that outlived it would run a pass
    // into a closed database — the failure that lands on the boot audit instead of a
    // warning.
    const { root } = fixture()
    writeFileSync(join(root, 'src', 'a.ts'), 'export function only(): number { return 1 }\n')
    const { ctx, emit, dispose } = fakeContext()
    apply(ctx as never)
    emit('session/created', { header: { cwd: root } } as never)
    emit('tools/result', toolResult('write', root) as never)
    await dispose()
    // Firing the listener after teardown must not throw either: the listener is gone
    // with the effect that registered it, and a stray emit is what a race looks like.
    assert.doesNotThrow(() => { emit('tools/result', toolResult('write', root) as never) })
  })
})

describe('deleting a project while it is being indexed', () => {
  /** The settings action route, for the delete a user triggers. */
  function actionRoute(routes: Map<string, { path: string, fetch: (request: Request) => Promise<Response> }>): (request: Request) => Promise<Response> {
    const route = routes.get('/api/plugins/dsh-app/codegraph/action')
    assert.ok(route !== undefined, 'the settings action route is registered')
    return route.fetch
  }

  /** POST one action, as the settings page does. */
  function action(cwd: string, name: string): Request {
    return new Request('dsh-app://app/api/plugins/dsh-app/codegraph/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: name, cwd }),
    })
  }

  /** The project's graph directory, which is what a re-created graph would leave behind. */
  function graphDirectory(home: string): string {
    return join(home, 'storages', 'dsh-app-plugin-codegraph', 'projects')
  }

  it('cancels the running pass and leaves no graph directory behind', async () => {
    // THE DEFECT THIS CASE EXISTS FOR. `forget` used to be synchronous while its comment
    // claimed the delete waited for the pass. It did not: the handle was closed and the
    // directory removed underneath a pass that was still writing, and an owed
    // compensating pass then re-created the directory the user had just deleted — a
    // project they removed reappearing on disk.
    //
    // A big project makes the first pass long enough to delete inside it, which is the
    // real trigger: the user deletes a project while it is still indexing.
    const { root, home } = fixture()
    for (let index = 0; index < 400; index += 1) {
      writeFileSync(join(root, 'src', `f${String(index)}.ts`), `export function fn${String(index)}(): number { return ${String(index)} }\n`)
    }

    const { ctx, routes, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      // Wait until the pass is actually running (the first symbol is visible or the
      // project reports indexing), then delete.
      await until(async () => {
        const answer = await find(tools, root, 'fn1')
        return answer.freshness === 'indexing' || names(answer).length > 0
      }, 'the first pass to start')

      const response = await actionRoute(routes)(action(root, 'forget'))
      assert.equal(response.status, 200, 'the delete is accepted')

      // The directory is gone, and it stays gone: a pass that outlived the delete (or a
      // compensating one it owed) would re-create it here.
      const projects = graphDirectory(home)
      await new Promise(resolve => { setTimeout(resolve, 1200) })
      assert.deepEqual(readdirSync(projects), [], 'no graph directory was re-created after the delete')

      // And the queue no longer knows the project, so nothing reports a graph that is gone.
      const statuses = await (async () => {
        const route = routes.get('/api/plugins/dsh-app/codegraph/status')
        assert.ok(route !== undefined)
        const listed = await route.fetch(new Request('dsh-app://app/api/plugins/dsh-app/codegraph/status'))
        return await listed.json() as { value?: { projects?: { cwd: string }[] } }
      })()
      assert.deepEqual(statuses.value?.projects?.map(project => project.cwd) ?? [], [], 'the deleted project is not listed')
    } finally {
      await dispose()
    }
  })

  it('does not re-create the directory when a pass was owed by a change during it', async () => {
    // The exact sequence: a change arrives during the pass, so the queue owes one more,
    // and the user deletes the project in that window. The owed pass must be cancelled —
    // that is the pass that used to resurrect the directory.
    const { root, home } = fixture()
    for (let index = 0; index < 400; index += 1) {
      writeFileSync(join(root, 'src', `g${String(index)}.ts`), `export function gn${String(index)}(): number { return ${String(index)} }\n`)
    }
    const { ctx, routes, tools, emit, dispose } = fakeContext()
    apply(ctx as never)
    try {
      emit('session/created', { header: { cwd: root } } as never)
      await until(async () => {
        const answer = await find(tools, root, 'gn1')
        return answer.freshness === 'indexing' || names(answer).length > 0
      }, 'the first pass to start')
      // A tool result mid-pass: the check cannot decide (a pass is running), so the queue
      // records a compensating pass as owed.
      emit('tools/result', toolResult('write', root) as never)

      const response = await actionRoute(routes)(action(root, 'forget'))
      assert.equal(response.status, 200)
      const projects = graphDirectory(home)
      await new Promise(resolve => { setTimeout(resolve, 1500) })
      assert.deepEqual(readdirSync(projects), [], 'the owed pass did not re-create the directory')
    } finally {
      await dispose()
    }
  })
})
