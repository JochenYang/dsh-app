/**
 * Wire-level suite for plugin-brand's desktop action routes.
 *
 * The Connection exact-Fetch registry (`./host-harness.ts`) dispatches every
 * request the way the shared `/api` channel does, so paths, methods, status
 * codes and JSON shapes are exercised on the request objects a route sees.
 *
 * Three groups are covered here:
 *
 *   - the two KERNEL-performed actions, driven through fake seams (the real ones
 *     spawn Explorer or open an OS dialog): `open-in-folder` reveals a path
 *     through `ctx.sessionController`, `pick-directory` through
 *     `ctx.directoryPicker`'s native capability. What this suite pins is the
 *     mapping — which body reaches the seam, and what each outcome turns into.
 *   - the three SHELL-performed actions, which cannot be forwarded from this
 *     process at all (their route lives on the `dsh-app` scheme, which only
 *     Electron resolves). What the routes own is the answer: a validated
 *     payload, the exact URL the CLIENT must call, or `unsupported` when the
 *     environment has no such route — including when the published value points
 *     somewhere that is not the app's own origin.
 *   - availability (`/status`), which is the same question the page's badge
 *     asks.
 *
 * Nobody fences these routes here: the Connection carrier applies its Host/Origin
 * check and browser authentication before a handler runs, so the routes must NOT
 * re-check them (see the module header of `../src/routes.ts`). The fence that
 * belongs to the shell's route is tested where it lives — `test/shell-actions.test.mjs`
 * in the app shell.
 *
 * Tests in one file run sequentially, so the shared `process.env` variable is
 * safe; each test restores it.
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { SHELL_ACTIONS_ENV } from '../src/shell-actions.ts'
import type { DirectoryPicker, SessionOpener } from '../src/native-actions.ts'
import { ROUTE_PREFIX, UNSUPPORTED_HOST } from '../src/routes.ts'
import { startHost, type FakeNativeSeams, type Host, type JsonAnswer } from './host-harness.ts'

/** What the shell publishes: its action route's base URL. */
const ACTION_BASE = 'dsh-app://app/__dsh-app/action'

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

/** A fake `ctx.sessionController`, recording the reveal it was asked for. */
interface OpenerFake {
  seam: SessionOpener
  calls: Array<{ path: string; action?: 'reveal' }>
  /** Flip to make the host report that it has no desktop. */
  hasDesktop: boolean
  /** Set to fail the native call. */
  failure: Error | null
}

function openerFake(): OpenerFake {
  const fake: OpenerFake = {
    calls: [],
    hasDesktop: true,
    failure: null,
    seam: {
      canOpenWorkspacePath: () => fake.hasDesktop,
      openWorkspacePath: (request) => {
        if (fake.failure !== null) return Promise.reject(fake.failure)
        fake.calls.push({ path: request.path, ...(request.action === undefined ? {} : { action: request.action }) })
        return Promise.resolve({ opened: true })
      },
    },
  }
  return fake
}

/** A fake `ctx.directoryPicker` with one capability, recording the signal. */
interface PickerFake {
  seam: DirectoryPicker
  picks: number
  /** The capability kind the fake reports. */
  kind: string
  /** What one pick answers; null means the operator cancelled. */
  answer: string | null
  failure: Error | null
}

function pickerFake(kind = 'native'): PickerFake {
  const fake: PickerFake = {
    picks: 0,
    kind,
    answer: 'D:/codes',
    failure: null,
    seam: {
      capability: () => ({
        kind: fake.kind,
        pick: () => {
          fake.picks += 1
          if (fake.failure !== null) return Promise.reject(fake.failure)
          return Promise.resolve(fake.answer)
        },
      }),
    },
  }
  return fake
}

const savedEnv = process.env[SHELL_ACTIONS_ENV]

after(() => {
  if (savedEnv === undefined) delete process.env[SHELL_ACTIONS_ENV]
  else process.env[SHELL_ACTIONS_ENV] = savedEnv
})

/** Publish the action route the way the shell does. */
function publishShellActions(): void {
  process.env[SHELL_ACTIONS_ENV] = ACTION_BASE
}

/** Simulate a run with no such route (a bare `dsh`, or an older shell). */
function unpublishShellActions(): void {
  delete process.env[SHELL_ACTIONS_ENV]
}

async function post(
  host: Host,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonAnswer> {
  return host.call(`${ROUTE_PREFIX}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('status reports whether the shell published a desktop action route', async () => {
  const host = await startHost()
  publishShellActions()
  try {
    assert.deepEqual(await host.call(`${ROUTE_PREFIX}/status`), { status: 200, body: { ok: true, bridge: true } })
  } finally {
    await host.close()
  }

  unpublishShellActions()
  const bare = await startHost()
  try {
    assert.deepEqual(await bare.call(`${ROUTE_PREFIX}/status`), { status: 200, body: { ok: true, bridge: false } })
  } finally {
    await bare.close()
  }
})

test('open-in-folder reveals the path through the kernel seam', async () => {
  const fake = openerFake()
  const host = await startHost({ opener: fake.seam })
  try {
    const answer = await post(host, '/desktop/open-in-folder', { path: 'D:/codes/DSH-APP' })
    assert.equal(answer.status, 200)
    assert.deepEqual(answer.body, { ok: true })
    // `reveal`, not a plain open: the gesture means "select it in its folder".
    assert.deepEqual(fake.calls, [{ path: 'D:/codes/DSH-APP', action: 'reveal' }])
  } finally {
    await host.close()
  }
})

test('open-in-folder is unsupported where the kernel has no desktop opener', async () => {
  const fake = openerFake()
  fake.hasDesktop = false
  const host = await startHost({ opener: fake.seam })
  try {
    assert.deepEqual(await post(host, '/desktop/open-in-folder', { path: 'D:/codes' }), { status: 200, body: UNSUPPORTED_BODY })
    assert.deepEqual(fake.calls, [])
  } finally {
    await host.close()
  }

  // A composition without the service at all reads the same way: this is what
  // keeps `inject: ['connection']` enough for the whole plugin to activate.
  const vanilla = await startHost()
  try {
    assert.deepEqual(await post(vanilla, '/desktop/open-in-folder', { path: 'D:/codes' }), { status: 200, body: UNSUPPORTED_BODY })
  } finally {
    await vanilla.close()
  }
})

test('a failing native call is a coded failure, not unsupported', async () => {
  const fake = openerFake()
  fake.failure = new Error('explorer refused the path')
  const host = await startHost({ opener: fake.seam })
  try {
    const answer = await post(host, '/desktop/open-in-folder', { path: 'D:/missing' })
    assert.equal(answer.status, 502)
    assert.equal(answer.body.unsupported, false, 'a failed spawn is not "environment unsupported"')
    assert.deepEqual(hostOf(answer.body), {
      code: 'native.failed',
      params: { detail: 'explorer refused the path' },
      text: 'the native action failed: explorer refused the path',
    })
  } finally {
    await host.close()
  }
})

test('pick-directory answers the chosen path, and null when cancelled', async () => {
  const fake = pickerFake()
  const host = await startHost({ picker: fake.seam })
  try {
    assert.deepEqual(await post(host, '/desktop/pick-directory', {}), { status: 200, body: { ok: true, path: 'D:/codes' } })
    fake.answer = null
    assert.deepEqual(await post(host, '/desktop/pick-directory', {}), { status: 200, body: { ok: true, path: null } })
    assert.equal(fake.picks, 2)
  } finally {
    await host.close()
  }
})

test('pick-directory is unsupported for a browse backend and with no picker at all', async () => {
  const browse = pickerFake('browse')
  const host = await startHost({ picker: browse.seam })
  try {
    // The in-app browser is the client's own surface; this route only serves the
    // OS chooser, so it must say so instead of picking something else.
    assert.deepEqual(await post(host, '/desktop/pick-directory', {}), { status: 200, body: UNSUPPORTED_BODY })
    assert.equal(browse.picks, 0)
  } finally {
    await host.close()
  }

  const vanilla = await startHost()
  try {
    assert.deepEqual(await post(vanilla, '/desktop/pick-directory', {}), { status: 200, body: UNSUPPORTED_BODY })
  } finally {
    await vanilla.close()
  }
})

test('the shell-performed actions answer the coordinates the client must call', async () => {
  publishShellActions()
  const host = await startHost()
  try {
    for (const [action, body] of [
      ['open-logs', {}],
      ['notify', { title: '导出完成', body: '文件已保存' }],
      ['save-text-as', { name: 'report.md', content: '# 报告\n' }],
      // The office-payload trio takes no field at all: which payload version is
      // needed is the shell's own knowledge (the active kernel manifest).
      ['office-payload-state', {}],
      ['office-payload-download', {}],
      ['office-payload-cancel', {}],
    ]) {
      const answer = await post(host, `/desktop/${action}`, body)
      assert.equal(answer.status, 200, action)
      assert.deepEqual(answer.body, {
        ok: true,
        delegate: { url: `${ACTION_BASE}/${action}`, method: 'POST' },
      })
      // Nothing here may claim the action was performed.
      assert.equal('path' in answer.body, false, action)
      assert.equal('unsupported' in answer.body, false, action)
    }
  } finally {
    await host.close()
  }
})

test('a shell seam that is not the app origin is refused, not obeyed', async () => {
  // The page sends the user's text to whatever this value names, so a value
  // pointing anywhere else must read as "no desktop actions".
  process.env[SHELL_ACTIONS_ENV] = 'https://evil.example/collect'
  const host = await startHost()
  try {
    assert.deepEqual(await host.call(`${ROUTE_PREFIX}/status`), { status: 200, body: { ok: true, bridge: false } })
    assert.deepEqual(await post(host, '/desktop/notify', { title: 't', body: 'b' }), { status: 200, body: UNSUPPORTED_BODY })
    assert.deepEqual(await post(host, '/desktop/save-text-as', { name: 'a.md', content: 'x' }), { status: 200, body: UNSUPPORTED_BODY })
  } finally {
    unpublishShellActions()
    await host.close()
  }
})

test('no shell seam at all answers unsupported, never an error', async () => {
  const host = await startHost()
  unpublishShellActions()
  try {
    const answer = await post(host, '/desktop/save-text-as', { name: 'a.md', content: 'x' })
    assert.equal(answer.status, 200, 'unsupported is not a failure status')
    assert.deepEqual(answer.body, UNSUPPORTED_BODY)
    assert.deepEqual(await post(host, '/desktop/open-logs', {}), { status: 200, body: UNSUPPORTED_BODY })
  } finally {
    await host.close()
  }
})

test('invalid input is refused before any action runs', async () => {
  publishShellActions()
  const fake = openerFake()
  const host = await startHost({ opener: fake.seam })
  try {
    const empty = await post(host, '/desktop/open-in-folder', { path: '' })
    assert.equal(empty.status, 400)
    assert.equal(empty.body.unsupported, false)

    const missing = await post(host, '/desktop/notify', { title: '标题' })
    assert.equal(missing.status, 400)

    const tooLong = await post(host, '/desktop/notify', { title: 'x'.repeat(201), body: '正文' })
    assert.equal(tooLong.status, 400)

    const longName = await post(host, '/desktop/save-text-as', { name: 'x'.repeat(129), content: 'x' })
    assert.equal(longName.status, 400, 'the name cap is the shell route’s own cap')

    // A raw, malformed body (not routed through the JSON-stringifying helper).
    const notJson = await host.call(`${ROUTE_PREFIX}/desktop/open-logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(notJson.status, 400)
    assert.deepEqual(hostOf(notJson.body), {
      code: 'route.invalidJson',
      text: 'request body is not valid JSON',
    })

    // The route cap is checked from the declared length, so an oversized body is
    // refused without buffering it.
    const oversized = await host.call(`${ROUTE_PREFIX}/desktop/open-logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(9 * 1024 * 1024) },
      body: '{}',
    })
    assert.equal(oversized.status, 413)
    assert.equal(hostOf(oversized.body).code, 'route.bodyTooLarge')

    assert.deepEqual(fake.calls, [], 'no invalid request reaches a kernel seam')
  } finally {
    unpublishShellActions()
    await host.close()
  }
})

test('an unknown path, an unknown method and the old web-server prefix are the channel 404', async () => {
  const fake = openerFake()
  const host = await startHost({ opener: fake.seam })
  try {
    // The registry owns methods: a GET on a POST-only route never reaches the
    // route body (the shared channel answers its own 404).
    assert.equal((await host.call(`${ROUTE_PREFIX}/desktop/open-in-folder`)).status, 404)
    assert.equal((await host.call(`${ROUTE_PREFIX}/nope`)).status, 404)
    // The web-server namespace is gone with the web server: the client must call
    // the `/api` prefix (plugin-client-ui still points at the old one).
    assert.equal((await host.call('/plugins/@dsh-app/plugin-brand/api/status')).status, 404)
    assert.deepEqual(fake.calls, [])
  } finally {
    await host.close()
  }
})

test('the registered routes are removed by the returned disposer', async () => {
  const host = await startHost()
  assert.equal(host.registered(), 12, 'status + log tail + export + nine actions')
  await host.close()
  assert.equal(host.registered(), 0)
})
