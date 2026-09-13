/**
 * Spreadsheet-mode persistence and the mode route contract: the store's
 * on/off round-trip through mode.json (including the shapes that must read as
 * "off" instead of as an accidental activation), and the route's fence, method
 * guard and payload validation over a fake server and mocked req/res.
 *
 * @module @dsh-app/plugin-sheet/tests/mode
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SheetModeStore } from '../src/mode-store.ts'
import { OFFICE_ACTIVE_FORMAT } from '../src/office-format.ts'
import { officeActiveFilePath, readOfficeActive } from '../src/office-active-store.ts'
import { registerSheetRoutes, ROUTE_PREFIX, sameOrigin } from '../src/routes.ts'

/** One temp store file plus its shared active file, removed when done. */
function tempStore(): { store: SheetModeStore, file: string, activeFile: string, done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sheet-mode-test-'))
  const file = join(dir, 'mode.json')
  const activeFile = officeActiveFilePath(dir)
  mkdirSync(join(dir, 'storages', 'dsh-app-office'), { recursive: true })
  return {
    store: new SheetModeStore(file),
    file,
    activeFile,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// --- store -------------------------------------------------------------------

test('mode store: on/off round-trips through mode.json', async () => {
  const { store, file, done } = tempStore()
  try {
    assert.equal(store.enabledOf('s1'), false)
    store.set('s1', true)
    assert.equal(store.enabledOf('s1'), true)
    assert.equal(typeof store.updatedAtOf('s1'), 'number')
    await store.flush()
    assert.ok(existsSync(file))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { enabled: boolean, updatedAt: number }>
    assert.deepEqual(Object.keys(parsed), ['s1'])
    assert.equal(parsed['s1']?.enabled, true)
    assert.ok((parsed['s1']?.updatedAt ?? 0) > 0)

    const reopened = new SheetModeStore(file)
    reopened.load()
    assert.equal(reopened.enabledOf('s1'), true)

    reopened.set('s1', false)
    await reopened.flush()
    const reloaded = new SheetModeStore(file)
    reloaded.load()
    assert.equal(reloaded.enabledOf('s1'), false)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  } finally {
    done()
  }
})

test('mode store: only an explicit enabled:true entry counts as a mode', async () => {
  const { store, file, done } = tempStore()
  try {
    writeFileSync(file, JSON.stringify({
      off: { enabled: false, updatedAt: Date.now() },
      truthy: { enabled: 'yes', updatedAt: Date.now() },
      legacy: { template: 'dsh-blue-professional', updatedAt: Date.now() },
      stale: { enabled: true },
      on: { enabled: true, updatedAt: Date.now() },
    }), 'utf8')
    store.load()
    assert.equal(store.enabledOf('on'), true)
    for (const sessionId of ['off', 'truthy', 'legacy', 'stale']) {
      assert.equal(store.enabledOf(sessionId), false, `${sessionId} must read as off`)
    }
  } finally {
    done()
  }
})

test('mode store: a corrupt file starts empty instead of failing the mount', async () => {
  const { store, file, done } = tempStore()
  try {
    writeFileSync(file, '{ not json', 'utf8')
    const warnings: string[] = []
    const logging = new SheetModeStore(file, { warn: (message) => warnings.push(message), info: () => {} })
    logging.load()
    assert.equal(logging.enabledOf('s1'), false)
    assert.equal(warnings.length, 1)
    store.load()
    assert.equal(store.enabledOf('s1'), false)
  } finally {
    done()
  }
})

test('mode store: prune drops entries older than the max age', async () => {
  const { store, file, done } = tempStore()
  try {
    store.set('fresh', true)
    store.set('old', true)
    await store.flush()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { enabled: boolean, updatedAt: number }>
    assert.ok(parsed['old'] !== undefined)
    const pruned = store.prune(1_000, Date.now() + 2_000)
    assert.equal(pruned, 2)
    assert.equal(store.enabledOf('fresh'), false)
    await store.flush()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
  } finally {
    done()
  }
})

// --- routes ------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** Fake WebServerLike capturing registrations by path. */
function fakeServer(): {
  register(route: { kind: 'exact', path: string, handler: Handler }): () => void
  handler(path: string): Handler
  count(): number
} {
  const routes = new Map<string, Handler>()
  return {
    register(route) {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
    handler(path) {
      const handler = routes.get(path)
      assert.ok(handler !== undefined, `route ${path} registered`)
      return handler
    },
    count: () => routes.size,
  }
}

interface ReqOpts {
  method?: string
  url?: string
  headers?: Record<string, string | undefined>
  body?: unknown
}

function makeReq(opts: ReqOpts = {}): IncomingMessage & { emitBody(): void } {
  const req = new EventEmitter() as unknown as IncomingMessage & { emitBody(): void }
  Object.assign(req, {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    headers: opts.headers ?? { host: '127.0.0.1:3080' },
    resume: () => {},
  })
  req.emitBody = () => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(JSON.stringify(opts.body)))
    req.emit('end')
  }
  return req
}

interface Envelope {
  ok: boolean
  value?: Record<string, unknown>
  error?: { code: string, message: string }
}

interface CapturedResponse {
  status(): number
  json(): Envelope
  /** Resolves when the handler finishes the response (no timing guesswork). */
  ended: Promise<void>
}

function makeRes(): ServerResponse & CapturedResponse {
  const state = { status: 0, raw: '' }
  let settle: () => void = () => {}
  const ended = new Promise<void>((resolve) => { settle = resolve })
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => { state.status = code },
    end: (payload?: unknown) => {
      if (payload !== undefined) state.raw += String(payload)
      settle()
    },
  }
  const captured: CapturedResponse = {
    status: () => state.status,
    json: () => JSON.parse(state.raw) as Envelope,
    ended,
  }
  return Object.assign(res as unknown as ServerResponse, captured) as ServerResponse & CapturedResponse
}

test('mode route: PUT toggles, GET reads, unknown sessions read as off', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const server = fakeServer()
    registerSheetRoutes(server, store, activeFile)
    assert.equal(server.count(), 2)
    const handler = server.handler(`${ROUTE_PREFIX}/mode`)

    const on = makeRes()
    const onReq = makeReq({ method: 'PUT', body: { sessionId: 's1', enabled: true } })
    handler(onReq, on)
    onReq.emitBody()
    await on.ended
    assert.equal(on.status(), 200)
    assert.equal(store.enabledOf('s1'), true)
    assert.equal((on.json().value as { enabled: boolean }).enabled, true)
    assert.equal(readOfficeActive(activeFile)?.format, OFFICE_ACTIVE_FORMAT)

    const get = makeRes()
    handler(makeReq({ url: `${ROUTE_PREFIX}/mode?sessionId=s1` }), get)
    await get.ended
    assert.equal((get.json().value as { enabled: boolean }).enabled, true)

    const unknown = makeRes()
    handler(makeReq({ url: `${ROUTE_PREFIX}/mode?sessionId=nobody` }), unknown)
    await unknown.ended
    assert.equal(unknown.status(), 200)
    assert.equal((unknown.json().value as { enabled: boolean }).enabled, false)

    const off = makeRes()
    const offReq = makeReq({ method: 'PUT', body: { sessionId: 's1', enabled: false } })
    handler(offReq, off)
    offReq.emitBody()
    await off.ended
    assert.equal(store.enabledOf('s1'), false)
    // Turning off releases our own claim but keeps the claim readable.
    assert.equal(readOfficeActive(activeFile)?.format, null)

    const active = makeRes()
    server.handler(`${ROUTE_PREFIX}/office-active`)(makeReq({ url: `${ROUTE_PREFIX}/office-active` }), active)
    await active.ended
    assert.equal(active.status(), 200)
    assert.deepEqual((active.json().value as { active: unknown }).active, readOfficeActive(activeFile))
  } finally {
    done()
  }
})

test('mode route: bad payloads, wrong methods and cross-origin calls are refused', async () => {
  const { store, activeFile, done } = tempStore()
  try {
    const server = fakeServer()
    registerSheetRoutes(server, store, activeFile)
    const handler = server.handler(`${ROUTE_PREFIX}/mode`)

    const missingSession = makeRes()
    const missingSessionReq = makeReq({ method: 'PUT', body: { enabled: true } })
    handler(missingSessionReq, missingSession)
    missingSessionReq.emitBody()
    await missingSession.ended
    assert.equal(missingSession.status(), 400)

    const badEnabled = makeRes()
    const badEnabledReq = makeReq({ method: 'PUT', body: { sessionId: 's1', enabled: 'yes' } })
    handler(badEnabledReq, badEnabled)
    badEnabledReq.emitBody()
    await badEnabled.ended
    assert.equal(badEnabled.status(), 400)

    const noSession = makeRes()
    handler(makeReq({ url: `${ROUTE_PREFIX}/mode` }), noSession)
    await noSession.ended
    assert.equal(noSession.status(), 400)

    const wrongMethod = makeRes()
    handler(makeReq({ method: 'DELETE' }), wrongMethod)
    assert.equal(wrongMethod.status(), 405)

    const crossOrigin = makeRes()
    handler(makeReq({
      url: `${ROUTE_PREFIX}/mode?sessionId=s1`,
      headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' },
    }), crossOrigin)
    assert.equal(crossOrigin.status(), 403)

    const rebound = makeRes()
    handler(makeReq({
      url: `${ROUTE_PREFIX}/mode?sessionId=s1`,
      headers: { host: 'evil.example' },
    }), rebound)
    assert.equal(rebound.status(), 403)

    assert.equal(store.enabledOf('s1'), false)
  } finally {
    done()
  }
})

test('mode route: sameOrigin semantics match the suite fence', () => {
  const req = (headers: Record<string, string | undefined>): IncomingMessage =>
    ({ headers } as unknown as IncomingMessage)
  assert.equal(sameOrigin(req({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })), true)
  assert.equal(sameOrigin(req({ origin: undefined, host: '127.0.0.1:3080' })), true)
  assert.equal(sameOrigin(req({ origin: 'http://evil.example', host: '127.0.0.1:3080' })), false)
})
