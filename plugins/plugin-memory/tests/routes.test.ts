/**
 * Unit tests for the settings-route guards (same-origin semantics).
 *
 * @module @dsh-app/plugin-memory/tests/routes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { sameOrigin } from '../src/routes.ts'

const req = (headers: Record<string, string | undefined>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage)

test('sameOrigin: browser Origin (with scheme) matches the Host header', () => {
  assert.equal(sameOrigin(req({ origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' })), true)
  assert.equal(sameOrigin(req({ origin: 'http://localhost:3080', host: 'localhost:3080' })), true)
})

test('sameOrigin: a missing Origin header is a non-browser caller — allowed', () => {
  assert.equal(sameOrigin(req({ origin: undefined, host: '127.0.0.1:3080' })), true)
})

test('sameOrigin: cross-origin and malformed origins are rejected', () => {
  assert.equal(sameOrigin(req({ origin: 'http://evil.example', host: '127.0.0.1:3080' })), false)
  assert.equal(sameOrigin(req({ origin: 'not a url', host: '127.0.0.1:3080' })), false)
  assert.equal(sameOrigin(req({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3080' })), false)
})
