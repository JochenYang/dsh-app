/**
 * Wire-level suite for plugin-brand's desktop bridge routes.
 *
 * Nothing here is mocked except the Electron dialogs: a real
 * `startDesktopBridge` (the same module the shell runs) listens on loopback, the
 * plugin's routes are served by a real `node:http` server through the
 * registration seam, and every call arrives over the network. That way the
 * fences, the bearer token, the status mapping and the JSON shapes are all
 * exercised on the wire.
 *
 * The bridge's own fence proves something no assertion here can see directly:
 * it refuses any request that carries an `Origin` header, so every `ok: true`
 * answer below also proves the outbound call sends none.
 *
 * Tests in one file run sequentially, so the shared `process.env` bridge
 * variables are safe; each test restores them through `withBridge`/`unsetBridge`.
 * No assertion ever references the token value.
 *
 * The host stand-in lives in `./host-harness.ts`, shared with the log-tail
 * suite.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { startDesktopBridge, type DesktopBridge, type DesktopBridgeHandlers } from '../../../src/main/desktop-bridge.ts'
import { BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV } from '../src/bridge-client.ts'
import { ROUTE_PREFIX, UNSUPPORTED_HOST } from '../src/routes.ts'
import { parseRaw, rawRequest, startHost, type Host, type JsonAnswer } from './host-harness.ts'

/**
 * The unsupported answer's body, in the coded shape: the client renders
 * `route.unsupported` in its own language, and `error` repeats the host's
 * English diagnostic for a reader that does not know the code.
 */
const UNSUPPORTED_BODY = { ok: false, unsupported: true, error: UNSUPPORTED_HOST.text, host: UNSUPPORTED_HOST }

/**
 * The coded `host` message of one failure body — asserted to exist, because a
 * failure without one would leave the page with nothing to render.
 * @param body - the route's JSON answer.
 * @returns the host message.
 */
function hostOf(body: Record<string, unknown>): Record<string, unknown> {
  const host = body.host
  assert.equal(typeof host, 'object', 'every failure body carries a coded host message')
  return host as Record<string, unknown>
}

/** Shell-side recorder: what the bridge was asked to do, and what it answers. */
interface Recorder {
  handlers: DesktopBridgeHandlers
  calls: Array<{ action: string; body: Record<string, unknown> }>
  /** Mutable shell-side answers a test can drive (cancel, fail). */
  shell: { saved: string | null; picked: string | null; failure: Error | null }
}

function recorder(): Recorder {
  const calls: Recorder['calls'] = []
  const shell: Recorder['shell'] = { saved: 'D:/out/report.md', picked: 'D:/codes', failure: null }
  const guard = (): void => {
    if (shell.failure !== null) throw shell.failure
  }
  return {
    calls,
    shell,
    handlers: {
      openInFolder: (path) => {
        guard()
        calls.push({ action: 'open-in-folder', body: { path } })
        return Promise.resolve()
      },
      notify: (title, body) => {
        guard()
        calls.push({ action: 'notify', body: { title, body } })
        return Promise.resolve()
      },
      saveTextAs: (name, content) => {
        guard()
        calls.push({ action: 'save-text-as', body: { name, content } })
        return Promise.resolve(shell.saved)
      },
      pickDirectory: () => {
        guard()
        calls.push({ action: 'pick-directory', body: {} })
        return Promise.resolve(shell.picked)
      },
      openLogs: () => {
        guard()
        calls.push({ action: 'open-logs', body: {} })
        return Promise.resolve()
      },
    },
  }
}

const savedUrl = process.env[BRIDGE_URL_ENV]
const savedToken = process.env[BRIDGE_TOKEN_ENV]

after(() => {
  if (savedUrl === undefined) delete process.env[BRIDGE_URL_ENV]
  else process.env[BRIDGE_URL_ENV] = savedUrl
  if (savedToken === undefined) delete process.env[BRIDGE_TOKEN_ENV]
  else process.env[BRIDGE_TOKEN_ENV] = savedToken
})

/** Start a real bridge and publish its coordinates the way the shell does. */
async function withBridge(handlers: DesktopBridgeHandlers): Promise<DesktopBridge> {
  const bridge = await startDesktopBridge(handlers)
  assert.ok(bridge !== null, 'the loopback bridge should bind')
  process.env[BRIDGE_URL_ENV] = bridge.url
  process.env[BRIDGE_TOKEN_ENV] = bridge.token
  return bridge
}

/** Simulate a run with no bridge at all (dev, or a shell that could not bind). */
function unsetBridge(): void {
  delete process.env[BRIDGE_URL_ENV]
  delete process.env[BRIDGE_TOKEN_ENV]
}

async function post(
  host: Host,
  action: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonAnswer> {
  const response = await fetch(`${host.url}${ROUTE_PREFIX}/desktop/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function getStatus(host: Host): Promise<JsonAnswer> {
  const response = await fetch(`${host.url}${ROUTE_PREFIX}/status`)
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

test('status reports a configured bridge, and none without the environment', async () => {
  const host = await startHost()
  const bridge = await withBridge(recorder().handlers)
  try {
    assert.deepEqual(await getStatus(host), { status: 200, body: { ok: true, bridge: true } })
  } finally {
    await bridge.close()
    await host.close()
  }

  unsetBridge()
  const bare = await startHost()
  try {
    assert.deepEqual(await getStatus(bare), { status: 200, body: { ok: true, bridge: false } })
  } finally {
    await bare.close()
  }
})

test('open-in-folder forwards the path to the shell', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'open-in-folder', { path: 'D:/codes/DSH-APP' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    assert.deepEqual(rec.calls, [{ action: 'open-in-folder', body: { path: 'D:/codes/DSH-APP' } }])
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('notify forwards the title and body', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'notify', { title: '导出完成', body: '文件已保存' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    assert.deepEqual(rec.calls, [{ action: 'notify', body: { title: '导出完成', body: '文件已保存' } }])
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('save-text-as forwards the payload and returns the saved path', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'save-text-as', { name: 'report.md', content: '# 报告\n' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, path: 'D:/out/report.md' })
    assert.deepEqual(rec.calls, [{ action: 'save-text-as', body: { name: 'report.md', content: '# 报告\n' } }])
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('save-text-as reports a cancelled dialog as a success with no path', async () => {
  const rec = recorder()
  rec.shell.saved = null
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'save-text-as', { name: 'report.md', content: '' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true, path: null })
    assert.equal('unsupported' in answer.body, false)
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('pick-directory returns the chosen path, and null when cancelled', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    assert.deepEqual(await post(host, 'pick-directory', {}), { status: 200, body: { ok: true, path: 'D:/codes' } })
    rec.shell.picked = null
    assert.deepEqual(await post(host, 'pick-directory', {}), { status: 200, body: { ok: true, path: null } })
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('open-logs forwards an empty body', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    assert.deepEqual(await post(host, 'open-logs', {}), { status: 200, body: { ok: true } })
    assert.deepEqual(rec.calls, [{ action: 'open-logs', body: {} }])
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('a cross-site Origin is refused by the fence', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'open-logs', {}, { origin: 'https://evil.example' })
    assert.equal(answer.status, 403)
    assert.equal(answer.body.ok, false)
    assert.deepEqual(rec.calls, [], 'a refused request never reaches the shell')
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test("the app's own page is admitted (Origin equal to the request Host)", async () => {
  // The dsh UI is served from the local server and posts from the Electron
  // window, so this same-origin form MUST pass — that is half the fence.
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'open-logs', {}, { origin: host.url })
    assert.deepEqual(answer, { status: 200, body: { ok: true } })
    assert.equal(rec.calls.length, 1)
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('a non-loopback Host is refused by the fence', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const body = '{}'
    const response = await rawRequest(host.port, [
      `POST ${ROUTE_PREFIX}/desktop/open-logs HTTP/1.1`,
      'Host: dsh.example',
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'))
    const answer = parseRaw(response)
    assert.equal(answer.status, 403)
    assert.equal(answer.body.ok, false)
    assert.deepEqual(rec.calls, [])
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('a loopback Host is admitted (the fence is not a blanket refusal)', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const body = '{}'
    const response = await rawRequest(host.port, [
      `POST ${ROUTE_PREFIX}/desktop/open-logs HTTP/1.1`,
      `Host: 127.0.0.1:${host.port}`,
      'Content-Type: application/json',
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'))
    assert.deepEqual(parseRaw(response), { status: 200, body: { ok: true } })
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('no bridge environment answers unsupported, never an error', async () => {
  const host = await startHost()
  unsetBridge()
  try {
    const answer = await post(host, 'save-text-as', { name: 'a.md', content: 'x' })
    assert.equal(answer.status, 200, 'unsupported is not a failure status')
    assert.deepEqual(answer.body, UNSUPPORTED_BODY)
  } finally {
    await host.close()
  }
})

test('a shell that does not offer the action (501) degrades to unsupported', async () => {
  const host = await startHost()
  // A dev shell with only some handlers: the bridge answers 501 for the rest.
  const bridge = await withBridge({ openLogs: () => Promise.resolve() })
  try {
    const answer = await post(host, 'pick-directory', {})
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, UNSUPPORTED_BODY)
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('a listening-but-dead bridge reports a failure, not unsupported', async () => {
  const host = await startHost()
  // Coordinates that point at a closed port: the env exists, nothing answers.
  process.env[BRIDGE_URL_ENV] = 'http://127.0.0.1:1'
  process.env[BRIDGE_TOKEN_ENV] = 'unused-in-this-test'
  try {
    const answer = await post(host, 'open-logs', {})
    assert.equal(answer.status, 502)
    assert.equal(answer.body.ok, false)
    assert.equal(answer.body.unsupported, false, 'transport death is not "environment unsupported"')
    // The page words this in its own language from the code, so the code is
    // the assertion — the English diagnostic is only a fallback.
    assert.equal(hostOf(answer.body).code, 'bridge.unreachable')
    assert.equal(typeof answer.body.error, 'string')
  } finally {
    unsetBridge()
    await host.close()
  }
})

test('a failing native action carries the shell message as coded data', async () => {
  const rec = recorder()
  const shellMessage = '无法打开：目标路径不存在'
  rec.shell.failure = new Error(shellMessage)
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const answer = await post(host, 'open-in-folder', { path: 'D:/missing' })
    assert.equal(answer.status, 502)
    assert.equal(answer.body.ok, false)
    // The sentence the shell wrote travels as a PARAM (this process cannot
    // translate it); the code is what the page keys its own copy on.
    assert.deepEqual(hostOf(answer.body), {
      code: 'bridge.nativeFailed',
      params: { detail: shellMessage },
      text: 'the native action failed (HTTP 500)',
    })
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('invalid input is refused before the bridge is called', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    const empty = await post(host, 'open-in-folder', { path: '' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.unsupported, false)

    const missing = await post(host, 'notify', { title: '标题' })
    assert.equal(missing.status, 400)

    const tooLong = await post(host, 'notify', { title: 'x'.repeat(201), body: '正文' })
    assert.equal(tooLong.status, 400)

    const notJson = await fetch(`${host.url}${ROUTE_PREFIX}/desktop/open-logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(notJson.status, 400)
    assert.deepEqual(hostOf(await notJson.json() as Record<string, unknown>), {
      code: 'route.invalidJson',
      text: 'request body is not valid JSON',
    })

    const wrongMethod = await fetch(`${host.url}${ROUTE_PREFIX}/desktop/open-logs`)
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('allow'), 'POST')
    assert.deepEqual(hostOf(await wrongMethod.json() as Record<string, unknown>), {
      code: 'route.methodOnly',
      params: { method: 'POST' },
      text: 'POST only',
    })

    assert.deepEqual(rec.calls, [], 'no invalid request reaches the shell')
  } finally {
    unsetBridge()
    await bridge.close()
    await host.close()
  }
})

test('the registered routes are removed by the returned disposer', async () => {
  const rec = recorder()
  const host = await startHost()
  const bridge = await withBridge(rec.handlers)
  try {
    assert.equal(host.registered(), 8, 'status + log tail + export + five actions')
  } finally {
    unsetBridge()
    await bridge.close()
  }
  await host.close()
  assert.equal(host.registered(), 0)
})
