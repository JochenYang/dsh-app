/**
 * PptModeStore persistence with legacy-theme migration, plus the mode,
 * office-active and template-route contracts (payload validation, cover
 * previews) over a captured Connection exact-Fetch route — no HTTP server and
 * no carrier trust checks (those belong to the transport) are involved.
 *
 * @module @dsh-app/plugin-ppt/tests/mode
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PptModeStore, migrateLegacyTheme } from '../src/mode-store.ts'
import { parseOfficeActive, shouldSelfDisable } from '../src/office-active.ts'
import { OFFICE_ACTIVE_FORMAT } from '../src/office-format.ts'
import { claimOfficeActive, officeActiveFilePath, readOfficeActive, releaseOfficeActive } from '../src/office-active-store.ts'
import { ROUTE_PREFIX, registerPptRoutes, templateViews } from '../src/routes.ts'
import { allTemplates, DEFAULT_TEMPLATE_ID } from '../src/templates.ts'

// --- store -------------------------------------------------------------------

/** One temp store file plus its shared active file, removed when done. */
function tempStore(): { store: PptModeStore, file: string, activeFile: string, done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-mode-test-'))
  const file = join(dir, 'mode.json')
  const activeFile = officeActiveFilePath(dir)
  mkdirSync(join(dir, 'storages', 'dsh-app-office'), { recursive: true })
  return {
    store: new PptModeStore(file),
    file,
    activeFile,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('mode store: on-with-template, 常规主题 and off round-trip through mode.json', async () => {
  const { store, file, done } = tempStore()
  try {
    store.set('s1', 'dsh-signal')
    assert.equal(store.templateOf('s1'), 'dsh-signal')
    assert.equal(store.isEnabled('s1'), true)
    assert.equal(typeof store.updatedAtOf('s1'), 'number')
    assert.equal(store.templateOf('unknown'), null)
    assert.equal(store.isEnabled('unknown'), false)
    await store.flush()
    assert.ok(existsSync(file))

    const reopened = new PptModeStore(file)
    reopened.load()
    assert.equal(reopened.templateOf('s1'), 'dsh-signal')
    assert.equal(reopened.isEnabled('s1'), true)

    // A null template is the on-without-template state, not off.
    reopened.set('s1', null)
    await reopened.flush()
    const neutral = new PptModeStore(file)
    neutral.load()
    assert.equal(neutral.isEnabled('s1'), true)
    assert.equal(neutral.templateOf('s1'), null)

    neutral.clear('s1')
    await neutral.flush()
    const cleared = new PptModeStore(file)
    cleared.load()
    assert.equal(cleared.isEnabled('s1'), false)
    assert.equal(cleared.updatedAtOf('s1'), null)
  } finally {
    done()
  }
})

test('mode store: switching templates overwrites the entry, not appends', async () => {
  const { store, file, done } = tempStore()
  try {
    store.set('s1', 'dsh-signal')
    store.set('s1', 'dsh-broadside')
    await store.flush()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { template: string }>
    assert.deepEqual(Object.keys(parsed), ['s1'])
    assert.equal(parsed['s1']?.template, 'dsh-broadside')
  } finally {
    done()
  }
})

test('mode store: legacy theme entries migrate to templates on load', async () => {
  const { store, file, done } = tempStore()
  try {
    writeFileSync(file, JSON.stringify({
      old: { theme: 'ocean', updatedAt: Date.now() },
      brand: { theme: 'brand-alibaba', updatedAt: Date.now() },
      fresh: { template: 'dsh-monochrome', updatedAt: Date.now() },
      neutral: { template: null, updatedAt: Date.now() },
    }), 'utf8')
    store.load()
    assert.equal(store.migratedCount, 2)
    assert.equal(store.templateOf('old'), 'dsh-signal')
    // Unknown legacy themes reset to the default template, not dropped.
    assert.equal(store.templateOf('brand'), DEFAULT_TEMPLATE_ID)
    assert.equal(store.templateOf('fresh'), 'dsh-monochrome')
    assert.equal(store.isEnabled('neutral'), true)
    assert.equal(store.templateOf('neutral'), null)
    await store.flush()
    // The persisted copy no longer carries theme fields.
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { template?: string, theme?: string }>
    assert.equal(parsed['old']?.template, 'dsh-signal')
    assert.equal(parsed['old']?.theme, undefined)
  } finally {
    done()
  }
})

test('migrateLegacyTheme maps every legacy builtin id', () => {
  for (const legacy of ['graphite', 'paper', 'ocean', 'ember', 'forest', 'mono']) {
    assert.match(migrateLegacyTheme(legacy), /^dsh-/)
  }
  assert.equal(migrateLegacyTheme('never-existed'), DEFAULT_TEMPLATE_ID)
})

test('mode store: prune drops only entries older than the window', async () => {
  const { store, file, done } = tempStore()
  try {
    writeFileSync(file, JSON.stringify({
      old: { template: 'dsh-signal', updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 },
      fresh: { template: 'dsh-monochrome', updatedAt: Date.now() },
    }), 'utf8')
    store.load()
    const pruned = store.prune()
    assert.equal(pruned, 1)
    assert.equal(store.isEnabled('old'), false)
    assert.equal(store.isEnabled('fresh'), true)
    await store.flush()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(parsed), ['fresh'])
  } finally {
    done()
  }
})

test('mode store: a corrupt file is tolerated as empty state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-mode-test-'))
  try {
    const file = join(dir, 'mode.json')
    writeFileSync(file, '{not json', 'utf8')
    const store = new PptModeStore(file)
    store.load()
    assert.equal(store.isEnabled('s1'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- shared active claim -----------------------------------------------------

test('office active: parse rejects malformed claims and the stand-down rule is one-way', () => {
  assert.deepEqual(parseOfficeActive({ format: 'pdf', sessionId: 's1', updatedAt: 4 }), { format: 'pdf', sessionId: 's1', updatedAt: 4 })
  assert.deepEqual(parseOfficeActive({ format: null, sessionId: 's1', updatedAt: 4 }), { format: null, sessionId: 's1', updatedAt: 4 })
  assert.equal(parseOfficeActive({ format: 'deck', sessionId: 's1', updatedAt: 4 }), null)
  assert.equal(parseOfficeActive({ format: 'pdf', sessionId: '', updatedAt: 4 }), null)
  assert.equal(parseOfficeActive(null), null)

  const foreign = { format: 'pdf', sessionId: 's1', updatedAt: 20 } as const
  // Only a later foreign claim wins; own format, none, and an unknown local
  // timestamp never trigger a stand-down.
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, 10), true)
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, 20), false)
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, 30), false)
  assert.equal(shouldSelfDisable(foreign, OFFICE_ACTIVE_FORMAT, null), false)
  assert.equal(shouldSelfDisable({ format: 'ppt', sessionId: 's1', updatedAt: 20 }, OFFICE_ACTIVE_FORMAT, 10), false)
  assert.equal(shouldSelfDisable({ format: null, sessionId: 's1', updatedAt: 20 }, OFFICE_ACTIVE_FORMAT, 10), false)
  assert.equal(shouldSelfDisable(null, OFFICE_ACTIVE_FORMAT, 10), false)
})

test('office active store: claim is monotonic and release only clears our own claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppt-active-test-'))
  try {
    const file = officeActiveFilePath(dir)
    const first = await claimOfficeActive(file, 's1', 1_000)
    assert.deepEqual(first, { format: 'ppt', sessionId: 's1', updatedAt: 1_000 })

    // A same-millisecond rewrite still stamps later, so the stand-down order
    // is never ambiguous.
    const second = await claimOfficeActive(file, 's2', 1_000)
    assert.equal(second.updatedAt, 1_001)

    // A foreign claim is left alone by release.
    writeFileSync(file, JSON.stringify({ format: 'pdf', sessionId: 's9', updatedAt: 5_000 }), 'utf8')
    await releaseOfficeActive(file, 's2', 6_000)
    assert.deepEqual(readOfficeActive(file), { format: 'pdf', sessionId: 's9', updatedAt: 5_000 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- routes ------------------------------------------------------------------

/** One captured Connection exact-Fetch route. */
interface CapturedRoute {
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** Fake HostConnectionFetch capturing registrations by path. */
function fakeConnectionFetch() {
  const routes = new Map<string, CapturedRoute>()
  return {
    register(route: { path: string, methods: readonly string[], requestBody: string, fetch: (request: Request) => Promise<Response> }): () => Promise<void> {
      routes.set(route.path, { methods: route.methods, requestBody: route.requestBody, fetch: route.fetch })
      return async () => { routes.delete(route.path) }
    },
    route(path: string): CapturedRoute {
      const route = routes.get(path)
      assert.ok(route !== undefined, `route ${path} registered`)
      return route
    },
    count: () => routes.size,
  }
}

interface Envelope {
  ok: boolean
  value?: Record<string, unknown>
  error?: { code: string, message: string }
}

/** The window's own origin: the carrier hands the route a same-origin request. */
const ORIGIN = 'dsh-app://app'

function get(registry: ReturnType<typeof fakeConnectionFetch>, path: string): Promise<Response> {
  // The registry keys routes by their exact path; the query string rides the
  // request URL only.
  return registry.route(path.split('?')[0]).fetch(new Request(`${ORIGIN}${path}`))
}

function post(registry: ReturnType<typeof fakeConnectionFetch>, path: string, body: unknown): Promise<Response> {
  return registry.route(path).fetch(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

async function envelope(response: Response): Promise<Envelope> {
  return await response.json() as Envelope
}

test('mode routes: GET /templates serves every bundled template with a cover preview', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const registry = fakeConnectionFetch()
    registerPptRoutes(registry, store, activeFile)
    assert.equal(registry.count(), 3)
    assert.deepEqual(registry.route(`${ROUTE_PREFIX}/templates`).methods, ['GET'])

    const response = await get(registry, `${ROUTE_PREFIX}/templates`)
    assert.equal(response.status, 200)
    const value = (await envelope(response)).value as { templates: { id: string, category: string, cover: string, pageCount: number }[] }
    const bundled = await allTemplates()
    assert.equal(value.templates.length, bundled.length)
    for (const row of value.templates) {
      assert.ok(row.id.length > 0)
      assert.ok(row.pageCount >= 1)
      assert.ok(row.cover.startsWith('data:image/jpeg;base64,'))
      assert.ok(row.cover.length <= 280 * 1024, 'cover stays bounded')
    }
  } finally {
    done()
  }
})

test('templateViews: covers=0 keeps the light payload cover-less', async () => {
  const light = await templateViews(false)
  assert.ok(light.length >= 6)
  for (const row of light) assert.equal(row.cover, undefined)
})

test('mode routes: POST /mode enables with or without a template, GET reads, off clears', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const registry = fakeConnectionFetch()
    registerPptRoutes(registry, store, activeFile)
    assert.deepEqual(registry.route(`${ROUTE_PREFIX}/mode`).methods, ['GET', 'POST'])

    const on = await post(registry, `${ROUTE_PREFIX}/mode`, { sessionId: 's1', enabled: true, template: 'dsh-signal' })
    assert.equal(on.status, 200)
    assert.equal(store.templateOf('s1'), 'dsh-signal')
    assert.deepEqual(readOfficeActive(activeFile)?.format, 'ppt')

    const read = await get(registry, `${ROUTE_PREFIX}/mode?sessionId=s1`)
    assert.equal(read.status, 200)
    const value = (await envelope(read)).value as { enabled: boolean, template: string | null }
    assert.equal(value.enabled, true)
    assert.equal(value.template, 'dsh-signal')

    // Enabling without a template is on 常规主题, not off.
    const neutral = await post(registry, `${ROUTE_PREFIX}/mode`, { sessionId: 's1', enabled: true, template: null })
    assert.equal(neutral.status, 200)
    assert.equal(store.isEnabled('s1'), true)
    assert.equal(store.templateOf('s1'), null)

    const off = await post(registry, `${ROUTE_PREFIX}/mode`, { sessionId: 's1', enabled: false, template: null })
    assert.equal(off.status, 200)
    assert.equal(store.isEnabled('s1'), false)
    assert.equal(readOfficeActive(activeFile)?.format, null)
    assert.equal(readOfficeActive(activeFile)?.sessionId, 's1')

    const unknown = await post(registry, `${ROUTE_PREFIX}/mode`, { sessionId: 's1', enabled: true, template: 'neon-dreams' })
    assert.equal(unknown.status, 400)
    assert.equal(store.isEnabled('s1'), false)

    const missingEnabled = await post(registry, `${ROUTE_PREFIX}/mode`, { sessionId: 's1', template: null })
    assert.equal(missingEnabled.status, 400)

    const missingSession = await get(registry, `${ROUTE_PREFIX}/mode`)
    assert.equal(missingSession.status, 400)

    const oversized = await registry.route(`${ROUTE_PREFIX}/mode`).fetch(new Request(`${ORIGIN}${ROUTE_PREFIX}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', enabled: true, template: null, pad: 'x'.repeat(16_384) }),
    }))
    assert.equal(oversized.status, 413)
  } finally {
    done()
  }
})

test('mode routes: the shared active claim is readable and a foreign claim survives our off', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const registry = fakeConnectionFetch()
    registerPptRoutes(registry, store, activeFile)
    assert.deepEqual(registry.route(`${ROUTE_PREFIX}/office-active`).methods, ['GET'])

    const empty = await get(registry, `${ROUTE_PREFIX}/office-active`)
    assert.equal(empty.status, 200)
    assert.equal((await envelope(empty)).value?.active, null)

    writeFileSync(activeFile, JSON.stringify({ format: 'pdf', sessionId: 's9', updatedAt: 5_000 }), 'utf8')
    const foreign = await get(registry, `${ROUTE_PREFIX}/office-active`)
    assert.deepEqual((await envelope(foreign)).value?.active, { format: 'pdf', sessionId: 's9', updatedAt: 5_000 })
  } finally {
    done()
  }
})

test('mode routes: the disposer unregisters every route and drops the state it carries', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const registry = fakeConnectionFetch()
    const dispose = registerPptRoutes(registry, store, activeFile)
    assert.equal(registry.count(), 3)
    await dispose()
    assert.equal(registry.count(), 0)
  } finally {
    done()
  }
})
