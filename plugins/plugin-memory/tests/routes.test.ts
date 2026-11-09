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

import { join } from 'node:path'
import { LEGACY_GLOBAL_SLUG, listProjects, projectSlug } from '../src/memory-store.ts'
import { renderMemoryText } from '../src/prompt.ts'
import { scratchRoot } from './scratch.ts'
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
  } as never, scratchRoot('dshm-routes-'))
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
    `${ROUTE_PREFIX}/move`,
    `${ROUTE_PREFIX}/curate`,
    `${ROUTE_PREFIX}/llm-audit`,
    `${ROUTE_PREFIX}/ledger`,
    `${ROUTE_PREFIX}/archive`,
    `${ROUTE_PREFIX}/restore`,
    `${ROUTE_PREFIX}/archive-delete`,
    `${ROUTE_PREFIX}/archive-clear`,
  ])
  assert.deepEqual(routes.map(route => route.methods), [
    ['GET'], ['POST'], ['POST'], ['GET'], ['POST'], ['POST'], ['POST'], ['POST'], ['GET'], ['GET'], ['GET'], ['POST'], ['POST'], ['POST'],
  ])
  // The carrier buffers the body under its own cap, so a handler always reads a
  // complete request (and applies its own, smaller limit on top).
  assert.deepEqual([...new Set(routes.map(route => route.requestBody))], ['buffered'])
  void dispose()
})

test('POST /curate runs the hook for the project the page names', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-curate-')
  const asked: string[] = []
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root, {
    curateNow: async (slug) => {
      asked.push(slug)
      return { status: 'completed', merged: 2, deleted: 1, rewritten: 0, refused: 1 }
    },
  })
  const call = async (body: unknown): Promise<number> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/curate`)
    assert.ok(route !== undefined, 'the curate route is registered')
    const response = await route.fetch(new Request(`https://localhost${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    if (response.status === 200) {
      const parsed = await response.json() as { value: { status: string, merged: number } }
      assert.equal(parsed.value.status, 'completed')
      assert.equal(parsed.value.merged, 2, 'the counts the page renders ride the answer')
    }
    return response.status
  }
  const slug = projectSlug('D:/codes/demo')
  // The store has to be resolvable by slug, and project.json is written by the
  // first save: an empty directory would answer `route.projectUnknown`.
  await root.projectFor('D:/codes/demo').upsert({ name: 'curate-me', category: 'lesson', summary: '整理目标', body: '会被整理的内容' })
  assert.equal(await call({ scope: 'project', slug }), 200)
  assert.deepEqual(asked, [slug], 'the hook gets exactly the slug the page showed')
  // The whole validation is the shared store resolver, so a pass can never
  // start for a request that names no project, a bad slug or a missing one.
  assert.equal(await call({ slug }), 400, 'scope is required')
  assert.equal(await call({ scope: 'project', slug: '../etc' }), 400, 'the slug is pattern-validated')
  assert.equal(await call({ scope: 'project', slug: 'missing-project' }), 400, 'and must resolve to a directory')
  assert.deepEqual(asked, [slug], 'a refused request never reaches the hook')
  void dispose()
})

test('POST /curate without the maintenance half answers a coded unavailable', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-curate-off-')
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const slug = projectSlug('D:/codes/demo')
  // The store has to be resolvable by slug, and project.json is written by the
  // first save: an empty directory would answer `route.projectUnknown`.
  await root.projectFor('D:/codes/demo').upsert({ name: 'curate-me', category: 'lesson', summary: '整理目标', body: '会被整理的内容' })
  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/curate`)
  assert.ok(route !== undefined)
  const response = await route.fetch(new Request(`https://localhost${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'project', slug }),
  }))
  // A kernel without the agents/llm services mounts the routes without the
  // curator: the answer has to SAY so rather than report a pass that never ran.
  assert.deepEqual(await response.json(), {
    ok: true,
    value: { status: 'unavailable', merged: 0, deleted: 0, rewritten: 0, refused: 0 },
  })
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
  // The payload is the page's world and nothing more: the two toggles, the
  // project list and the aggregate warning counts. Card bodies stay out (the
  // entries route serves them on demand), and the retired global scope has no
  // row of its own. A NEW field updates this list; a field that disappears is a
  // breaking change for the page and must be argued for here.
  assert.deepEqual(Object.keys(body.value).sort(), ['distill', 'enabled', 'projects', 'warnings'])
  void dispose()
})

test('GET /archive lists archived cards; POST /restore brings one back', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-arch-')
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

  const slug = projectSlug('D:/codes/demo')
  const store = root.projectFor('D:/codes/demo')
  await store.upsert({ name: 'arch-me', category: 'lesson', summary: '归档目标', body: '会被删除的内容' })
  await store.forget('arch-me')

  const listed = await call('archive', { method: 'GET' })
  assert.equal(listed.status, 200)
  const listBody = await listed.json() as { ok: boolean, value: { cards: MemoryArchiveRow[], total: number } }
  assert.equal(listBody.ok, true)
  assert.equal(listBody.value.total, 1)
  assert.equal(listBody.value.cards[0]!.topic, 'arch-me')
  assert.equal(listBody.value.cards[0]!.slug, slug, 'a copy is addressed by its project')

  const restored = await call('restore', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug, day: listBody.value.cards[0]!.day, file: listBody.value.cards[0]!.file, topic: 'arch-me' }),
  })
  assert.equal(restored.status, 200)
  assert.equal(store.get('arch-me')?.body, '会被删除的内容', 'the card is live again')
  // The restore CONSUMES the copy: the panel lists this directory, so a copy
  // left behind would keep the card under "已删除的记忆（N）" forever and answer
  // the second click with "the key is taken".
  const afterRestore = await call('archive', { method: 'GET' })
  const afterBody = await afterRestore.json() as { value: { total: number } }
  assert.equal(afterBody.value.total, 0, 'the archived copy went with the restore')

  // Restoring the same entry twice: the copy is no longer there at all.
  const again = await call('restore', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug, day: listBody.value.cards[0]!.day, file: listBody.value.cards[0]!.file, topic: 'arch-me' }),
  })
  assert.equal(again.status, 409)
  const conflict = await again.json() as { ok: boolean, error: { code: string, host: { code: string } } }
  assert.equal(conflict.ok, false)
  // The host never sends prose: a stable code the client maps to its dictionary.
  assert.equal(conflict.error.host.code, 'route.restoreMissing')

  const missing = await call('restore', { method: 'POST', body: JSON.stringify({ scope: 'project', slug, day: '2020-01-01', file: 'nope', topic: 'nope' }) })
  assert.equal(missing.status, 409)
  const badArgs = await call('restore', { method: 'POST', body: JSON.stringify({ scope: 'project', slug, topic: 'arch-me' }) })
  assert.equal(badArgs.status, 400)
  // A body without a scope used to be served by the ROOT store — the retired
  // global scope. It is a refusal now, with a code the page can explain.
  const noScope = await call('restore', { method: 'POST', body: JSON.stringify({ day: '2020-01-01', file: 'nope', topic: 'nope' }) })
  assert.equal(noScope.status, 400)
  assert.equal(((await noScope.json()) as { error: { host: { code: string } } }).error.host.code, 'route.scopeRequired')
  void dispose()
})

test('GET /ledger serves the consolidation events the panels read', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-ledger-')
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

test('GET /archive lists EVERY project, and never the retired root scope', async () => {
  // The bug this pins: the settings page asked for /archive with no scope, the
  // route defaulted to the GLOBAL store, and a card deleted from a PROJECT was
  // therefore invisible — the user saw "已删除的记忆（0）" right after deleting
  // one, while the copy sat in projects/<slug>/archive/ the whole time. The
  // answer is every PROJECT now; the retired scope (the root store) is not one,
  // so a copy still sitting there is deliberately not listed: restoring it
  // would address a store nothing reads.
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-allscope-')
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

  await root.global.upsert({ name: 'retired-casualty', category: 'fact', summary: 's', body: '全局删掉的' })
  await root.global.forget('retired-casualty')
  const project = root.projectFor('D:/codes/demo')
  const slug = projectSlug('D:/codes/demo')
  await project.upsert({ name: 'project-casualty', category: 'lesson', summary: 's', body: '项目里删掉的' })
  await project.forget('project-casualty')

  const listed = await call('archive', { method: 'GET' })
  const body = await listed.json() as { value: { cards: MemoryArchiveRow[], total: number } }
  assert.equal(body.value.total, 1, 'the project copy is listed, the retired scope is not')
  const byTopic = new Map(body.value.cards.map(card => [card.topic, card]))
  assert.equal(byTopic.get('retired-casualty'), undefined, 'the retired root scope is never enumerated')
  assert.equal(byTopic.get('project-casualty')?.scope, 'project')
  assert.equal(byTopic.get('project-casualty')?.slug, slug, 'the slug is the restore handle')

  // An explicit scope narrows the answer, and the retired scope is REFUSED on
  // the scope itself — even when a project slug rides along, it resolves to no
  // store at all.
  const archiveRoute = routes.find(entry => entry.path === `${ROUTE_PREFIX}/archive`)
  assert.ok(archiveRoute !== undefined)
  const query = async (search: string): Promise<Response> =>
    archiveRoute.fetch(new Request(`https://localhost${ROUTE_PREFIX}/archive${search}`, { method: 'GET' }))
  const narrowed = await query(`?scope=project&slug=${slug}`)
  assert.equal(narrowed.status, 200)
  assert.equal(((await narrowed.json()) as { value: { total: number } }).value.total, 1)
  const retired = await query(`?scope=global&slug=${slug}`)
  assert.equal(retired.status, 400)
  assert.equal(((await retired.json()) as { error: { host: { code: string } } }).error.host.code, 'route.scopeRequired')

  // And the restore lands back in the project it came from.
  const entry = byTopic.get('project-casualty')!
  const restored = await call('restore', {
    method: 'POST',
    body: JSON.stringify({ scope: 'project', slug: entry.slug, day: entry.day, file: entry.file, topic: entry.topic }),
  })
  assert.equal(restored.status, 200)
  assert.equal(project.get('project-casualty')?.body, '项目里删掉的', 'back in the PROJECT store')
  assert.equal(root.global.get('project-casualty'), undefined, 'and NOT leaked into the retired root store')
  void dispose()
})

test('POST /archive-delete and /archive-clear drop copies without touching live cards', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-archdrop-')
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

  // A request that names NO scope is refused. `/clear` in the same file states the
  // rule: a destructive route never reaches more than one project by omission, and
  // this one used to empty every project's undo copies when `scope` was left out.
  const unnamed = await call('archive-clear', { method: 'POST', body: JSON.stringify({}) })
  assert.equal(unnamed.status, 400)
  assert.equal(project.archiveCount(), 1, 'and the refusal cleared nothing')

  // EMPTY the rest, every scope at once — named, the way the panel's global
  // button does.
  const cleared = await call('archive-clear', { method: 'POST', body: JSON.stringify({ scope: 'all' }) })
  const clearedBody = await cleared.json() as { value: { cleared: number } }
  assert.equal(clearedBody.value.cleared, 1)
  assert.equal(project.archiveCount(), 0, 'the archive is empty')
  assert.notEqual(project.get('survivor'), undefined, 'and emptying never touches the memory list')
  assert.equal(project.list().length, 1)
  void dispose()
})

test('POST /move drains the legacy-global dead end into a real project', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-move-')
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const call = async (body: unknown): Promise<Response> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/move`)
    assert.ok(route !== undefined, 'the move route is registered')
    return route.fetch(new Request(`https://localhost${route.path}`, { method: 'POST', body: JSON.stringify(body) }))
  }

  // The retired root scope, migrated exactly the way boot does it, with its pin:
  // the card lands in projects/legacy-global, a slug NO cwd can ever resolve.
  await root.global.upsert({ name: 'old-global-card', category: 'lesson', summary: '旧全局钩子', body: '旧全局卡的内容' })
  await root.global.addPin('old-global-card')
  assert.equal(await root.migrateLegacyGlobalScope(), 1)

  const targetCwd = 'D:/codes/Demo'
  const targetSlug = projectSlug(targetCwd)
  const target = root.projectFor(targetCwd)
  await target.upsert({ name: 'existing', category: 'fact', summary: '已有', body: '目标项目原有内容' })

  const legacy = root.projectBySlug(LEGACY_GLOBAL_SLUG)
  assert.ok(legacy !== undefined)
  assert.ok(legacy.get('old-global-card') !== undefined, 'the card is visible under the holding pen')
  // The defect this route exists for: the card is on disk and in the project
  // list, yet no session can reach it.
  assert.ok(!renderMemoryText(root, targetCwd).includes('旧全局卡的内容'), 'before the move: injected by nobody')

  const moved = await call({ scope: 'project', slug: LEGACY_GLOBAL_SLUG, topic: 'old-global-card', targetSlug })
  assert.equal(moved.status, 200)
  const movedBody = await moved.json() as { ok: boolean, value: { moved: boolean, from: string, to: string, overwritten: boolean } }
  assert.equal(movedBody.value.from, LEGACY_GLOBAL_SLUG)
  assert.equal(movedBody.value.to, targetSlug)
  assert.equal(movedBody.value.overwritten, false)
  assert.equal(target.get('old-global-card')?.body, '旧全局卡的内容', 'the card is in the REAL project now')
  assert.ok(target.pinnedSet().has('old-global-card'), 'the pin followed the card')
  assert.equal(legacy.get('old-global-card'), undefined, 'and the source no longer holds it')
  assert.ok(legacy.archiveCount() >= 1, 'the source keeps an undo copy of what left')
  assert.ok(renderMemoryText(root, targetCwd).includes('旧全局卡的内容'), 'after the move: the project session reads it')

  // Every fence, one call each, and none of them moves anything.
  const missing = await call({ scope: 'project', slug: LEGACY_GLOBAL_SLUG, topic: 'no-such-topic', targetSlug })
  assert.equal(missing.status, 400)
  assert.equal(((await missing.json()) as { error: { host: { code: string } } }).error.host.code, 'route.topicUnknown')
  const malformed = await call({ scope: 'project', slug: LEGACY_GLOBAL_SLUG, topic: 'existing', targetSlug: '../etc' })
  assert.equal(malformed.status, 400)
  assert.equal(((await malformed.json()) as { error: { host: { code: string } } }).error.host.code, 'route.slugInvalid')
  const unknown = await call({ scope: 'project', slug: LEGACY_GLOBAL_SLUG, topic: 'existing', targetSlug: 'nobody-1234' })
  assert.equal(unknown.status, 400, 'a destination must already be a project — a move never creates one')
  assert.equal(((await unknown.json()) as { error: { host: { code: string } } }).error.host.code, 'route.projectUnknown')
  const back = await call({ scope: 'project', slug: targetSlug, topic: 'existing', targetSlug: LEGACY_GLOBAL_SLUG })
  assert.equal(back.status, 400, 'the dead end is one-way: it can be drained, never filled')
  assert.equal(((await back.json()) as { error: { host: { code: string } } }).error.host.code, 'route.moveTargetLegacy')
  const same = await call({ scope: 'project', slug: targetSlug, topic: 'existing', targetSlug })
  assert.equal(same.status, 400)
  assert.equal(((await same.json()) as { error: { host: { code: string } } }).error.host.code, 'route.moveSameProject')
  const noScope = await call({ slug: LEGACY_GLOBAL_SLUG, topic: 'existing', targetSlug })
  assert.equal(noScope.status, 400)
  assert.equal(((await noScope.json()) as { error: { host: { code: string } } }).error.host.code, 'route.scopeRequired')
  assert.notEqual(target.get('existing'), undefined, 'no refused call destroyed the destination card')

  // A same-topic conflict is ASKED, never silently overwritten.
  await legacy.upsert({ name: 'conflict-card', category: 'lesson', summary: '冲突卡', body: '来搬的版本' })
  await target.upsert({ name: 'conflict-card', category: 'fact', summary: '目标版本', body: '目标已经有的版本' })
  const conflict = await call({ scope: 'project', slug: LEGACY_GLOBAL_SLUG, topic: 'conflict-card', targetSlug })
  assert.equal(conflict.status, 409)
  assert.equal(((await conflict.json()) as { error: { host: { code: string } } }).error.host.code, 'route.moveOccupied')
  assert.equal(target.get('conflict-card')?.body, '目标已经有的版本', 'nothing overwritten on the first ask')
  assert.notEqual(legacy.get('conflict-card'), undefined, 'and the source card is still there')
  const overwritten = await call({ scope: 'project', slug: LEGACY_GLOBAL_SLUG, topic: 'conflict-card', targetSlug, overwrite: true })
  assert.equal(overwritten.status, 200)
  assert.equal(((await overwritten.json()) as { value: { overwritten: boolean } }).value.overwritten, true)
  assert.equal(target.get('conflict-card')?.body, '来搬的版本', 'the confirmed overwrite went through')
  assert.equal(legacy.get('conflict-card'), undefined)
  void dispose()
})

test('GET /status carries the injection ledger exactly when the host has one', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-injection-')
  const sample = {
    at: 1_760_000_000_000,
    project: 'demo-aaaaaaaa',
    guidelinesChars: 3_226,
    indexChars: 5_199,
    bodyChars: 2_657,
    totalChars: 11_082,
    cardCount: 6,
    indexLines: 50,
    // Distinct from the mean below on purpose: equal values would make an
    // assertion pass whatever the DTO dropped.
    droppedCards: 18,
    indexOverflowLines: 1,
    truncated: true,
  }
  const mean = {
    guidelinesChars: 3_226,
    indexChars: 5_199,
    bodyChars: 2_657,
    totalChars: 11_082,
    cardCount: 6,
    indexLines: 50,
    droppedCards: 12.5,
    indexOverflowLines: 0.5,
  }
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root, {
    injectionMetrics: () => ({
      latest: sample,
      samples: 1,
      mean,
      truncatedSamples: 1,
    }),
  })
  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/status`)
  assert.ok(route !== undefined)
  const response = await route.fetch(new Request(`https://localhost${route.path}`, { method: 'GET' }))
  const body = await response.json() as {
    value: {
      injection?: {
        latest: typeof sample
        samples: number
        mean: typeof mean
        truncatedSamples: number
      }
    }
  }
  assert.equal(body.value.injection?.latest.indexChars, 5_199, 'the page reads the numbers the probe measured')
  assert.equal(body.value.injection?.samples, 1)
  // The two counters B2 added, checked item by item: a DTO mapping that dropped
  // either field would leave every other assertion in this file green.
  assert.equal(body.value.injection?.latest.droppedCards, 18)
  assert.equal(body.value.injection?.latest.indexOverflowLines, 1)
  assert.equal(body.value.injection?.mean.droppedCards, 12.5)
  assert.equal(body.value.injection?.mean.indexOverflowLines, 0.5)
  assert.equal(body.value.injection?.truncatedSamples, 1)
  // The earlier status test pins the no-provider shape (three keys): a kernel
  // without the provider must NOT ship an `injection: undefined` key that reads
  // as "measured, all zero".
  void dispose()
})

test('POST /move refuses a destination whose cwd cannot round-trip', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-move-target-')
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const call = async (body: unknown): Promise<Response> => {
    const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/move`)
    assert.ok(route !== undefined, 'the move route is registered')
    return route.fetch(new Request(`https://localhost${route.path}`, { method: 'POST', body: JSON.stringify(body) }))
  }

  const sourceCwd = 'D:/codes/MoveTargetSrc'
  await root.projectFor(sourceCwd).upsert({ name: 'card', category: 'fact', summary: '待迁移卡', body: '待迁移内容' })

  // A directory that exists but carries no stamp at all.
  const bareSlug = 'bare-target-0001'
  mkdirSync(join(root.dir, 'projects', bareSlug), { recursive: true })
  // A directory whose stamp names a different workspace, so the slug it was
  // stored under cannot be resolved back from its cwd.
  const staleSlug = 'stale-target-0001'
  const staleDir = join(root.dir, 'projects', staleSlug)
  mkdirSync(staleDir, { recursive: true })
  writeFileSync(join(staleDir, 'project.json'), `${JSON.stringify({ cwd: 'D:/codes/SomewhereElse' })}\n`, 'utf8')

  for (const targetSlug of [bareSlug, staleSlug]) {
    const response = await call({ scope: 'project', slug: projectSlug(sourceCwd), topic: 'card', targetSlug })
    assert.equal(response.status, 400, `${targetSlug} must be refused as a destination`)
    assert.equal(
      ((await response.json()) as { error: { host: { code: string } } }).error.host.code,
      'route.projectUnknown',
    )
  }

  assert.equal(root.projectFor(sourceCwd).get('card')?.body, '待迁移内容', 'nothing left the source')

  // The settings list has to mark them unusable too: offering a destination the
  // host refuses only produces a dead end for the user.
  const rows = listProjects(root.dir)
  assert.equal(rows.find(row => row.slug === bareSlug)?.movable, false)
  assert.equal(rows.find(row => row.slug === staleSlug)?.movable, false)
  await dispose()
})

test('POST /forget refuses a card it cannot read, with the reason on the wire', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-forget-')
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const { existsSync, mkdirSync, unlinkSync } = await import('node:fs')

  const cwd = 'D:/codes/ForgetUnreadable'
  // A NEW store per call (see projectFor), so the route must see the same thing
  // on disk — the failure below is real, not injected through a seam.
  const store = root.projectFor(cwd)
  await store.upsert({ name: 'card', category: 'fact', summary: '删不掉的卡', body: '主体内容' })
  await store.upsert({ name: 'bystander', category: 'fact', summary: '旁观卡', body: '别动的内容' })
  // The shape of a card file nobody can read on Windows: a directory where the
  // file must be (EISDIR on read).
  const cardPath = join(store.dir, 'topics', 'card.md')
  unlinkSync(cardPath)
  mkdirSync(cardPath)

  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/forget`)
  assert.ok(route !== undefined, 'the forget route is registered')
  const response = await route.fetch(new Request(`https://localhost${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'project', slug: projectSlug(cwd), match: 'card' }),
  }))

  assert.equal(response.status, 500, 'a refused delete is not a 200 with 0 forgotten')
  const payload = await response.json() as {
    error: { code: string, host: { code: string, params: { detail: string } } }
  }
  assert.equal(payload.error.host.code, 'route.forgetFailed')
  assert.match(payload.error.host.params.detail, /cannot read the card/, 'the reason rides the answer, not a bare 500')
  assert.equal(existsSync(cardPath), true, 'the unreadable card was not deleted')
  assert.equal(store.get('bystander')?.body, '别动的内容', 'and no card was swept by its text')

  await dispose()
})

test('POST /move says "cannot read the card", not "unknown topic", for an unreadable source', async () => {
  const routes: RegisteredRoute[] = []
  const root = scratchRoot('dshm-routes-move-unreadable-')
  const dispose = registerMemoryRoutes({
    register: (route: RegisteredRoute) => {
      routes.push(route)
      return () => Promise.resolve()
    },
  } as never, root)
  const { existsSync, mkdirSync, unlinkSync } = await import('node:fs')

  const sourceCwd = 'D:/codes/MoveUnreadableSrc'
  const targetCwd = 'D:/codes/MoveUnreadableDst'
  const source = root.projectFor(sourceCwd)
  await source.upsert({ name: 'card', category: 'fact', summary: '读不了的卡', body: '主体内容' })
  // The destination has to exist (and stamp its cwd) or the route refuses it
  // before it ever looks at the source.
  const target = root.projectFor(targetCwd)
  await target.upsert({ name: 'seed', category: 'fact', summary: '占位卡', body: '让项目存在' })
  // A REAL unreadable source card: a directory where the file must be (EISDIR).
  const cardPath = join(source.dir, 'topics', 'card.md')
  unlinkSync(cardPath)
  mkdirSync(cardPath)

  const route = routes.find(entry => entry.path === `${ROUTE_PREFIX}/move`)
  assert.ok(route !== undefined, 'the move route is registered')
  const response = await route.fetch(new Request(`https://localhost${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scope: 'project',
      slug: projectSlug(sourceCwd),
      topic: 'card',
      targetSlug: projectSlug(targetCwd),
    }),
  }))

  assert.equal(response.status, 500, 'not 400 topicUnknown — the card is there, it just cannot be read')
  const payload = await response.json() as {
    error: { code: string, host: { code: string, params: { detail: string } } }
  }
  assert.equal(payload.error.host.code, 'route.moveFailed')
  assert.match(payload.error.host.params.detail, /cannot read the card "card"/)
  assert.match(payload.error.host.params.detail, /nothing was moved/, 'and it says nothing was touched')
  assert.equal(target.get('card'), undefined, 'no card landed in the destination')
  assert.equal(existsSync(cardPath), true, 'the source card entry is still there')

  await dispose()
})
