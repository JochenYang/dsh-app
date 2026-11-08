/**
 * The probe plan, pinned.
 *
 * These tests exist for the four decisions a wrong probe would get wrong
 * silently, all of them security-shaped:
 *
 *   1. **The endpoint comes from the profile** — so the plan only ever builds a
 *      URL out of a validated http(s) base, and refuses `ftp:`, `file:` and a
 *      userinfo-carrying URL instead of normalising them.
 *   2. **The credential header is the probe's** — a copied gateway header must
 *      not be able to override `authorization`/`x-api-key`, and a CR/LF in a
 *      name or value must not be able to inject one.
 *   3. **Anthropic hangs off the root** — a base ending in `/v1` must not
 *      produce `/v1/v1/messages`.
 *   4. **No key is a valid request** — local endpoints (Ollama) need none, so
 *      the plan sends no auth header rather than refusing to probe.
 *
 * @module plugin-client-ui/tests/probe
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { planProbe } from '../src/probe-wire.ts'

/** A planned request, or a test failure that names the refusal. */
function planned(input: Parameters<typeof planProbe>[0]): Extract<ReturnType<typeof planProbe>, { ok: true }> {
  const plan = planProbe(input)
  assert.equal(plan.ok, true, plan.ok ? '' : `${plan.code}: ${plan.text}`)
  return plan as Extract<ReturnType<typeof planProbe>, { ok: true }>
}

describe('planProbe', () => {
  it('builds the chat-completions path and a one-token body', () => {
    const plan = planned({
      baseURL: 'https://api.example.com/v1/', api: 'openai-completions', model: 'demo', apiKey: 'sk-1',
    })
    assert.equal(plan.url, 'https://api.example.com/v1/chat/completions')
    assert.equal(plan.headers.authorization, 'Bearer sk-1')
    assert.deepEqual(JSON.parse(plan.body), {
      model: 'demo', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false,
    })
  })

  it('builds the responses path with the smallest budget every model accepts', () => {
    const plan = planned({ baseURL: 'https://api.example.com/v1', api: 'openai-responses', model: 'demo' })
    assert.equal(plan.url, 'https://api.example.com/v1/responses')
    assert.deepEqual(JSON.parse(plan.body), { model: 'demo', input: 'ping', max_output_tokens: 16, stream: false })
  })

  it('puts anthropic messages on the root and uses x-api-key', () => {
    const fromV1 = planned({ baseURL: 'https://api.anthropic.com/v1', api: 'anthropic-messages', model: 'claude', apiKey: 'k' })
    assert.equal(fromV1.url, 'https://api.anthropic.com/v1/messages')
    assert.equal(fromV1.headers['x-api-key'], 'k')
    assert.equal(fromV1.headers['anthropic-version'], '2023-06-01')
    assert.equal(fromV1.headers.authorization, undefined)
    const fromRoot = planned({ baseURL: 'https://api.anthropic.com', api: 'anthropic-messages', model: 'claude' })
    assert.equal(fromRoot.url, 'https://api.anthropic.com/v1/messages')
  })

  it('sends no auth header when the route has no resolvable key', () => {
    const plan = planned({ baseURL: 'http://127.0.0.1:11434/v1', api: 'openai-completions', model: 'llama' })
    assert.equal(plan.headers.authorization, undefined)
    assert.equal(plan.headers['x-api-key'], undefined)
  })

  it('keeps the anthropic version header even when no key is configured', () => {
    const plan = planned({ baseURL: 'http://127.0.0.1:8080', api: 'anthropic-messages', model: 'local' })
    assert.equal(plan.headers['anthropic-version'], '2023-06-01')
    assert.equal(plan.headers['x-api-key'], undefined)
  })

  it('refuses a base URL carrying a query string or fragment', () => {
    for (const baseURL of ['https://api.example.com/v1?x=1', 'https://api.example.com/v1#frag']) {
      const plan = planProbe({ baseURL, api: 'openai-completions', model: 'm' })
      assert.equal(plan.ok, false)
      assert.equal(plan.ok ? '' : plan.code, 'probe.invalidBaseUrl')
    }
  })

  it('copies gateway headers but drops framing names and CR/LF values', () => {
    const plan = planned({
      baseURL: 'https://gw.example.com/v1',
      api: 'openai-completions',
      model: 'm',
      apiKey: 'sk-1',
      headers: {
        'x-opencode-session': 'abc',
        host: 'evil.example.com',
        'content-length': '999',
        'x-bad': 'a\r\nx-injected: 1',
        authorization: 'Bearer attacker',
      },
    })
    assert.equal(plan.headers['x-opencode-session'], 'abc')
    assert.equal(plan.headers.host, undefined)
    assert.equal(plan.headers['content-length'], undefined)
    assert.equal(plan.headers['x-bad'], undefined)
    // The resolved credential wins over a copied header.
    assert.equal(plan.headers.authorization, 'Bearer sk-1')
  })

  it('refuses a non-http base, a userinfo base and an empty base', () => {
    const ftp = planProbe({ baseURL: 'ftp://example.com/v1', api: 'openai-completions', model: 'm' })
    assert.equal(ftp.ok, false)
    assert.equal(ftp.ok ? '' : ftp.code, 'probe.invalidBaseUrl')
    const userinfo = planProbe({ baseURL: 'https://user@example.com/v1', api: 'openai-completions', model: 'm' })
    assert.equal(userinfo.ok, false)
    assert.equal(userinfo.ok ? '' : userinfo.code, 'probe.invalidBaseUrl')
    const empty = planProbe({ baseURL: '   ', api: 'openai-completions', model: 'm' })
    assert.equal(empty.ok, false)
    assert.equal(empty.ok ? '' : empty.code, 'probe.baseUrlMissing')
  })

  it('refuses a protocol it cannot speak and an empty model id', () => {
    const api = planProbe({ baseURL: 'https://x.example.com', api: 'google-genai', model: 'm' })
    assert.equal(api.ok, false)
    assert.equal(api.ok ? '' : api.code, 'probe.apiUnsupported')
    const model = planProbe({ baseURL: 'https://x.example.com', api: 'openai-completions', model: '  ' })
    assert.equal(model.ok, false)
    assert.equal(model.ok ? '' : model.code, 'probe.modelRequired')
  })
})
