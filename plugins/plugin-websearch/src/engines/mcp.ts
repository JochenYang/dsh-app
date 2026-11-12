/**
 * Shared JSON-RPC-over-HTTP helper for the hosted MCP endpoints (Exa,
 * Parallel).
 *
 * Both providers publish an anonymous, keyless MCP server over Streamable
 * HTTP. Calling one is a single `tools/call` POST — no `initialize`
 * handshake, no session reuse, no SSE streaming: verified against both live
 * endpoints, which answer a bare `tools/call` with 200 and results. Keeping
 * the call stateless means one search cannot leak a session into the next,
 * and there is no connection state to re-establish after a failure.
 *
 * Response framing differs between the two (Exa replies with an SSE
 * `data:` frame, Parallel with a plain JSON body), so this helper normalizes
 * both into the JSON-RPC envelope and lets each engine own its own result
 * parsing.
 *
 * A user key travels as a request HEADER (Exa and Parallel both document
 * `x-api-key` for the hosted MCP server; Exa's OAuth token would travel as
 * `Authorization: Bearer`). Without one the call is anonymous, which is why
 * `headers` is optional rather than a required argument.
 *
 * @module @dsh-app/plugin-websearch/engines/mcp
 */

import { HttpError, request } from './types.ts'

/** The JSON-RPC envelope both endpoints answer with. */
interface JsonRpcResponse {
  readonly result?: {
    readonly content?: readonly { readonly type?: unknown, readonly text?: unknown }[]
    readonly isError?: unknown
  }
  readonly error?: { readonly message?: unknown }
}

/**
 * Pull the JSON-RPC envelope out of a response body. Handles the SSE frame
 * (`data: {...}`) and the plain-JSON body; anything else is an error, because
 * a non-envelope body means the endpoint changed its transport contract.
 */
export function parseJsonRpc(text: string): JsonRpcResponse {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('response is empty')
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse
    } catch {
      throw new Error('response is not valid JSON')
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      return JSON.parse(line.slice(6)) as JsonRpcResponse
    } catch {
      // A malformed frame is skipped rather than fatal: the SSE stream may
      // carry keep-alive or comment frames before the payload.
      continue
    }
  }
  throw new Error('response carries no parsable JSON-RPC frame')
}

/**
 * Call one tool on a hosted MCP endpoint and return its text content blocks
 * joined. Throws on a JSON-RPC error, a transport error, or an empty result.
 *
 * @param url - the endpoint (no query string; credentials go in headers).
 * @param tool - the tool name the endpoint documents.
 * @param args - the tool arguments.
 * @param signal - the caller's composed cancellation signal.
 * @param headers - extra request headers, i.e. the user's key.
 */
export async function callMcpTool(
  url: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<string> {
  const response = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
    signal,
  })
  if (!response.ok) throw new HttpError(response.status)
  const envelope = parseJsonRpc(await response.text())
  if (envelope.error !== undefined) {
    const message = typeof envelope.error.message === 'string' ? envelope.error.message : 'unknown error'
    throw new Error(`MCP returned an error: ${message}`)
  }
  const blocks = envelope.result?.content
  if (!Array.isArray(blocks)) throw new Error('MCP response has no content field')
  const text = blocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
  if (text.trim() === '') throw new Error('MCP returned empty content')
  if (envelope.result?.isError === true) {
    // Exa reports auth and quota failures IN BAND: HTTP 200, `isError: true`,
    // and the status inside the text — measured live as
    // "web_search_exa error (401): Invalid API key. …". The retry policy and
    // the settings badge both need the STATUS, not the sentence, so it is
    // lifted out here rather than arriving at the chain as an ordinary
    // failure that no key rotation could react to.
    const detail = text.split('\n')[0]?.slice(0, 200) ?? ''
    const status = /error \((\d{3})\)/.exec(text)?.[1]
    throw status === undefined
      ? new Error(`MCP tool call failed: ${detail}`)
      : new HttpError(Number(status), detail)
  }
  return text
}
