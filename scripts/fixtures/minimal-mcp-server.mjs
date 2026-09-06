#!/usr/bin/env node
/**
 * Minimal MCP stdio server used by the suite smoke probe
 * (scripts/smoke-suite.mjs) to verify the FULL dynamic-mount chain:
 * plugin-mcp -> loader -> @deepseek-ai/dsh-mcp-client -> tools registry.
 *
 * Speaks the MCP stdio transport (newline-delimited JSON-RPC 2.0) with just
 * enough surface for a client handshake plus one `echo` tool:
 *   initialize / notifications/initialized / tools/list / tools/call
 *
 * Run: node scripts/fixtures/minimal-mcp-server.mjs
 * @module smoke/minimal-mcp-server
 */

import { createInterface } from 'node:readline'

const SERVER_INFO = { name: 'dsh-app-smoke-echo', version: '0.1.0' }

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return // not JSON: ignore, a stdio server must not die on stderr noise
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's requested version: always mutually acceptable.
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    })
    return
  }
  if (method === 'tools/list') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echo the input text back, prefixed with "echo:".',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo.' } },
            required: ['text'],
          },
        }],
      },
    })
    return
  }
  if (method === 'tools/call') {
    const text = typeof params?.arguments?.text === 'string' ? params.arguments.text : ''
    write({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo: ${text}` }] },
    })
    return
  }
  if (id !== undefined && id !== null) {
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } })
  }
})

process.on('disconnect', () => process.exit(0))
