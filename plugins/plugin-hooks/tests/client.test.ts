/**
 * Client render tests for the coded host messages: a known code renders this
 * page's zh copy (pinned byte-for-byte), an unknown one falls back to the
 * host's English diagnostic, and neither ever renders blank.
 *
 * @module plugin-hooks/tests/client
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { zh } from '../src/client/locales.ts'
import { HostError, hostMessage, noticeText, wireNotice } from '../src/client/messages.ts'

/**
 * The page's `t` seat, reduced to the zh dictionary with `{name}`
 * interpolation — the same contract the locale runtime implements.
 * @param dict - the dictionary to read.
 * @returns the stand-in translate function.
 */
function seat(dict: Readonly<Record<string, string>>): Parameters<typeof hostMessage>[1] {
  return ((key: string, params?: Record<string, unknown>) =>
    String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? `{${name}}`))
  ) as unknown as Parameters<typeof hostMessage>[1]
}

const t = seat(zh)

describe('hostMessage', () => {
  it('renders a known code from the zh dictionary, byte-identical to the pre-i18n sentence', () => {
    assert.equal(hostMessage({ code: 'dialect.invalid' }, t), 'dialect 必须是 native、claude-code 或 codex')
    assert.equal(hostMessage({ code: 'configPath.notAbsolute', params: { path: 'x/hooks.json' } }, t), 'configPath 必须是绝对路径：「x/hooks.json」')
    assert.equal(
      hostMessage({ code: 'native.onInvalid', params: { label: 'rules[0]', name: 'block-writes' } }, t),
      'rules[0]（block-writes）的 on 必须是 pre-tool-use / post-tool-use / prompt-submit / session-start',
    )
    assert.equal(
      hostMessage({ code: 'native.matcherTooLong', params: { length: 501, max: 500, name: 'wide' } }, t),
      'matcher 过长（501/500 字符）：wide',
    )
  })

  it('falls back to the host English diagnostic for a code this build does not know', () => {
    assert.equal(hostMessage({ code: 'mount.failed', text: 'ENOENT: D:/x/hooks.json' }, t), 'ENOENT: D:/x/hooks.json')
    assert.equal(hostMessage({ code: 'hooks.futureGate', text: 'bridge rejected by a newer kernel' }, t), 'bridge rejected by a newer kernel')
  })

  it('never renders blank: the caller\'s generic line, then the code itself', () => {
    assert.equal(hostMessage({ code: 'future.code' }, t, '挂载失败'), '挂载失败')
    assert.equal(hostMessage({ code: 'future.code' }, t), 'future.code')
  })
})

describe('noticeText', () => {
  it('renders every kind of notice through the active locale', () => {
    assert.equal(noticeText({ source: 'key', key: 'hooks.error.contentRequired' }, t), '配置内容不能为空')
    assert.equal(
      noticeText({ source: 'host', host: { code: 'bridge.notFound', params: { id: 'hook-2' } }, fallback: 'HTTP 400' }, t),
      'Hook 配置 hook-2 不存在',
    )
    assert.equal(
      noticeText({ source: 'host', host: { code: 'route.invalidBody', params: { detail: 'Unexpected token' }, text: 'Unexpected token' }, fallback: 'HTTP 400' }, t),
      '请求无法解析：Unexpected token',
    )
    assert.equal(noticeText({ source: 'text', text: 'HTTP 500' }, t), 'HTTP 500')
  })
})

describe('host copy table', () => {
  /** Every param name a host code carries, so a copy placeholder can be filled. */
  const SAMPLE_PARAMS: Readonly<Record<string, string | number>> = {
    id: 'x', field: 'x', detail: 'x', path: 'x', label: 'x', name: 'x',
    on: 'x', action: 'x', matcher: 'x', length: 1, max: 2,
  }

  it('has no placeholder the host cannot fill, so no raw {param} can reach the screen', () => {
    for (const [key, value] of Object.entries(zh)) {
      if (!key.startsWith('hooks.host.')) continue
      const rendered = String(value).replace(
        /\{(\w+)\}/g,
        (_, name: string) => String(SAMPLE_PARAMS[name] ?? `{${name}}`),
      )
      assert.equal(/\{\w+\}/.test(rendered), false, `${key} leaves a placeholder unfilled: ${rendered}`)
    }
  })
})

describe('wireNotice', () => {
  it('keeps a coded host answer, and shows anything else as written', () => {
    const coded = wireNotice(new HostError({ code: 'dialect.invalid' }, 'hooks config rejected: dialect.invalid'))
    assert.equal(coded.source, 'host')
    assert.equal(noticeText(coded, t), 'dialect 必须是 native、claude-code 或 codex')
    // A transport failure carrying no code stays verbatim, and a coded answer
    // from a newer kernel falls back to the host's English diagnostic.
    assert.equal(noticeText(wireNotice(new Error('HTTP 500')), t), 'HTTP 500')
    assert.equal(noticeText(wireNotice(new HostError(undefined, 'HTTP 500')), t), 'HTTP 500')
    const unknown = wireNotice(new HostError({ code: 'future.code', text: 'HTTP 403' }, 'HTTP 403'))
    assert.equal(noticeText(unknown, t), 'HTTP 403')
  })
})
