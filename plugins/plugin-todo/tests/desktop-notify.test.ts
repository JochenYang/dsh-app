/**
 * The desktop-notification transport: the two hops a reminder takes to the shell,
 * with `fetch` standing in for both. What is pinned here is the fence — a first
 * hop that names any other address is refused as firmly as a failing one — and
 * the "never throws" contract, because the one caller is a watcher tick.
 *
 * @module @dsh-app/plugin-todo/tests/desktop-notify
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NOTIFY_ACTION_URL, clampNotifyText, notifyDesktop } from '../src/client/desktop-notify.ts'

/** Answer `fetch` in call order, recording every call; a function entry throws. */
function stubFetch(answers: Array<object | (() => never)>): { calls: Array<{ url: string, init: RequestInit | undefined }>, restore: () => void } {
  const original = globalThis.fetch
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = answers[calls.length - 1]
    if (next === undefined) throw new Error('unexpected fetch call')
    if (typeof next === 'function') next()
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('the two hops go to the brand route and then to the notify action exactly', async () => {
  const stub = stubFetch([{ ok: true, delegate: { url: NOTIFY_ACTION_URL, method: 'POST' } }, { ok: true }])
  try {
    assert.equal(await notifyDesktop('待办提醒', '有 1 条待办到期'), true)
    assert.deepEqual(stub.calls.map(call => call.url), ['/api/plugins/dsh-app/plugin-brand/desktop/notify', NOTIFY_ACTION_URL])
    for (const call of stub.calls) {
      assert.equal(call.init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(call.init?.body)), { title: '待办提醒', body: '有 1 条待办到期' }, 'the same two fields both hops')
    }
  } finally {
    stub.restore()
  }
})

test('a first hop that names any other address is refused before the second call', async () => {
  for (const url of [
    'https://example.com/__dsh-app/action/notify',
    'dsh-app://app/__dsh-app/action/restart-server',
    'dsh-app://app/other/notify',
    `${NOTIFY_ACTION_URL}?x=1`,
    'dsh-app://evil/__dsh-app/action/notify',
  ]) {
    const stub = stubFetch([{ ok: true, delegate: { url } }])
    try {
      assert.equal(await notifyDesktop('t', 'b'), false, url)
      assert.equal(stub.calls.length, 1, `${url}: nothing is sent to an address that is not the notify action`)
    } finally {
      stub.restore()
    }
  }
})

test('every other refusal and failure answers false without throwing', async () => {
  const refused: Array<Array<object | (() => never)>> = [
    [{ ok: false, unsupported: true }],
    [{ ok: false, error: 'nope' }],
    [{ ok: true, delegate: {} }],
    [(): never => { throw new Error('offline') }],
    [{ ok: true, delegate: { url: NOTIFY_ACTION_URL } }, (): never => { throw new Error('offline') }],
  ]
  for (const answers of refused) {
    const stub = stubFetch(answers)
    try {
      assert.equal(await notifyDesktop('t', 'b'), false)
    } finally {
      stub.restore()
    }
  }
  // A shell that answers 200 with ok:false is a refusal too.
  const stub = stubFetch([{ ok: true, delegate: { url: NOTIFY_ACTION_URL } }, { ok: false, code: 'shellAction.failed' }])
  try {
    assert.equal(await notifyDesktop('t', 'b'), false)
  } finally {
    stub.restore()
  }
})

test('a notification field is trimmed to the shell\u2019s cap with an ellipsis', () => {
  assert.equal(clampNotifyText('  short  ', 200), 'short')
  assert.equal(clampNotifyText('x'.repeat(250), 200).length, 200)
  assert.ok(clampNotifyText('x'.repeat(250), 200).endsWith('\u2026'))
  assert.equal(clampNotifyText('x'.repeat(250), 200).slice(0, 199), 'x'.repeat(199), 'the cut keeps the head')
})
