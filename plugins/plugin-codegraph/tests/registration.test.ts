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
import { describe, it } from 'node:test'
import { apply, graphFileFor, inject, name } from '../src/index.ts'
import { ROUTE_PREFIX } from '../src/routes.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** The minimal Context the plugin's apply() reads, recording every registration. */
function fakeContext() {
  const tools: string[] = []
  const routes: ConnectionFetchRoute[] = []
  /** Every `ctx.on` listener, by event name, so the auto-index rule is testable. */
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  let dispose: (() => void) | (() => Promise<void>) | undefined
  const ctx = {
    tools: {
      register(tool: { name: string }): () => void {
        tools.push(tool.name)
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
    /** Fire one event at the listeners the plugin registered. */
    emit(event: string, ...args: never[]): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
    // Cordis runs an effect body on activation and its returned disposer on
    // unload; the fake captures both so the test can exercise the teardown.
    effect(body: () => (() => void) | (() => Promise<void>)): void {
      dispose = body()
    },
  }
  return { ctx, tools, routes, listeners, disposeAll: async () => { await dispose?.() } }
}

describe('apply', () => {
  it('registers exactly the three promised tools', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never)
    assert.deepEqual(tools.sort(), ['codegraph_context', 'codegraph_find', 'codegraph_impact'])
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
    // `tools` and `connection` are the two services registration needs; nothing
    // else may creep in — every extra required service is one more reason the
    // plugin silently fails to activate on a kernel line that lacks it.
    assert.deepEqual(inject, ['tools', 'connection'])
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
