/**
 * External mcpServers JSON wiring tests: parse (wrapper vs bare vs malformed),
 * external definition mapping (stdio/http/inference/rejections), and the
 * entry → JSON view round trip.
 *
 * @module plugin-mcp/tests/wire
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  assertUniqueServerName,
  entryToExternal,
  invalidServerNameError,
  mapExternalServer,
  McpValidationError,
  parseMcpServersJson,
  slugifyServerName,
  validateEntry,
} from '../src/wire.ts'

/** A valid stdio entry body, as the settings form posts it. */
const VALID_STDIO = {
  serverName: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_TOKEN: '$ENV:GITHUB_TOKEN' },
}

/**
 * The stable code a rejection carries. Assertions moved from matching the
 * (now client-side) sentence to the code, which is the contract the host half
 * actually owns.
 * @param run - the call expected to throw.
 * @returns the thrown code, or a marker describing what happened instead.
 */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof McpValidationError ? error.code : `not-a-validation-error:${String(error)}`
  }
  return 'no-error'
}

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
    assert.equal(codeOf(() => parseMcpServersJson('{not json')), 'json.parseFailed')
    assert.equal(codeOf(() => parseMcpServersJson('[1]')), 'json.notObject')
    assert.equal(codeOf(() => parseMcpServersJson('{}')), 'json.noServers')
    assert.equal(codeOf(() => parseMcpServersJson('{"a": "not-an-object"}')), 'json.serverNotObject')
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
    assert.equal(codeOf(() => mapExternalServer('c', { type: 'sse', url: 'https://x/sse' })), 'type.sse')
    assert.equal(codeOf(() => mapExternalServer('d', { type: 'websocket', url: 'wss://x' })), 'type.unknown')
  })

  it('rejects invalid names, missing connection fields, and malformed args', () => {
    assert.throws(() => mapExternalServer('has space', { command: 'x' }), McpValidationError)
    assert.throws(() => mapExternalServer('ok', {}), McpValidationError)
    assert.throws(() => mapExternalServer('ok', { type: 'stdio' }), McpValidationError)
    assert.throws(() => mapExternalServer('ok', { command: 'x', args: [1, 2] }), McpValidationError)
    assert.throws(() => mapExternalServer('ok', { url: 'ftp://x' }), McpValidationError)
    assert.equal(codeOf(() => mapExternalServer('has space', { command: 'x' })), 'serverName.invalid')
    assert.equal(codeOf(() => mapExternalServer('ok', {})), 'server.noConnectionField')
    assert.equal(codeOf(() => mapExternalServer('ok', { type: 'stdio' })), 'server.missingCommand')
    assert.equal(codeOf(() => mapExternalServer('ok', { command: 'x', args: [1, 2] })), 'server.argsNotArray')
    assert.equal(codeOf(() => mapExternalServer('ok', { url: 'ftp://x' })), 'server.urlNotHttp')
    assert.equal(codeOf(() => mapExternalServer('ok', { url: 'https://x/mcp', headers: { A: 1 } })), 'server.fieldStringValue')
  })
})

describe('coded validation', () => {
  it('throws a code plus its params instead of a sentence', () => {
    assert.deepEqual(
      invalidServerNameError('Framelink MCP for Figma').hostText(),
      { code: 'serverName.invalid', params: { name: 'Framelink MCP for Figma' } },
    )
    assert.equal(codeOf(() => validateEntry(null, new Set())), 'entry.notObject')
    assert.equal(codeOf(() => validateEntry({ serverName: 'a', transport: 'stdio', command: 'x' }, new Set())), 'entry.badId')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', serverName: 'x'.repeat(33) }, new Set())), 'serverName.pattern')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', transport: 'sse' }, new Set())), 'transport.invalid')
    assert.equal(codeOf(() => validateEntry({ id: 'mcp-1', serverName: 'a', transport: 'stdio' }, new Set())), 'stdio.commandRequired')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', args: [1] }, new Set())), 'stdio.argsNotArray')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', cwd: '' }, new Set())), 'stdio.cwdRequired')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', env: { A: 1 } }, new Set())), 'field.stringValue')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', env: 'nope' }, new Set())), 'field.keyValue')
    assert.equal(codeOf(() => validateEntry({ id: 'mcp-1', serverName: 'a', transport: 'streamable-http', url: 'ftp://x' }, new Set())), 'http.urlInvalid')
    assert.equal(codeOf(() => validateEntry({ ...VALID_STDIO, id: 'mcp-1', toolCallTimeoutMs: 0 }, new Set())), 'timeout.notPositive')
  })

  it('carries the duplicate-namespace code with the clashing name', () => {
    const entry = validateEntry({ ...VALID_STDIO, id: 'mcp-2' }, new Set())
    assert.equal(codeOf(() => assertUniqueServerName(entry, [{ ...entry, id: 'mcp-1' }])), 'serverName.duplicate')
    assert.throws(
      () => assertUniqueServerName(entry, [{ ...entry, id: 'mcp-1' }]),
      (error: unknown) => error instanceof McpValidationError && error.params?.name === 'github',
    )
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
