/**
 * Routes-layer behavior tests over pure helpers: the same-origin fence and
 * the secret mask/unmask round trip (literal values are never returned to
 * the client; a mask sentinel sent back keeps the stored value).
 *
 * @module plugin-mcp/tests/routes
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { maskSecretValues, sameOrigin, unmaskSecretValues, VALUE_MASK } from '../src/routes.ts'
import { McpValidationError } from '../src/store.ts'
import type { McpServerEntry } from '../src/wire.ts'

function requestWith(headers: Record<string, string | undefined>): import('node:http').IncomingMessage {
  return { headers } as unknown as import('node:http').IncomingMessage
}

const STORED: McpServerEntry = {
  id: 'mcp-1',
  serverName: 'github',
  transport: 'stdio',
  enabled: true,
  command: 'npx',
  env: { GITHUB_TOKEN: 'gh_secret_value', HOME_REF: '$ENV:HOME' },
}

describe('sameOrigin fence', () => {
  it('allows a request without an Origin header (non-browser caller)', () => {
    assert.equal(sameOrigin(requestWith({ host: '127.0.0.1:3080' })), true)
  })

  it('allows an Origin whose host matches the request Host', () => {
    assert.equal(sameOrigin(requestWith({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' })), true)
  })

  it('rejects a cross-origin Origin and an unparseable Origin', () => {
    assert.equal(sameOrigin(requestWith({ host: '127.0.0.1:3080', origin: 'http://evil.example:80' })), false)
    assert.equal(sameOrigin(requestWith({ host: '127.0.0.1:3080', origin: '::not a url::' })), false)
  })
})

describe('secret masking round trip', () => {
  it('masks literal env values on read but keeps $ENV: references verbatim', () => {
    const masked = maskSecretValues(STORED)
    assert.equal(masked.env?.GITHUB_TOKEN, VALUE_MASK)
    assert.equal(masked.env?.HOME_REF, '$ENV:HOME')
    assert.equal(masked.command, STORED.command)
  })

  it('masks literal headers and keeps the URL untouched', () => {
    const entry: McpServerEntry = {
      id: 'mcp-2',
      serverName: 'web',
      transport: 'streamable-http',
      enabled: true,
      url: 'http://127.0.0.1:3000/mcp',
      headers: { Authorization: 'Bearer plain-secret' },
    }
    const masked = maskSecretValues(entry)
    assert.equal(masked.url, entry.url)
    assert.equal(masked.headers?.Authorization, VALUE_MASK)
  })

  it('restores stored values when the client sends the mask sentinel back', () => {
    const masked = maskSecretValues(STORED)
    const restored = unmaskSecretValues({ ...masked, enabled: true }, STORED)
    assert.equal((restored.env as Record<string, string>).GITHUB_TOKEN, 'gh_secret_value')
    assert.equal((restored.env as Record<string, string>).HOME_REF, '$ENV:HOME')
  })

  it('rejects a mask sentinel with no stored value behind it', () => {
    assert.throws(
      () => unmaskSecretValues({ env: { NEW_TOKEN: VALUE_MASK } }, undefined),
      McpValidationError,
    )
  })

  it('rejects a non-string value inside a secret map', () => {
    assert.throws(
      () => unmaskSecretValues({ env: { KEY: 42 } }, STORED),
      McpValidationError,
    )
  })

  it('passes through unmasked literal values unchanged', () => {
    const restored = unmaskSecretValues({ env: { KEY: 'plain' } }, undefined)
    assert.equal((restored.env as Record<string, string>).KEY, 'plain')
  })
})
