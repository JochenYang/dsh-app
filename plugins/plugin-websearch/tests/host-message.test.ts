// Host-message rendering: every code the host can send must come out as a
// finished sentence.
//
// The failure this pins is quiet: the locale runtime returns a template AS IS
// when a placeholder's value is missing, so a table entry that forgets to hand
// `t` its params does not throw — it puts a literal `{detail}` on screen. One
// such entry shipped (route.writeFailed); these tests are the guard.
//
// The code list is harvested from the host sources rather than hand-copied, so
// a new host code fails this suite until the client copy exists (or the
// fallback is documented as intentional).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { providerReasonCopy, routeErrorCopy, statusLabel } from '../src/client/host-message.ts'
import { en, zh } from '../src/client/locales.ts'
import type { HostText } from '../src/wire.ts'

type Dict = Record<string, string>

/** The locale runtime's own interpolation, reproduced. */
const makeT = (dict: Dict) => (key: string, params?: Record<string, unknown>) => {
  const template = dict[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

const hostCodes = (): string[] => {
  const sources = ['src/routes.ts', 'src/wire.ts']
    .map((file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    .join('\n')
  return [...new Set([...sources.matchAll(/code: '([a-z][a-zA-Z.]*)'/g)].map((match) => match[1]))].sort()
}

/** Every code the client's tables know; a code outside these renders `text`. */
const tableCodes = (): string[] => [
  'provider.noSeam', 'provider.disabled', 'provider.noEngines',
  'provider.upstreamUnknown', 'provider.upstreamUnregistered', 'provider.upstreamUnusable',
  ...hostCodes(),
]

const PLACEHOLDER = /\{[a-z]+\}/u

describe('host message rendering', () => {
  for (const [name, dict] of [['zh', zh], ['en', en]] as const) {
    it(`renders every known code without a leftover placeholder (${name})`, () => {
      const t = makeT(dict)
      const leftovers: string[] = []
      for (const code of tableCodes()) {
        // The thinnest possible host message: code only, no params, no text.
        const value: HostText = { code }
        const rendered = [
          routeErrorCopy(t, value, ''),
          providerReasonCopy(t, value),
        ].filter((line) => line !== '')
        for (const line of rendered) {
          if (PLACEHOLDER.test(line)) leftovers.push(`${code} → ${line}`)
        }
      }
      assert.deepEqual(leftovers, [], `unfilled placeholders:\n${leftovers.join('\n')}`)
    })
  }

  it('substitutes the host diagnostic the sentences ask for', () => {
    const t = makeT(zh)
    assert.equal(
      routeErrorCopy(t, { code: 'route.writeFailed', text: 'EACCES' }, 'x'),
      '写入配置失败：EACCES',
    )
    assert.equal(
      routeErrorCopy(t, { code: 'route.invalidBody', text: 'Unexpected token <' }, 'x'),
      '请求无法解析：Unexpected token <',
    )
    // A `{detail}` sentence handed no detail renders empty rather than literal.
    assert.doesNotMatch(routeErrorCopy(t, { code: 'route.writeFailed' }, 'x'), PLACEHOLDER)
  })

  it('substitutes the params the sentences carry', () => {
    const t = makeT(zh)
    assert.equal(
      routeErrorCopy(t, { code: 'engine.unknownId', params: { id: 'google' } }, 'x'),
      '不认识的引擎 id：「google」',
    )
    assert.equal(
      routeErrorCopy(t, { code: 'engine.keyMasked', params: { id: 'exa' } }, 'x'),
      '引擎「exa」的密钥是掩码值：请重新输入真实值，或改用 $ENV:变量名 引用',
    )
    assert.match(
      routeErrorCopy(t, { code: 'searxng.notHttp', params: { url: 'searx.example.com' } }, 'x'),
      /searx\.example\.com/u,
    )
  })

  it('falls back to the host diagnostic for a code this build does not know', () => {
    const t = makeT(zh)
    // A newer kernel's code: the English diagnostic beats a blank banner, and
    // beats mentioning a code the user cannot act on.
    assert.equal(
      routeErrorCopy(t, { code: 'engine.someFutureCode', text: 'quota exhausted' }, 'generic'),
      'quota exhausted',
    )
    assert.equal(routeErrorCopy(t, undefined, 'generic'), 'generic')
    assert.equal(providerReasonCopy(t, undefined), '')
  })

  it('renders the per-engine blocked reasons from their codes', () => {
    const t = makeT(zh)
    assert.equal(statusLabel({ state: 'blocked', message: { code: 'engine.missingKey' } }, t).text, zh['ws.status.missingKey'])
    assert.equal(statusLabel({ state: 'blocked', message: { code: 'engine.missingInstance' } }, t).text, zh['ws.status.missingInstance'])
    // A blocked engine whose code this build does not know still says something.
    assert.equal(statusLabel({ state: 'blocked', message: { code: 'engine.future', text: 'no key' } }, t).text, 'no key')
    assert.equal(statusLabel({ state: 'blocked' }, t).text, zh['ws.status.blocked'])
    assert.equal(statusLabel({ state: 'ready' }, t).tone, 'ok')
  })
})
