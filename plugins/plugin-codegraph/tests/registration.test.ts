/**
 * The plugin's registration shape: what `apply` mounts, and the security
 * property of the storage path it derives.
 *
 * Two things are pinned here that no other suite sees.
 *
 * First, the registration itself. `query.test.ts` tests the functions, the route
 * tests mount handlers, and `e2e.test.ts` runs the data path — but nothing else
 * proves that `apply` wires the THREE tools with the exact names a model is
 * promised, and the routes under the prefix the client fetches. A renamed tool
 * or a drifted prefix passes every other suite.
 *
 * Second, `graphFileFor`. The path it returns is where a SQLite file gets
 * CREATED, and the input is a session cwd. The sha256 derivation is the fence
 * that keeps a hostile or merely odd path (a traversal, a drive letter, a name
 * with separators) from becoming an arbitrary write location — so its exact
 * properties are the contract: stable, per-root, and structurally inert.
 *
 * The queue and the parser are never started by these tests: `apply` only
 * registers, and the pass behind a tool call runs through `e2e.test.ts` with the
 * real grammar.
 *
 * @module plugin-codegraph/tests/registration
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openGraph, writeProjectMeta } from '../src/store.ts'

/** Scratch directories this suite created, removed on the way out. */
const created: string[] = []
after(() => {
  for (const dir of created.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
import { apply, graphFileFor, inject, knownProjects, name } from '../src/index.ts'
import { ROUTE_PREFIX } from '../src/routes.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** The minimal Context the plugin's apply() reads, recording every registration. */
function fakeContext() {
  const tools: string[] = []
  /** The full definition of each registered tool, for the parameter-shape assertions. */
  const definitions = new Map<string, { name: string, parameters?: Record<string, { required?: boolean }> }>()
  const routes: ConnectionFetchRoute[] = []
  /** Every `ctx.on` listener, by event name, so the auto-index rule is testable. */
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  /** The registered prompt contexts, so the overview block is observable. */
  const contexts = new Map<string, { order: number, text: unknown }>()
  // EVERY effect's disposer, not just the last one: the plugin registers several
  // (tools clean-up, the deferred project-list restore, the prompt context), and a
  // fake that kept only the last would report a clean teardown while leaving the
  // others mounted.
  const disposers: (() => void | Promise<void>)[] = []
  const ctx = {
    tools: {
      register(tool: { name: string, parameters?: Record<string, { required?: boolean }> }): () => void {
        tools.push(tool.name)
        definitions.set(tool.name, tool)
        return () => { tools.splice(tools.indexOf(tool.name), 1) }
      },
    },
    connection: {
      fetch: {
        register(route: ConnectionFetchRoute): () => Promise<void> {
          routes.push(route)
          return async () => { routes.splice(routes.indexOf(route), 1) }
        },
      },
    },
    systemPrompt: {
      context(spec: { name: string, order: number, text: unknown }): () => void {
        contexts.set(spec.name, spec)
        return () => { contexts.delete(spec.name) }
      },
    },
    /** Cordis `ctx.on`: the disposer is registered with the fiber, not tracked here. */
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
    /**
     * Cordis's optional-injection door. This fake has every service, so the callback
     * runs immediately with the same context — what cordis does for a composition
     * that provides the service at activation time. The route tests rely on it: the
     * plugin registers its settings routes through this door now, not through the
     * required `inject` list.
     */
    inject(_deps: readonly string[], callback: (scope: unknown) => void): void {
      callback(this)
    },
    /** Fire one event at the listeners the plugin registered. */
    emit(event: string, ...args: never[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    // Cordis runs an effect body on activation and its returned disposer on
    // unload; the fake captures every one so the test can exercise the teardown.
    effect(body: () => (() => void) | (() => Promise<void>)): void {
      disposers.push(body())
    },
  }
  return {
    ctx,
    tools,
    definitions,
    routes,
    listeners,
    contexts,
    disposeAll: async () => {
      for (const dispose of disposers.splice(0)) await dispose()
    },
  }
}

describe('apply', () => {
  it('registers exactly the three promised tools', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never)
    assert.deepEqual(tools.sort(), ['codegraph_context', 'codegraph_find', 'codegraph_impact'])
  })

  it('mounts without a Connection carrier, registering no routes', () => {
    // The tools need `tools` and `systemPrompt`; only the settings routes need the
    // Fetch registry. Measured in a real headless kernel with the suite mounted: while
    // `connection` was a REQUIRED service, the plugin never applied and the session
    // answered "this environment has no code graph tool" — after the model had already
    // read twenty files by hand. A headless or TUI profile must still get the tools.
    const tools: string[] = []
    const routes: ConnectionFetchRoute[] = []
    const withoutConnection = {
      tools: { register(tool: { name: string }): () => void { tools.push(tool.name); return () => {} } },
      systemPrompt: { context(): () => void { return () => {} } },
      on(): () => void { return () => {} },
      effect(body: () => () => void): void { body() },
      // Cordis runs the callback only where the dependency resolves; this fake has no
      // `connection`, so the door stays shut — exactly the headless case.
      inject(deps: readonly string[], callback: (scope: unknown) => void): void {
        if (deps.every(dep => dep !== 'connection')) callback(this)
      },
    }
    apply(withoutConnection as never)
    assert.deepEqual(tools.sort(), ['codegraph_context', 'codegraph_find', 'codegraph_impact'])
    assert.equal(routes.length, 0, 'no carrier means no routes, and no crash')
  })

  it('leaves codegraph_context callable with no argument', () => {
    // The orientation question — "what is this project, where does it start" —
    // names no symbol, so a required `symbol` made the tool unreachable for
    // exactly the question the plugin exists to answer. Measured: a session with
    // a built graph answered it with `working_directory` + `查找文件` + four
    // `读取` calls, because every codegraph tool demanded a name it did not have.
    const { ctx, definitions } = fakeContext()
    apply(ctx as never)
    const required = (tool: string): string[] => definitions.get(tool)?.parameters?.required ?? []
    assert.equal(required('codegraph_context').includes('symbol'), false, 'omitting symbol must be legal')
    // The other two stay required: they are name lookups and have no meaning
    // without one.
    assert.equal(required('codegraph_find').includes('query'), true)
    assert.equal(required('codegraph_impact').includes('symbol'), true)
  })

  it('registers the routes under the plugin prefix the client fetches', () => {
    const { ctx, routes } = fakeContext()
    apply(ctx as never)
    assert.deepEqual(
      routes.map(route => route.path).sort(),
      [`${ROUTE_PREFIX}/action`, `${ROUTE_PREFIX}/graph`, `${ROUTE_PREFIX}/languages`, `${ROUTE_PREFIX}/status`].sort(),
    )
  })

  it('tears every registration down when the effect disposes', async () => {
    // A leftover registration after unload is the plugin half of a double mount:
    // the next activation would collide, and the collision lands on boot audit,
    // not on a warning.
    const { ctx, tools, routes, disposeAll } = fakeContext()
    apply(ctx as never)
    assert.ok(tools.length === 3 && routes.length === 4)
    await disposeAll()
    assert.deepEqual(tools, [], 'every tool registration was disposed')
    assert.deepEqual(routes, [], 'every route registration was disposed')
  })

  it('starts a pass for a project when a session enters it', () => {
    // The graph used to be built only when a tool was called, so the settings page
    // and the view stayed empty for every project the user had not queried.
    // session/created fires on entering AND resuming, so an old session reopened
    // after install still gets indexed.
    const { ctx, listeners } = fakeContext()
    apply(ctx as never)
    const registered = listeners.get('session/created') ?? []
    assert.equal(registered.length, 1, 'the plugin listens for session creation exactly once')
  })

  it('pushes the project overview as runtime context', () => {
    // The mechanism that does not depend on the model choosing to look. Measured:
    // a session with a current graph and a correct tool description wrote "I should
    // use codegraph_find / codegraph_context" and then planned `glob` + `read`
    // eight times. A description is an instruction; this arrives before the plan.
    const { ctx, contexts } = fakeContext()
    apply(ctx as never)
    const spec = contexts.get('dsh-app:codegraph:overview')
    assert.notEqual(spec, undefined, 'the overview context is registered')
    assert.equal(typeof spec?.text, 'function', 'evaluated per assembly, so a fresh graph lands without a restart')
  })

  it('contributes no context for a session with no project', () => {
    // An empty block would be a lie about the project; the assembly asks per turn,
    // and a session without a cwd has no project to describe.
    const { ctx, contexts } = fakeContext()
    apply(ctx as never)
    const text = contexts.get('dsh-app:codegraph:overview')?.text as (assembly: unknown) => string
    assert.equal(text({}), '')
    assert.equal(text({ agent: { session: { header: { cwd: '' } } } }), '')
  })

  it('contributes no context for a project the queue has never seen', () => {
    // A project with no queue entry has no graph yet. Queueing one here would start
    // an index on EVERY assembly; `session/created` does it once, at the right moment.
    const { ctx, contexts } = fakeContext()
    apply(ctx as never)
    const text = contexts.get('dsh-app:codegraph:overview')?.text as (assembly: unknown) => string
    assert.equal(text({ agent: { session: { header: { cwd: 'Z:/no/such/project' } } } }), '')
  })

  it('keeps the phrases the tool descriptions are measured by', () => {
    // A description is an instruction the model reads before it plans, and this one
    // is HAND-MAINTAINED: when the behaviour behind it changed, the prose did not
    // follow. Measured twice in one release — the ambiguity sentence described "no
    // target" after the tool had started returning candidates, and an earlier
    // compression nearly took the two trigger phrases with it.
    //
    // So these five are pinned as LITERALS, not derived from the code: the point is
    // to fail when a reword drops one by accident. Each earned its place by being
    // measured — the two capitalised phrases are what got a session to call this
    // instead of globbing, and "never safe to change" is the sentence that stops an
    // empty reference list from reading as approval.
    const { ctx, definitions } = fakeContext()
    apply(ctx as never)
    const description = (tool: string): string => definitions.get(tool)?.description ?? ''

    const context = description('codegraph_context')
    assert.ok(context.includes('OMIT `symbol` to get the project OVERVIEW'),
      'the overview trigger phrase is what makes "what is this project" reach the graph')
    assert.ok(context.includes('PASS A FILE PATH'),
      'the outline trigger phrase is what makes "what does this file define" reach the graph')

    const impact = description('codegraph_impact')
    assert.ok(impact.includes('never "safe to change"'),
      'an empty reference list must never read as approval')
    assert.ok(impact.includes('answers the candidates instead of picking one'),
      'a shared name returns candidates; the description must say so, not "no target"')

    const find = description('codegraph_find')
    assert.ok(find.includes('before opening files, grepping, or guessing a path'),
      'the ordering instruction is what makes the graph the first step rather than the last')
  })

  it('decides freshness per assembly rather than capturing it once', () => {
    // The block cannot decide staleness itself: `text` returns a string
    // synchronously, while that needs `await gitHead(cwd)`. It CAN report what a
    // tool already found — a call that saw HEAD move runs `queue.markStale`, so the
    // state stays `stale` until the rebuild settles. One beat behind, and honest;
    // the literal `'current'` it used to assert was a claim it could not back up.
    //
    // What this case pins is the SHAPE that makes that possible: `text` is a
    // function, so the state is read at assembly time. `prompt.test.ts` pins what a
    // stale block renders as; together they cover "the queue's state reaches the
    // text" without this suite having to stand up a real graph on disk.
    const { ctx, contexts } = fakeContext()
    apply(ctx as never)
    const spec = contexts.get('dsh-app:codegraph:overview')
    assert.equal(typeof spec?.text, 'function', 'evaluated per assembly, not captured once')
  })

  it('ignores a session with no working directory', () => {
    // A blank or absent cwd is not a project: queueing it would create a graph
    // file keyed by an empty string.
    const { ctx, listeners } = fakeContext()
    apply(ctx as never)
    const fire = listeners.get('session/created')?.[0]
    assert.ok(fire !== undefined)
    // Both shapes a header can carry; neither may throw out of the listener,
    // which runs inside session creation.
    for (const header of [{}, { cwd: '' }]) {
      assert.doesNotThrow(() => fire({ header } as never))
    }
  })

  it('declares the module contract the loader reads', () => {
    assert.equal(name, 'plugin-codegraph')
    // TWO services, each with a reason: `tools` for the three tools themselves,
    // `systemPrompt` for the overview pushed as runtime context. `connection` is
    // deliberately absent — its Fetch registry only carries the settings routes, which
    // mount through `ctx.inject(['connection'], …)` where a web-shaped composition
    // provides it. Measured in a real headless kernel: while it was required, the whole
    // plugin stayed inactive and the session had no code graph tools at all. Nothing
    // else may creep in either: every required service is one more reason to go silent.
    assert.deepEqual(inject, ['tools', 'systemPrompt'])
  })
})

describe('graphFileFor', () => {
  it('is stable for a root and different between roots', () => {
    const a = graphFileFor('D:/codes/one')
    assert.equal(a, graphFileFor('D:/codes/one'))
    assert.notEqual(a, graphFileFor('D:/codes/two'))
  })

  it('keeps every path character out of the derived segment', () => {
    // The dangerous inputs are the ones that LOOK like the storage layout: a
    // traversal that would escape `projects/`, and separators that would nest it
    // somewhere else. The sha256 hex digest is inert by construction — the
    // assertion is the fence, and a regression here is an arbitrary write path.
    for (const hostile of ['../escape', 'D:/a/../../b', 'a/b/c', 'C:\\..\\..\\windows', '']) {
      // The storage root is built with join(), which uses the platform separator;
      // normalise so the shape test reads the same on Windows and POSIX.
      const file = graphFileFor(hostile).split('\\').join('/')
      assert.match(
        file,
        /\/projects\/[0-9a-f]{32}\/graph\.db$/u,
        `derived path is not projects/<32 hex>/graph.db: ${file}`,
      )
    }
  })

  it('maps roots that differ only by case to distinct files', () => {
    // Windows treats these as the same directory; two graphs for it is harmless
    // (the second re-indexes), but the derivation must not CRASH on it, and the
    // tool-facing lookup uses the raw cwd consistently.
    assert.notEqual(graphFileFor('D:/Codes'), graphFileFor('D:/codes'))
    assert.ok(graphFileFor('D:/x').endsWith('graph.db'))
  })
})

describe('routes registration contract', () => {
  it('admits only the methods the shared channel allows', async () => {
    // The Connection carrier accepts GET/HEAD/POST only (plugins/AGENTS.md §6);
    // a PUT here would register but never be reachable.
    const { ctx, routes } = fakeContext()
    apply(ctx as never)
    for (const route of routes) {
      for (const method of route.methods) {
        assert.ok(['GET', 'HEAD', 'POST'].includes(method), `method ${method} is not admitted`)
      }
      assert.ok(!route.path.includes('@'), 'the registry rejects an @ in a segment')
    }
    await Promise.resolve()
  })
})

describe('knownProjects', () => {
  it('reads the root back out of each graph, because the directory name is a hash', async () => {
    // The queue's list is in memory, so a restart showed only the project a
    // session happened to open: measured on this machine, five graphs were on disk
    // and one was visible. The directory name is `sha256(cwd)` and cannot be
    // reversed, so the root has to come out of the graph's own meta row.
    const dir = mkdtempSync(join(tmpdir(), 'cg-known-'))
    created.push(dir)
    const storage = join(dir, 'storage')
    const roots = ['D:/codes/one', 'D:/codes/two']
    for (const root of roots) {
      const file = join(storage, 'projects', createHash('sha256').update(root).digest('hex').slice(0, 32), 'graph.db')
      mkdirSync(dirname(file), { recursive: true })
      const graph = openGraph(file)
      writeProjectMeta(graph.db, {
        cwd: root, name: root.split('/').pop() ?? root, head: '', indexedAt: 7,
        fileCount: 3, symbolCount: 9, edgeCount: 4,
        truncated: false, removalSkipped: false, missingLanguage: 0, noRules: 0, parseErrors: 0,
      })
      graph.close()
    }

    const found = knownProjects(storage)
    assert.deepEqual(found.map(project => project.cwd).sort(), roots)
    assert.equal(found[0]?.meta.fileCount, 3, 'the metadata travels with the root')
  })

  it('skips a directory with no readable graph', () => {
    // A half-written graph from a killed pass is not a fact a user can act on:
    // the next visit rebuilds it.
    const dir = mkdtempSync(join(tmpdir(), 'cg-known-empty-'))
    created.push(dir)
    const storage = join(dir, 'storage')
    mkdirSync(join(storage, 'projects', 'deadbeef'), { recursive: true })
    assert.deepEqual(knownProjects(storage), [])
    assert.deepEqual(knownProjects(join(dir, 'absent')), [], 'a storage root that does not exist yet is empty, not a throw')
  })

  it('reads an outdated graph WITHOUT rebuilding it', () => {
    // The regression this test exists for: the listing used to open each graph with
    // `openGraph`, which applies the schema version — and a version bump DROPS every
    // table, `meta` and its `cwd` included. The directory name is `sha256(cwd)`, so the
    // list erased the only field it needed and then excluded the project it had just
    // erased. Measured after the 3→4 bump: an empty project list, and each project
    // reappearing only once a session opened it by hand.
    const dir = mkdtempSync(join(tmpdir(), 'cg-known-old-'))
    created.push(dir)
    const storage = join(dir, 'storage')
    const root = 'D:/codes/legacy'
    const file = join(storage, 'projects', createHash('sha256').update(root).digest('hex').slice(0, 32), 'graph.db')
    mkdirSync(dirname(file), { recursive: true })
    const graph = openGraph(file)
    writeProjectMeta(graph.db, {
      cwd: root, name: 'legacy', head: '', indexedAt: 7, fileCount: 3, symbolCount: 9, edgeCount: 4,
      truncated: false, removalSkipped: false, missingLanguage: 0, noRules: 0, parseErrors: 0,
    })
    // Pretend a previous build wrote it, with a schema this version would rebuild.
    graph.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('3', 'schema_version')
    graph.close()

    const found = knownProjects(storage)
    assert.deepEqual(found.map(entry => entry.cwd), [root], 'an old graph still knows its root')

    // And the peek wrote nothing: the version is still the OLD one and the project row
    // is still there. Read through a bare handle on purpose — `openGraph` would apply
    // the version and rebuild, which is exactly what must not happen during a listing.
    const raw = new DatabaseSync(file, { timeout: 2_000 })
    const version = raw.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }
    const project = raw.prepare('SELECT value FROM meta WHERE key = ?').get('project') as { value: string } | undefined
    raw.close()
    assert.equal(version.value, '3', 'a listing must not apply the schema version')
    assert.notEqual(project, undefined, 'and must not drop the row it came to read')
  })

  it('skips a graph file that is not a database, without throwing', () => {
    // A listing must not repair anything: deleting an unreadable file is `openGraph`'s
    // decision, made when that project is actually opened.
    const dir = mkdtempSync(join(tmpdir(), 'cg-known-junk-'))
    created.push(dir)
    const storage = join(dir, 'storage')
    const file = join(storage, 'projects', 'junk', 'graph.db')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'this is not a sqlite database')

    assert.deepEqual(knownProjects(storage), [])
  })
})
