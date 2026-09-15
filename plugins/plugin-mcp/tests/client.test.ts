/**
 * Client render tests for the coded host messages: a known code renders this
 * page's zh copy (pinned byte-for-byte), an unknown one falls back to the
 * host's English diagnostic, and neither ever renders blank.
 *
 * @module plugin-mcp/tests/client
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { failureOf, failureText, hostListText, hostMessage, PageError } from '../src/client/api.ts'
import { zh } from '../src/client/locales.ts'
import { McpValidationError } from '../src/wire.ts'

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
    assert.equal(hostMessage({ code: 'stdio.commandRequired' }, t), 'stdio 服务器必须填写启动命令（command）')
    assert.equal(hostMessage({ code: 'json.serverNotObject', params: { name: 'foo' } }, t), '服务器「foo」的定义必须是对象')
    assert.equal(
      hostMessage({ code: 'server.fieldKeyValue', params: { name: 'foo', field: 'env' } }, t),
      '服务器「foo」的 env 必须是字符串键值对',
    )
  })

  it('falls back to the host English diagnostic for a code this build does not know', () => {
    assert.equal(hostMessage({ code: 'mount.failed', text: 'ENOENT: npx not found' }, t), 'ENOENT: npx not found')
    assert.equal(hostMessage({ code: 'route.crossOrigin', text: 'cross-origin request' }, t), 'cross-origin request')
  })

  it('never renders blank: the caller\'s generic line, then the code itself', () => {
    assert.equal(hostMessage({ code: 'future.code' }, t, '挂载失败'), '挂载失败')
    assert.equal(hostMessage({ code: 'future.code' }, t), 'future.code')
  })

  it('interpolates every code whose copy has a placeholder, so no raw {param} can reach the screen', () => {
    assert.equal(hostMessage({ code: 'route.writeFailed', params: { detail: 'EACCES' }, text: 'EACCES' }, t), '写入服务器配置失败：EACCES')
    assert.equal(hostMessage({ code: 'route.invalidBody', params: { detail: 'Unexpected token' }, text: 'Unexpected token' }, t), '请求无法解析：Unexpected token')
    assert.equal(hostMessage({ code: 'json.parseFailed', params: { detail: 'Unexpected token' } }, t), 'JSON 解析失败：Unexpected token')
    assert.equal(hostMessage({ code: 'secret.masked', params: { field: 'env.TOKEN' } }, t), 'env.TOKEN 是掩码值：请重新输入真实值，或改用 $ENV:VAR 引用')
  })
})

describe('hostListText', () => {
  it('joins coded warnings with the page separator, which is part of the language', () => {
    assert.equal(
      hostListText([
        { code: 'env.missing', params: { name: 'TOKEN' } },
        { code: 'env.inlineRef', params: { value: 'Bearer $ENV:X' } },
      ], t),
      '环境变量 TOKEN 未设置；仅支持整值 $ENV:VAR 引用，「Bearer $ENV:X」已按字面值处理',
    )
  })
})

describe('host copy table', () => {
  /** Every param name a host code carries, so a copy placeholder can be filled. */
  const SAMPLE_PARAMS: Readonly<Record<string, string | number>> = {
    name: 'x', id: 'x', field: 'x', detail: 'x', type: 'x', value: 'x',
  }

  it('has no placeholder the host cannot fill, so no raw {param} can reach the screen', () => {
    for (const [key, value] of Object.entries(zh)) {
      if (!key.startsWith('mcp.host.')) continue
      const rendered = String(value).replace(
        /\{(\w+)\}/g,
        (_, name: string) => String(SAMPLE_PARAMS[name] ?? `{${name}}`),
      )
      assert.equal(/\{\w+\}/.test(rendered), false, `${key} leaves a placeholder unfilled: ${rendered}`)
    }
  })
})

describe('failureOf', () => {
  it('classifies a coded rejection thrown in this process like one that arrived over the wire', () => {
    const failure = failureOf(new McpValidationError('serverName.invalid', { name: 'has space' }))
    assert.equal(failure.source, 'host')
    assert.equal(
      failureText(failure, t),
      '服务器名「has space」不合法：它会成为工具名（mcp__服务器名__工具名）的命名空间，只能包含 1–32 位字母、数字、下划线、连字符（例如 "figma"）',
    )
  })

  it('keeps this page\'s own keyed failures, and shows anything else as written', () => {
    const keyed = failureOf(new PageError({ source: 'key', key: 'mcp.error.serverNameRequired' }))
    assert.equal(keyed.source, 'key')
    assert.equal(failureText(keyed, t), '请填写服务器名（serverName）')
    assert.equal(failureText(failureOf(new Error('HTTP 500')), t), 'HTTP 500')
  })
})
