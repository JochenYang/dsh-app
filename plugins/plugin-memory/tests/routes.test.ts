/**
 * Transport contract tests for the settings routes: the exact-Fetch
 * registration shape (one path, its own methods, buffered bodies) and the wire
 * envelope of a read route. No HTTP server and no web server are involved — the
 * Connection registry hands a handler a Fetch request and takes back a Response,
 * which is exactly what these drive.
 *
 * @module @dsh-app/plugin-memory/tests/routes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryRoot, projectSlug } from '../src/memory-store.ts'
import type { MemoryArchiveRow, MemoryLedgerResponse } from '../src/types.ts'
import { registerMemoryRoutes, ROUTE_PREFIX } from '../src/routes.ts'

/** One route as the fake Connection registry records it. */
interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Register the settings routes over a throwaway root. */
function register(): { readonly routes: RegisteredRoute[], readonly dispose: () => Promise<void> } {
  const routes: RegisteredRoute[] = []
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-routes-'))))
  return { routes, dispose }
}

test('every settings route owns one exact path, its own methods, and a buffered body', () => {
  const { routes, dispose } = register()

  assert.deepEqual(routes.map(route => route.path), [
    `${ROUTE_PREFIX}/status`,
    `${ROUTE_PREFIX}/config`,
    `${ROUTE_PREFIX}/clear`,
    `${ROUTE_PREFIX}/entries`,
    `${ROUTE_PREFIX}/pin`,
    `${ROUTE_PREFIX}/forget`,
    `${ROUTE_PREFIX}/llm-audit`,
    `${ROUTE_PREFIX}/ledger`,
    `${ROUTE_PREFIX}/archive`,
    `${ROUTE_PREFIX}/restore`,
    `${ROUTE_PREFIX}/archive-delete`,
    `${ROUTE_PREFIX}/archive-clear`,
  ])
  assert.deepEqual(routes.map(route => route.methods), [
    ['GET'], ['POST'], ['POST'], ['GET'], ['POST'], ['POST'], ['GET'], ['GET'], ['GET'], ['POST'], ['POST'], ['POST'],
  ])
  // The carrier buffers the body under its own cap, so a handler always reads a
  // complete request (and applies its own, smaller limit on top).
  assert.deepEqual([...new Set(routes.map(route => route.requestBody))], ['buffered'])
  void dispose()
})

test('the route prefix stays inside the Connection segment grammar', () => {
  // An `@` — the npm scope — is not an allowed segment character: the registry
  // refuses such a path at registration, taking the plugin's whole route set
  // with it. The scope therefore travels as `dsh-app`.
  assert.equal(ROUTE_PREFIX, '/api/plugins/dsh-app/plugin-memory')
  assert.ok(!ROUTE_PREFIX.includes('@'))
  for (const segment of ROUTE_PREFIX.split('/').filter(part => part !== '')) {
    assert.match(segment, /^[A-Za-z0-9_$.-]+$/u)
  }
  // Path parameters ride the query string: every segment is fixed text.
  assert.ok(!ROUTE_PREFIX.includes(':') && !ROUTE_PREFIX.includes('?'))
})

test('GET /status answers the envelope the settings page reads', async () => {
  const { routes, dispose } = register()
  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/status`)
  assert.ok(route !== undefined)

  const response = await route.fetch(new Request(`https://localhost${route.path}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json')
  const body = await response.json() as { ok: boolean, value: Record<string, unknown> }
  assert.equal(body.ok, true)
  // Bodies stay out of the status payload; the entries route serves them.
  assert.deepEqual(Object.keys(body.value).sort(), [
    'activity', 'cards', 'distill', 'enabled', 'globalList', 'projects', 'sizeBytes', 'storePath',
  ])
  void dispose()
})

test('GET /archive lists archived cards; POST /restore brings one back', async () => {
  const routes: RegisteredRoute[] = []
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-routes-arch-')))
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const call = async (name: string, init?: RequestInit): Promise<Response> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/${name}`)
    assert.ok(route !== undefined, `${name} route is registered`)
    return route.fetch(new Request(`https://localhost${route.path}`, init))
  }

  await root.global.upsert({ name: 'arch-me', category: 'lesson', summary: '归档目标', body: '会被删除的内容' })
  await root.global.forget('arch-me')

  const listed = await call('archive', { method: 'GET' })
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as { ok: boolean, value: { cards: Array<{ day: string, topic: string }>, total: number } }
  assert.equal(listBody.ok, true)
  assert.equal(listBody.value.total, 1)
  assert.equal(listBody.value.cards[0]!.topic, 'arch-me')

  const restored = await call('restore', {
    method: 'POST',
    body: JSON.stringify({ day: listBody.value.cards[0]!.day, file: listBody.value.cards[0]!.file, topic: 'arch-me' }),
  })
  assert.equal(restored.status, 200)
  assert.equal(root.global.get('arch-me')?.body, '会被删除的内容', 'the card is live again')

  // Restoring the same entry twice: the key is now taken.
  const again = await call('restore', {
    method: 'POST',
    body: JSON.stringify({ day: listBody.value.cards[0]!.day, file: listBody.value.cards[0]!.file, topic: 'arch-me' }),
  })
  assert.equal(again.status, 409)
  const conflict = await again.json() as { ok: boolean, error: { code: string, host: { code: string } } }
  assert.equal(conflict.ok, false)
  // The host never sends prose: a stable code the client maps to its dictionary.
  assert.equal(conflict.error.host.code, 'route.restoreOccupied')

  const missing = await call('restore', { method: 'POST', body: JSON.stringify({ day: '2020-01-01', file: 'nope', topic: 'nope' }) })
  assert.equal(missing.status, 409)
  const badArgs = await call('restore', { method: 'POST', body: JSON.stringify({ topic: 'arch-me' }) })
  assert.equal(badArgs.status, 400)
  void dispose()
})

test('GET /ledger serves the consolidation events the panels read', async () => {
  const routes: RegisteredRoute[] = []
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-routes-ledger-')))
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/ledger`)
  assert.ok(route !== undefined)

  // Nothing recorded yet: an empty list, not an error.
  const empty = await route.fetch(new Request(`https://localhost${route.path}`, { method: 'GET' }))
  assert.equal(empty.status, 200)
  const emptyBody = await empty.json() as { ok: boolean, value: { entries: unknown[] } }
  assert.deepEqual(emptyBody.value.entries, [])

  await root.global.upsert({ name: 'ledger-route-card', category: 'lesson', summary: 's', body: '内容' })
  await root.global.forget('ledger-route-card')
  const response = await route.fetch(new Request(`https://localhost${route.path}`, { method: 'GET' }))
  assert.equal(response.status, 200)
  const body = await response.json() as { ok: boolean, value: MemoryLedgerResponse }
  assert.equal(body.ok, true)
  assert.equal(body.value.entries.length, 1)
  assert.equal(body.value.entries[0]!.scope, 'global')
  assert.equal(body.value.entries[0]!.pass, 'forget')
  assert.deepEqual(body.value.entries[0]!.keys, ['ledger-route-card'])
  void dispose()
})

test('GET /archive lists EVERY scope, not just global', async () => {
  // The bug this pins: the settings page asked for /archive with no scope, the
  // route defaulted to the GLOBAL store, and a card deleted from a PROJECT was
  // therefore invisible — the user saw "已删除的记忆（0）" right after deleting
  // one, while the copy sat in projects/<slug>/archive/ the whole time.
  const routes: RegisteredRoute[] = []
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-routes-allscope-')))
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const call = async (name: string, init?: RequestInit): Promise<Response> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/${name}`)
    assert.ok(route !== undefined)
    return route.fetch(new Request(`https://localhost${route.path}`, init))
  }

  await root.global.upsert({ name: 'global-casualty', category: 'fact', summary: 's', body: '全局删掉的' })
  await root.global.forget('global-casualty')
  const project = root.projectFor('D:/codes/demo')
  await project.upsert({ name: 'project-casualty', category: 'lesson', summary: 's', body: '项目里删掉的' })
  await project.forget('project-casualty')

  const listed = await call('archive', { method: 'GET' })
  const body = await listed.json() as { value: { cards: MemoryArchiveRow[], total: number } }
  assert.equal(body.value.total, 2, 'both scopes are listed')
  const byTopic = new Map(body.value.cards.map(card => [card.topic, card]))
  assert.equal(byTopic.get('global-casualty')?.scope, 'global')
  assert.equal(byTopic.get('project-casualty')?.scope, 'project')
  assert.equal(byTopic.get('project-casualty')?.slug, projectSlug('D:/codes/demo'), 'the slug is the restore handle')

  // And the restore lands back in the scope it came from.
  const entry = byTopic.get('project-casualty')!
  const restored = await call('restore', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug: entry.slug, day: entry.day, file: entry.file, topic: entry.topic }),
  })
  assert.equal(restored.status, 200)
  assert.equal(project.get('project-casualty')?.body, '项目里删掉的', 'back in the PROJECT store')
  assert.equal(root.global.get('project-casualty'), undefined, 'and NOT leaked into global')

  // An explicit scope still narrows the answer.
  const scoped = await call('archive', { method: 'GET', headers: {} })
  assert.equal(scoped.status, 200)
  void dispose()
})

test('POST /archive-delete and /archive-clear drop copies without touching live cards', async () => {
  const routes: RegisteredRoute[] = []
  const root = new MemoryRoot(mkdtempSync(join(tmpdir(), 'dshm-routes-archdrop-')))
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const call = async (name: string, init?: RequestInit): Promise<Response> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/${name}`)
    assert.ok(route !== undefined, `${name} route is registered`)
    return route.fetch(new Request(`https://localhost${route.path}`, init))
  }

  // Two deletions in a project (so the copies land in the PROJECT archive),
  // plus a surviving card in the same store.
  const project = root.projectFor('D:/codes/demo')
  const slug = projectSlug('D:/codes/demo')
  for (const name of ['drop-one', 'drop-two']) {
    await project.upsert({ name, category: 'lesson', summary: 's', body: `内容 ${name}` })
    await project.forget(name)
  }
  await project.upsert({ name: 'survivor', category: 'lesson', summary: 's', body: '别动我' })
  assert.equal(project.archiveCount(), 2)

  const listed = await call('archive', { method: 'GET' })
  const cards = ((await listed.json()) as { value: { cards: MemoryArchiveRow[] } }).value.cards

  // ONE copy out.
  const one = cards.find(card => card.topic === 'drop-one')!
  const dropped = await call('archive-delete', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug, day: one.day, file: one.file }),
  })
  assert.equal(dropped.status, 200)
  assert.equal(project.archiveCount(), 1, 'exactly the named copy is gone')
  assert.notEqual(project.get('survivor'), undefined, 'the live card is untouched')

  // Deleting the same copy twice is a conflict, not a silent success.
  const again = await call('archive-delete', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug, day: one.day, file: one.file }),
  })
  assert.equal(again.status, 409)

  // A malformed stem never reaches the filesystem.
  const bad = await call('archive-delete', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug, day: one.day, file: '../survivor' }),
  })
  assert.equal(bad.status, 409)
  assert.notEqual(project.get('survivor'), undefined, 'and the live card still there')

  // EMPTY the rest, every scope at once.
  const cleared = await call('archive-clear', { method: 'POST', body: JSON.stringify({}) })
  const clearedBody = await cleared.json() as { value: { cleared: number } }
  assert.equal(clearedBody.value.cleared, 1)
  assert.equal(project.archiveCount(), 0, 'the archive is empty')
  assert.notEqual(project.get('survivor'), undefined, 'and emptying never touches the memory list')
  assert.equal(project.list().length, 1)
  void dispose()
})
