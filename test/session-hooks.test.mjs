// The one-listener rule: Electron keeps only the LAST `onBeforeSendHeaders`
// listener per session (measured on 44.4.1 — a request matched by the first
// filter arrived with neither hook's headers), so two independent registrations
// silently disable the earlier one. That is exactly how the stream-auth rule took
// every desktop action down to `no initiator stamp` in 0.12.1. This suite pins
// the composition: one install, every rule reached, first refusal wins.
// Run after the build: node --test test/   (or: npm test)
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { installSessionHeaderRules } = require('../dist/main/session-hooks.js')

/** A session stand-in that records every registration. */
function fakeSession() {
  const installed = []
  return {
    installed,
    webRequest: {
      onBeforeSendHeaders: (filter, handler) => { installed.push({ filter, handler }) },
    },
  }
}

/** Fire the one installed listener over one request. */
function fire(handler, url, extra = {}) {
  let answer
  handler({ url, requestHeaders: {}, ...extra }, (result) => { answer = result })
  return answer
}

test('several rules register ONE listener, with the union of their filters', () => {
  const session = fakeSession()
  installSessionHeaderRules(session, [
    { urls: ['dsh-app://app/__dsh-app/*'], handle: () => false },
    { urls: ['ws://127.0.0.1/*'], handle: () => false },
  ])
  assert.equal(session.installed.length, 1, 'a second registration would disable the first')
  assert.deepEqual(session.installed[0].filter, {
    urls: ['dsh-app://app/__dsh-app/*', 'ws://127.0.0.1/*'],
  })
})

test('a duplicate filter is de-duplicated, not repeated', () => {
  const session = fakeSession()
  installSessionHeaderRules(session, [
    { urls: ['ws://127.0.0.1/*'], handle: () => false },
    { urls: ['ws://127.0.0.1/*'], handle: () => false },
  ])
  assert.deepEqual(session.installed[0].filter.urls, ['ws://127.0.0.1/*'])
})

test('rules get first refusal in order, and an unclaimed request passes through', () => {
  const session = fakeSession()
  const reached = []
  installSessionHeaderRules(session, [
    {
      urls: ['dsh-app://app/__dsh-app/*'],
      handle: (details, callback) => {
        reached.push('stamp')
        // A rule decides by what it sees, not by assuming the filter ran for it:
        // Electron applies each URL pattern before this dispatch is reached, but
        // a rule that claims every request would starve the ones after it.
        if (!details.url.startsWith('dsh-app://app/__dsh-app/')) return false
        callback({ requestHeaders: { stamped: 'yes' } })
        return true
      },
    },
    {
      urls: ['ws://127.0.0.1/*'],
      handle: (details, callback) => {
        reached.push('stream')
        if (new URL(details.url).protocol !== 'ws:') return false
        callback({ requestHeaders: { streamed: 'yes' } })
        return true
      },
    },
  ])
  const { handler } = session.installed[0]

  assert.deepEqual(fire(handler, 'dsh-app://app/__dsh-app/action/open-logs'), { requestHeaders: { stamped: 'yes' } })
  // The first rule owns its URL and the second is not consulted for it — that is
  // what keeps two jobs from both rewriting one request's headers.
  assert.deepEqual(reached, ['stamp'])

  assert.deepEqual(fire(handler, 'ws://127.0.0.1:19387/stream'), { requestHeaders: { streamed: 'yes' } })
  // Every rule is OFFERED each request (the filter only decides which requests
  // Electron wakes the listener for), so the stamp rule sees this one and
  // declines it before the stream rule claims it.
  assert.deepEqual(reached, ['stamp', 'stamp', 'stream'])

  // Neither rule's URL: the request leaves with untouched headers, not dropped.
  assert.deepEqual(fire(handler, 'https://example.invalid/x'), {})
})

test('a rule that declines is not asked again, and later rules still run', () => {
  const session = fakeSession()
  const reached = []
  installSessionHeaderRules(session, [
    {
      urls: ['dsh-app://app/__dsh-app/*'],
      handle: () => { reached.push('declines'); return false },
    },
    {
      urls: ['ws://127.0.0.1/*'],
      handle: (_details, callback) => { reached.push('owns'); callback({ cancel: true }); return true },
    },
  ])
  assert.deepEqual(fire(session.installed[0].handler, 'ws://127.0.0.1:1/x'), { cancel: true })
  assert.deepEqual(reached, ['declines', 'owns'])
})
