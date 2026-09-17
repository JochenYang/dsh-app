// The shell's action seam: a privilege boundary inside the app's own origin.
// Native capabilities live behind it (reveal a folder, notify, write a file the
// user picked), so the tests are weighted towards the fence and the input
// shapes, exactly like the loopback bridge they replace — with one difference:
// there is no socket to attack here, so what is proved is that a request the
// browser did NOT stamp never reaches an action.
//
// The fence has three layers and only two of them live in this process: Chromium
// refuses every cross-origin request to this scheme before the handler runs (a
// browser fact, not assertable here — see the module header), the webRequest hook
// stamps the TOP frame's URL, its `webContents` id and a per-process secret, and
// the handler trusts nothing but that trio. The hook is driven here over a
// stand-in session, so the stamp, the override of a page-supplied copy and the
// subframe refusal are all asserted rather than assumed.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const {
  createShellActionHandler,
  initiatorVerdict,
  installShellActionStamps,
  isSafeFileName,
  INITIATOR_HEADER,
  SHELL_ACTION_PREFIX,
  SHELL_ACTION_ROUTE,
  STAMP_HEADER,
  WINDOW_HEADER,
} = require('../dist/main/shell-actions.js')

const APP = 'dsh-app://app'
const PAGE = `${APP}/index.html`
const WINDOW_ID = 7

/** The capabilities, recorded, plus knobs a test can drive. */
function deps(overrides = {}) {
  const calls = []
  const state = { openPathFailure: '', savedPath: '/picked/out.txt', writeFailure: null, openPathAction: null }
  const value = {
    logDir: () => 'C:/logs',
    windowId: () => WINDOW_ID,
    openPath: async (target) => {
      calls.push(['openPath', target])
      if (state.openPathAction !== null) await state.openPathAction()
      return state.openPathFailure
    },
    notify: (title, body) => { calls.push(['notify', title, body]) },
    saveAs: async (name) => { calls.push(['saveAs', name]); return state.savedPath },
    writeFile: async (file, text) => {
      calls.push(['writeFile', file, text])
      if (state.writeFailure !== null) throw state.writeFailure
    },
    log: (line) => { calls.push(['log', line]) },
    ...overrides,
  }
  return { value, calls, state }
}

/**
 * Install the stamp hook over a stand-in session and hand back what it was
 * installed with, so a test can fire it exactly as the browser would.
 */
function stampSession() {
  const state = {}
  installShellActionStamps({
    webRequest: {
      onBeforeSendHeaders: (filter, listener) => {
        state.filter = filter
        state.listener = listener
      },
    },
  })
  assert.equal(typeof state.listener, 'function', 'the hook is installed')
  return state
}

/** Fire the installed hook over one request and return the headers it hands back. */
function stamped(state, details, requestHeaders = {}) {
  let reply = null
  state.listener(
    { ...details, url: `${APP}${SHELL_ACTION_ROUTE}open-logs`, requestHeaders },
    (answer) => { reply = answer },
  )
  assert.ok(reply !== null, 'the hook answers synchronously')
  return reply.requestHeaders
}

/**
 * The headers the hook really writes for the app's top frame, taken from the hook
 * itself: the secret it appends is minted in the module and is deliberately not
 * readable from outside, so a test that wants a request the fence accepts has to
 * ask the producer for one.
 */
const STAMPS = stamped(stampSession(), { frame: { url: PAGE, parent: null }, webContentsId: WINDOW_ID })

/**
 * One stamped request, exactly as the protocol layer delivers it: the stamped
 * headers are what the shell's webRequest hook writes, never what a page sends.
 */
function request(action, body, { method = 'POST', stamps = true, headers = {}, path = `${SHELL_ACTION_ROUTE}${action}` } = {}) {
  const all = { 'content-type': 'application/json', ...headers }
  if (stamps) {
    all[INITIATOR_HEADER] = STAMPS[INITIATOR_HEADER]
    all[WINDOW_HEADER] = STAMPS[WINDOW_HEADER]
    all[STAMP_HEADER] = STAMPS[STAMP_HEADER]
  }
  return new Request(`${APP}${path}`, {
    method,
    headers: all,
    ...(method === 'POST' ? { body: body === undefined ? '{}' : JSON.stringify(body) } : {}),
  })
}

/** Dispatch one request and read its JSON answer. */
async function call(handler, request_) {
  const response = await handler(request_)
  assert.ok(response, 'the handler owns this path')
  return { status: response.status, body: await response.json() }
}

test('the handler declines every path that is not below its prefix', async () => {
  const { value } = deps()
  const handler = createShellActionHandler(value)
  for (const url of [`${APP}/index.html`, `${APP}/api/plugins/dsh-app/plugin-brand/status`, 'dsh-app://shell/action/open-logs']) {
    assert.equal(await handler(new Request(url)), null, url)
  }
})

test('the whole reserved prefix is answered, so nothing hides behind it', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  // A path below the prefix that is not an action is a 404, not a forward: the
  // kernel must never be reachable under the prefix the shell claims.
  assert.deepEqual(await call(handler, request('', {}, { path: `${SHELL_ACTION_PREFIX}something-else` })), {
    status: 404,
    body: { ok: false, code: 'shellAction.unknown', message: '未知的桌面动作' },
  })
  assert.equal((await call(handler, request('elevate-me'))).status, 404)
  assert.deepEqual(calls, [])
})

test('only POST reaches an action', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  assert.equal((await call(handler, request('open-logs', undefined, { method: 'GET' }))).status, 405)
  assert.deepEqual(calls, [], 'a GET, a navigation or a prefetch never fires a native action')
})

test('an unstamped request is refused before any action runs', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  const refused = await call(handler, request('open-logs', undefined, { stamps: false }))
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'shellAction.forbidden')
  assert.deepEqual(calls.map((entry) => entry[0]), ['log'], 'only the refusal is logged')
})

test('the fence is the stamped pair — Origin and sec-fetch-site decide nothing', async () => {
  // `origin`, `referer` and `sec-fetch-site` never reach a `protocol.handle`
  // request (measured — see the module header), so this handler does not read
  // them: they can neither grant nor deny, and a caller that fails the stamp is
  // refused for the stamp. The layer in front of it is Chromium, which refuses a
  // cross-origin request to this scheme before any handler runs.
  const forged = { origin: 'https://evil.example', referer: 'https://evil.example/', 'sec-fetch-site': 'cross-site' }
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  const refused = await call(handler, request('open-logs', undefined, { stamps: false, headers: forged }))
  assert.equal(refused.status, 403)
  assert.equal(refused.body.code, 'shellAction.forbidden')
  assert.deepEqual(calls.filter((entry) => entry[0] === 'log').map((entry) => /no initiator stamp/u.test(entry[1])), [true],
    'refused because no stamp arrived, not because of a header')
  assert.equal((await call(handler, request('open-logs', undefined, { headers: forged }))).status, 200,
    'with a stamp present the answer is the stamp\'s — these headers are not a fence either way')
})

test('the hook overwrites a page-supplied copy and stamps the top frame alone', () => {
  const state = stampSession()
  assert.deepEqual(state.filter.urls, [`${APP}${SHELL_ACTION_PREFIX}*`], 'the hook covers its own prefix and nothing else')
  const sent = { [INITIATOR_HEADER]: 'dsh-app://evil/index.html', [WINDOW_HEADER]: '424242', [STAMP_HEADER]: 'page-made-secret', accept: '*/*' }

  const top = stamped(state, { frame: { url: PAGE, parent: null }, webContentsId: WINDOW_ID }, sent)
  assert.equal(top[INITIATOR_HEADER], PAGE, 'stamped with what Chromium knows, not with what the page sent')
  assert.equal(top[WINDOW_HEADER], String(WINDOW_ID))
  assert.notEqual(top[STAMP_HEADER], 'page-made-secret', 'and with a secret the page cannot write')
  assert.equal(top.accept, '*/*', 'every other header travels untouched')
  assert.deepEqual(Object.keys(top).filter((name) => name.toLowerCase() === INITIATOR_HEADER), [INITIATOR_HEADER],
    'the page\'s copy is dropped rather than kept beside the real one')
  assert.deepEqual(Object.keys(top).filter((name) => name.toLowerCase() === STAMP_HEADER), [STAMP_HEADER])
  assert.equal(initiatorVerdict(new Headers(top), WINDOW_ID).ok, true)
  const pageOnly = { ...sent }
  delete pageOnly[STAMP_HEADER]
  assert.equal(initiatorVerdict(new Headers(pageOnly), WINDOW_ID).ok, false, 'the pair without the secret is a page\'s own claim')

  // A subframe — a sandboxed iframe included, and it reports the app's own URL
  // whatever its opaque origin is — leaves unstamped and is refused.
  const sub = stamped(state, { frame: { url: PAGE, parent: { url: PAGE, parent: null } }, webContentsId: WINDOW_ID }, sent)
  assert.equal(sub[INITIATOR_HEADER], '')
  assert.equal(sub[WINDOW_HEADER], '-1')
  assert.equal(initiatorVerdict(new Headers(sub), WINDOW_ID).ok, false, 'a subframe request carries no stamp')
  assert.match(initiatorVerdict(new Headers(sub), WINDOW_ID).reason, /no initiator stamp/u)

  // A frame that went away under the request, and a hook call with no frame at
  // all: both fail closed. (A worker's request does not reach the hook at all —
  // measured; the handler-level test below covers that path.)
  const gone = stamped(state, { frame: { url: PAGE, get parent() { throw new Error('frame is gone') } }, webContentsId: WINDOW_ID }, sent)
  assert.equal(initiatorVerdict(new Headers(gone), WINDOW_ID).ok, false)
  const frameless = stamped(state, { frame: null, webContentsId: WINDOW_ID }, sent)
  assert.equal(frameless[STAMP_HEADER], undefined, 'no frame, no secret')
  assert.equal(initiatorVerdict(new Headers(frameless), WINDOW_ID).ok, false)
})

test('a request the hook never touched is refused however it is dressed', async () => {
  // Measured on Electron 44: `webRequest` reports no frame for a worker's request
  // and its headers arrive exactly as the page wrote them, so a page CAN present
  // the pair it would have been given — but not the secret, which is minted in
  // this process and readable from no response. Everything a caller can supply on
  // its own is refused.
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  const dressed = [
    { [INITIATOR_HEADER]: PAGE, [WINDOW_HEADER]: String(WINDOW_ID) },
    { [INITIATOR_HEADER]: PAGE, [WINDOW_HEADER]: String(WINDOW_ID), [STAMP_HEADER]: 'page-made-secret' },
    { [INITIATOR_HEADER]: PAGE, [WINDOW_HEADER]: String(WINDOW_ID), [STAMP_HEADER]: '0'.repeat(64) },
  ]
  for (const headers of dressed) {
    const refused = await call(handler, request('open-logs', undefined, { stamps: false, headers }))
    assert.equal(refused.status, 403, JSON.stringify(headers))
    assert.equal(refused.body.code, 'shellAction.forbidden')
  }
  assert.deepEqual(calls.filter((entry) => entry[0] === 'openPath'), [], 'no action ran')
})

test('every answer is JSON, uncached, and grants no CORS reach', async () => {
  const { value } = deps()
  const handler = createShellActionHandler(value)
  const requests = [
    request('open-logs', {}),
    request('open-logs', undefined, { stamps: false }),
    request('elevate-me', {}),
    request('notify', undefined, { headers: { 'content-type': 'text/plain' } }),
  ]
  for (const one of requests) {
    const response = await handler(one)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(response.headers.get('access-control-allow-origin'), null, 'this scheme is deliberately not CORS-enabled')
  }
})

test('open-logs reveals the directory the shell owns', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  assert.deepEqual(await call(handler, request('open-logs', {})), { status: 200, body: { ok: true } })
  assert.deepEqual(calls.filter((entry) => entry[0] === 'openPath'), [['openPath', 'C:/logs']])
})

test('a failed open reports a stable code and keeps the platform text in the log', async () => {
  const { value } = deps()
  value.openPath = async () => 'shell: no association for C:/logs'
  const handler = createShellActionHandler(value)
  const answer = await call(handler, request('open-logs', {}))
  assert.equal(answer.status, 500)
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'message', 'ok'])
  assert.equal(answer.body.code, 'shellAction.failed')
  assert.equal(answer.body.message.includes('association'), false, 'the internal detail stays out of the answer')
})

test('notify validates both fields and raises the notification', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  assert.deepEqual(await call(handler, request('notify', { title: '标题', body: '内容' })), { status: 200, body: { ok: true } })
  assert.deepEqual(calls.filter((entry) => entry[0] === 'notify'), [['notify', '标题', '内容']])

  assert.equal((await call(handler, request('notify', { title: '标题' }))).status, 400)
  assert.equal((await call(handler, request('notify', { title: '', body: 'x' }))).status, 400)
  assert.equal((await call(handler, request('notify', { title: 42, body: 'x' }))).status, 400)
  assert.equal((await call(handler, request('notify', { title: 'x'.repeat(201), body: 'x' }))).status, 400)
  assert.equal((await call(handler, request('notify', { title: 'x', body: 'x'.repeat(1001) }))).status, 400)
  assert.equal(calls.filter((entry) => entry[0] === 'notify').length, 1, 'no refused payload reaches the notification')
})

test('a malformed or oversized body is a coded refusal, never a crash', async () => {
  const { value } = deps()
  const handler = createShellActionHandler(value)
  const post = (body) => new Request(`${APP}${SHELL_ACTION_ROUTE}notify`, { method: 'POST', headers: { 'content-type': 'application/json', ...STAMPS }, body })
  assert.equal((await call(handler, post('{'))).status, 400)
  assert.equal((await call(handler, post('[]'))).status, 400)

  const oversized = await call(handler, request('save-text-as', { name: 'a.txt', content: 'x'.repeat(9 * 1024 * 1024) }))
  assert.equal(oversized.status, 413)
  assert.equal(oversized.body.code, 'shellAction.tooLarge')
})

test('a body that is not declared JSON is refused 415 before it is read', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', '']) {
    const answer = await call(handler, request('notify', { title: '标题', body: '内容' }, { headers: { 'content-type': type } }))
    assert.equal(answer.status, 415, JSON.stringify(type))
    assert.equal(answer.body.code, 'shellAction.contentType')
  }
  assert.deepEqual(calls.filter((entry) => entry[0] === 'notify'), [], 'a body the caller never declared JSON never reaches the notification')
  const declared = await call(handler, request('notify', { title: '标题', body: '内容' }, { headers: { 'content-type': 'application/json; charset=utf-8' } }))
  assert.equal(declared.status, 200, 'the media type is what is compared, not the parameter list')
})

test('save-text-as writes exactly where the dialog pointed, not where the page asked', async () => {
  const { value, calls, state } = deps()
  const handler = createShellActionHandler(value)
  state.savedPath = 'D:/user-picked/report.txt'
  assert.deepEqual(await call(handler, request('save-text-as', { name: 'report.txt', content: '# 报告' })), {
    status: 200,
    body: { ok: true, path: 'D:/user-picked/report.txt' },
  })
  assert.deepEqual(calls.filter((entry) => entry[0] === 'saveAs'), [['saveAs', 'report.txt']])
  assert.deepEqual(calls.filter((entry) => entry[0] === 'writeFile'), [['writeFile', 'D:/user-picked/report.txt', '# 报告']])
})

test('a cancelled save is a success with no path', async () => {
  const { value, calls, state } = deps()
  state.savedPath = null
  const handler = createShellActionHandler(value)
  assert.deepEqual(await call(handler, request('save-text-as', { name: 'a.txt', content: '' })), {
    status: 200,
    body: { ok: true, path: null },
  })
  assert.deepEqual(calls.filter((entry) => entry[0] === 'writeFile'), [])
})

test('a suggested name that is not a bare file name never reaches the dialog', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  for (const name of ['../escape.txt', 'sub/dir.txt', 'C:evil.txt', '..', 'trailing.', 'bad|name.txt']) {
    const answer = await call(handler, request('save-text-as', { name, content: 'x' }))
    assert.equal(answer.status, 400, name)
    assert.equal(answer.body.code, 'shellAction.params')
  }
  assert.deepEqual(calls.filter((entry) => entry[0] === 'saveAs'), [])
})

test('a write failure is coded and leaks nothing', async () => {
  const { value, state } = deps()
  state.writeFailure = new Error('EPERM: operation not permitted, open D:/secret/path')
  const handler = createShellActionHandler(value)
  const answer = await call(handler, request('save-text-as', { name: 'a.txt', content: 'x' }))
  assert.equal(answer.status, 500)
  assert.equal(answer.body.code, 'shellAction.failed')
  assert.equal(JSON.stringify(answer.body).includes('secret'), false)
})

test('a suggested name that is a Windows device name never reaches the dialog', async () => {
  const { value, calls } = deps()
  const handler = createShellActionHandler(value)
  // Windows resolves these to a device even with an extension attached, so the
  // write would answer success and keep nothing — refused as a bad parameter.
  for (const name of ['NUL', 'nul', 'NUL.txt', 'CON', 'con.json', 'PRN', 'AUX', 'COM1', 'com9.log', 'LPT1', 'lpt9.txt']) {
    assert.equal(isSafeFileName(name), false, name)
    const answer = await call(handler, request('save-text-as', { name, content: 'x' }))
    assert.equal(answer.status, 400, name)
    assert.equal(answer.body.code, 'shellAction.params')
  }
  assert.deepEqual(calls.filter((entry) => entry[0] === 'saveAs'), [], 'a device name never becomes a dialog default')
})

test('isSafeFileName accepts ordinary names and refuses path shapes', () => {
  for (const name of ['a.txt', 'DSH APP 诊断包-2030.txt', '报告.md', 'a(b)[1].txt', 'CONSOLE.txt', 'NULL.md', 'COM10.txt', 'LPT10', 'null', 'auxiliary.md']) {
    assert.equal(isSafeFileName(name), true, name)
  }
  for (const name of ['', '.', '..', 'a/b.txt', 'a\\b.txt', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b', 'a\u001fb', 'trailing.', 'trailing ']) {
    assert.equal(isSafeFileName(name), false, JSON.stringify(name))
  }
})

test('initiatorVerdict fails closed on every missing or foreign stamp', () => {
  const stamped = (initiator, window) => {
    const headers = new Headers(STAMPS)
    if (initiator === null) headers.delete(INITIATOR_HEADER)
    else headers.set(INITIATOR_HEADER, initiator)
    if (window === null) headers.delete(WINDOW_HEADER)
    else headers.set(WINDOW_HEADER, window)
    return headers
  }

  assert.equal(initiatorVerdict(stamped(PAGE, String(WINDOW_ID)), WINDOW_ID).ok, true)
  assert.equal(initiatorVerdict(stamped(PAGE, String(WINDOW_ID)), undefined).ok, false, 'no window open')
  assert.equal(initiatorVerdict(stamped(PAGE, String(WINDOW_ID + 1)), WINDOW_ID).ok, false, 'another webContents')
  assert.equal(initiatorVerdict(stamped(PAGE, 'not-a-number'), WINDOW_ID).ok, false)
  assert.equal(initiatorVerdict(stamped('', String(WINDOW_ID)), WINDOW_ID).ok, false, 'the hook never ran')
  assert.equal(initiatorVerdict(stamped(null, String(WINDOW_ID)), WINDOW_ID).ok, false)
  assert.equal(initiatorVerdict(stamped('dsh-app://shell/x.html', String(WINDOW_ID)), WINDOW_ID).ok, false, 'a foreign origin in this scheme')
  assert.equal(initiatorVerdict(stamped('https://evil.example/x', String(WINDOW_ID)), WINDOW_ID).ok, false)
  assert.equal(initiatorVerdict(stamped('::::', String(WINDOW_ID)), WINDOW_ID).ok, false)
  assert.equal(initiatorVerdict(stamped('dsh-app://app.evil.example/x', String(WINDOW_ID)), WINDOW_ID).ok, false)
  for (const secret of [undefined, '', 'x', STAMPS[STAMP_HEADER].slice(0, -1)]) {
    const headers = new Headers(stamped(PAGE, String(WINDOW_ID)))
    if (secret === undefined) headers.delete(STAMP_HEADER)
    else headers.set(STAMP_HEADER, secret)
    assert.equal(initiatorVerdict(headers, WINDOW_ID).ok, false, `without the secret the pair is not evidence (${String(secret)})`)
  }
})
