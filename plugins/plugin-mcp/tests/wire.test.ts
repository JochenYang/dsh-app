/**
 * External mcpServers JSON wiring tests: parse (wrapper vs bare vs malformed),
 * external definition mapping (stdio/http/inference/rejections), and the
 * entry → JSON view round trip.
 *
 * @module plugin-mcp/tests/wire
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { entryToExternal, invalidServerNameReason, mapExternalServer, McpValidationError, parseMcpServersJson, slugifyServerName } from '../src/wire.ts'

describe('parseMcpServersJson', () => {
  it('accepts a bare {"name": {...}} map', () => {
    const parsed = parseMcpServersJson('{"exa": {"type": "http", "url": "https://mcp.exa.ai/mcp"}}')
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]?.name, 'exa')
  })

  it('strips the {"mcpServers": {...}} wrapper', () => {
    const parsed = parseMcpServersJson(JSON.stringify({
      mcpServers: { context7: { type: 'stdio', command: 'npx' } },
    }))
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]?.name, 'context7')
  })

  it('rejects malformed JSON, non-object roots, and empty maps', () => {
    assert.throws(() => parseMcpServersJson('{not json'), McpValidationError)
    assert.throws(() => parseMcpServersJson('[1]'), McpValidationError)
    assert.throws(() => parseMcpServersJson('{}'), McpValidationError)
    assert.throws(() => parseMcpServersJson('{"a": "not-an-object"}'), McpValidationError)
  })
})

describe('mapExternalServer', () => {
  it('maps an http definition onto streamable-http with url passthrough', () => {
    const raw = mapExternalServer('exa', { type: 'http', url: 'https://mcp.exa.ai/mcp', toolCallTimeoutMs: 120000 })
    assert.equal(raw.serverName, 'exa')
    assert.equal(raw.transport, 'streamable-http')
    assert.equal(raw.url, 'https://mcp.exa.ai/mcp')
    assert.equal(raw.toolCallTimeoutMs, 120000)
  })

  it('maps a command definition onto stdio and infers transport when type is absent', () => {
    const explicit = mapExternalServer('context7', { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] })
    assert.equal(explicit.transport, 'stdio')
    assert.deepEqual(explicit.args, ['-y', '@upstash/context7-mcp'])

    const inferred = mapExternalServer('fs', { command: 'node', args: ['server.js'] })
    assert.equal(inferred.transport, 'stdio')

    const byUrl = mapExternalServer('web', { url: 'http://127.0.0.1:18764/mcp' })
    assert.equal(byUrl.transport, 'streamable-http')
  })

  it('accepts the VS Code type spellings and rejects SSE', () => {
    assert.equal(mapExternalServer('a', { type: 'streamable-http', url: 'https://x/mcp' }).transport, 'streamable-http')
    assert.equal(mapExternalServer('b', { type: 'streamable_http', url: 'https://x/mcp' }).transport, 'streamable-http')
    assert.throws(() => mapExternalServer('c', { type: 'sse', url: 'https://x/sse' }), McpValidationError)
    assert.throws(() => mapExternalServer('d', { type: 'websocket', url: 'wss://x' }), McpValidationError)
  })

  it('rejects invalid names, missing connection fields, and malformed args', () => {
    assert.throws(() => mapExternalServer('has space', { command: 'x' }), McpValidationError)
    assert.throws(() => mapExternalServer('ok', {}), McpValidationError)
    assert.throws(() => mapExternalServer('ok', { type: 'stdio' }), McpValidationError)
    assert.throws(() => mapExternalServer('ok', { command: 'x', args: [1, 2] }), McpValidationError)
    assert.throws(() => mapExternalServer('ok', { url: 'ftp://x' }), McpValidationError)
  })
})

describe('slugifyServerName', () => {
  it('normalizes display-name keys into valid server names', () => {
    assert.equal(slugifyServerName('Framelink MCP for Figma'), 'Framelink_MCP_for_Figma')
    assert.equal(slugifyServerName('  Figma  '), 'Figma')
    assert.equal(slugifyServerName('a/b:c'), 'a_b_c')
    assert.equal(slugifyServerName('already-valid_1'), 'already-valid_1')
  })

  it('returns undefined when no valid form exists', () => {
    assert.equal(slugifyServerName('   '), undefined)
    assert.equal(slugifyServerName('x'.repeat(40)), 'x'.repeat(32))
  })

  it('explains the tool-namespace contract in the rejection reason', () => {
    const reason = invalidServerNameReason('Framelink MCP for Figma')
    assert.match(reason, /mcp__/)
    assert.match(reason, /1–32/)
  })
})

describe('entryToExternal', () => {
  it('round-trips a stdio entry through the external fragment', () => {
    const fragment = entryToExternal({
      serverName: 'context7',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      toolCallTimeoutMs: 120000,
    })
    assert.deepEqual(fragment, {
      context7: { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], toolCallTimeoutMs: 120000 },
    })
  })

  it('omits empty collections and stamps http with its url', () => {
    const fragment = entryToExternal({ serverName: 'exa', transport: 'streamable-http', url: 'https://mcp.exa.ai/mcp' })
    assert.deepEqual(fragment, { exa: { type: 'http', url: 'https://mcp.exa.ai/mcp' } })
  })
})
